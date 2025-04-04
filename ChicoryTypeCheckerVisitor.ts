import { CharStream, CommonTokenStream, ParserRuleContext } from "antlr4ng";
import { ChicoryLexer } from "./generated/ChicoryLexer";
import { ChicoryParser } from "./generated/ChicoryParser";
import * as path from "path";
import * as parser from "./generated/ChicoryParser";
import {
  ConstructorDefinition,
  StringType,
  NumberType,
  BooleanType,
  UnitType,
  FunctionType,
  RecordType,
  TupleType,
  AdtType,
  UnknownType,
  typesAreEqual,
  GenericType,
  TypeVariable,
  ArrayType,
} from "./ChicoryTypes";
import { TypeEnvironment } from "./TypeEnvironment";
import {
  CompilationError,
  SubstitutionMap,
  TypeHintWithContext,
  ChicoryType,
  CompilationCache,
  ProcessingFiles,
  CompilationCacheEntry,
} from "./env";
import { Prelude } from "./Prelude";

// Represents the state of coverage for the match expression
interface MatchCoverage {
  type: "adt" | "string" | "number" | "boolean" | "other";
  // For ADT
  adtName?: string;
  remainingVariants?: Set<string>; // Variants not yet fully covered by param/wildcard
  partiallyCoveredVariants?: Set<string>; // Variants hit by literal matches
  // For string/number/boolean/other
  wildcardOrParamSeen?: boolean;
  // For boolean specifically
  trueCovered?: boolean;
  falseCovered?: boolean;
  // For tracking simple duplicates/unreachability
  processedPatterns?: Set<string>; // Stores string representations of patterns already seen
}

// Information extracted from a pattern context
interface PatternInfo {
  type:
    | "adt_param"
    | "adt_wildcard"
    | "adt_literal"
    | "adt_bare"
    | "literal"
    | "wildcard"
    | "variable" // Added for patterns like 'x => ...'
    | "unknown";
  variantName?: string; // For ADT patterns (e.g., "Some", "None")
  literalValue?: string | number | boolean; // For literal patterns
  patternString: string; // Unique string representation for reachability checks
}

export class ChicoryTypeChecker {
  private environment: TypeEnvironment;
  private errors: CompilationError[] = [];
  private hints: TypeHintWithContext[] = [];
  private constructors: ConstructorDefinition[] = [];
  private nextTypeVarId: number = 0;
  private currentSubstitution: SubstitutionMap = new Map();
  private expressionTypes: Map<ParserRuleContext, ChicoryType> = new Map();
  private prelude: Prelude;
  private currentFilePath: string = "";
  private readFile: (filePath: string) => string;
  private compilationCache: CompilationCache = new Map();
  private processingFiles: ProcessingFiles = new Set();
  private exportedBindings: Map<string, ChicoryType> = new Map();

  constructor() {
    this.environment = new TypeEnvironment(null); // Initialize with the global scope
    this.prelude = new Prelude(); // Initialize prelude tracker
    this.initializePrelude();
  }

  private setExpressionType(ctx: ParserRuleContext, type: ChicoryType): void {
    this.expressionTypes.set(ctx, type);
    if (type instanceof GenericType && type.name === "Option") {
      this.prelude.requireOptionType();
    } else if (type instanceof GenericType && type.name === "Result") {
      this.prelude.requireResultType();
    }
  }

  private initializePrelude(): void {
    // TODO: Consider clearing any existing prelude stuff if check is re-run
    const optionTypeName = "Option";
    const typeVarT = new TypeVariable("T"); // Assuming TypeVariable exists or use a placeholder name
    const optionGenericType = new GenericType(optionTypeName, [typeVarT]);

    // Define Some(T) -> Option<T>
    const someName = "Some";
    // The return type MUST be the generic Option<T> for instantiation/unification
    const someType = new FunctionType([typeVarT], optionGenericType, someName);
    const someConstructorDef: ConstructorDefinition = {
      adtName: optionTypeName,
      name: someName,
      type: someType,
    };

    // Define None -> Option<T>
    const noneName = "None";
    // The return type MUST be the generic Option<T>
    const noneType = new FunctionType([], optionGenericType, noneName);
    const noneConstructorDef: ConstructorDefinition = {
      adtName: optionTypeName,
      name: noneName,
      type: noneType,
    };

    // Add Option type itself
    this.environment.declare(optionTypeName, optionGenericType, null, (err) =>
      console.error("Prelude Error:", err)
    );
    // Add Constructors as functions in the environment
    this.environment.declare(someName, someType, null, (err) =>
      console.error("Prelude Error:", err)
    );
    this.environment.declare(noneName, noneType, null, (err) =>
      console.error("Prelude Error:", err)
    );

    // Add constructor definitions for the type checker's ADT logic
    this.constructors.push(someConstructorDef, noneConstructorDef);

    // --- Result<T, E> = Ok(T) | Err(E) ---
    const resultTypeName = "Result";
    // Create distinct TypeVariable instances for T and E within Result's definition context
    const typeVarResT = new TypeVariable("T");
    const typeVarResE = new TypeVariable("E");
    const resultGenericType = new GenericType(resultTypeName, [
      typeVarResT,
      typeVarResE,
    ]);

    // Define Ok(T) -> Result<T, E>
    const okName = "Ok";
    // The return type MUST be the generic Result<T, E> for instantiation/unification
    const okType = new FunctionType([typeVarResT], resultGenericType, okName);
    const okConstructorDef: ConstructorDefinition = {
      adtName: resultTypeName,
      name: okName,
      type: okType,
    };

    // Define Err(E) -> Result<T, E>
    const errName = "Err";
    // The return type MUST be the generic Result<T, E>
    const errType = new FunctionType([typeVarResE], resultGenericType, errName);
    const errConstructorDef: ConstructorDefinition = {
      adtName: resultTypeName,
      name: errName,
      type: errType,
    };

    // Add Result type itself to the environment
    this.environment.declare(resultTypeName, resultGenericType, null, (err) =>
      console.error("Prelude Error (Result Type):", err)
    );
    // Add Constructors as functions in the environment
    this.environment.declare(okName, okType, null, (err) =>
      console.error("Prelude Error (Ok Constructor):", err)
    );
    this.environment.declare(errName, errType, null, (err) =>
      console.error("Prelude Error (Err Constructor):", err)
    );

    // Add constructor definitions for the type checker's ADT logic
    this.constructors.push(okConstructorDef, errConstructorDef);
  }

  private newTypeVar(): TypeVariable {
    return new TypeVariable(`T${this.nextTypeVarId++}`);
  }

  unify(
    type1: ChicoryType,
    type2: ChicoryType,
    substitution: SubstitutionMap
  ): ChicoryType | Error {
    console.log(`[unify] ENTER`);
    console.log(`  type1: ${type1.toString()} (${type1.constructor.name})`);
    console.log(`  type2: ${type2.toString()} (${type2.constructor.name})`);
    console.log(`  substitution (in):`, new Map(substitution)); // Log a copy

    type1 = this.applySubstitution(type1, substitution);
    type2 = this.applySubstitution(type2, substitution);
    console.log(
      `  type1 (subst): ${type1.toString()} (${type1.constructor.name})`
    );
    console.log(
      `  type2 (subst): ${type2.toString()} (${type2.constructor.name})`
    );

    if (typesAreEqual(type1, type2)) {
      console.log(`[unify] SUCCESS: Types are equal.`);
      console.log(`[unify] EXIT`);
      return type1;
      return type1;
    }

    // Handle UnknownType: It can unify with any type, becoming that type.
    if (type1 === UnknownType) {
      console.log(`[unify] BRANCH: type1 is UnknownType.`);
      console.log(`[unify] SUCCESS: Unified with UnknownType.`);
      console.log(`[unify] EXIT`);
      // If type2 is also Unknown, returning either is fine.
      // If type2 is known, the result of unification is the known type.
      return type2;
    }
    if (type2 === UnknownType) {
      console.log(`[unify] BRANCH: type2 is UnknownType.`);
      console.log(`[unify] SUCCESS: Unified with UnknownType.`);
      console.log(`[unify] EXIT`);
      // type1 cannot be Unknown here due to the previous check.
      return type1; // Unification succeeds, result is the known type
    }

    if (type1 instanceof GenericType && type2 instanceof GenericType) {
      console.log(`[unify] BRANCH: GenericType vs GenericType`);
      // 1. Check if the base names are the same
      if (type1.name !== type2.name) {
        const error = new Error(
          `Cannot unify generic types with different names: ${type1.name} and ${type2.name}`
        );
        console.error(`[unify] ERROR: ${error.message}`);
        console.log(`[unify] EXIT (error)`);
        return error;
      }
      // 2. Check if they have the same number of type arguments
      if (type1.typeArguments.length !== type2.typeArguments.length) {
        const error = new Error(
          `Cannot unify generic type ${type1.name} with different number of arguments: ${type1.typeArguments.length} vs ${type2.typeArguments.length}`
        );
        console.error(`[unify] ERROR: ${error.message}`);
        console.log(`[unify] EXIT (error)`);
        return error;
      }
      // 3. Recursively unify the type arguments
      console.log(`  > Recursively unifying arguments for ${type1.name}`);
      for (let i = 0; i < type1.typeArguments.length; i++) {
        const result = this.unify(
          type1.typeArguments[i],
          type2.typeArguments[i],
          substitution
        );
        if (result instanceof Error) {
          // Append context to the error message?
          const error = new Error(
            `Cannot unify type arguments of ${type1.name}: ${result.message}`
          );
          console.error(`[unify] ERROR: ${error.message}`);
          console.log(`[unify] EXIT (error)`);
          return error;
        }
      }
      // If all arguments unify, the unification succeeds.
      // Return one of them (after applying potential new substitutions from unifying args)
      const unifiedType = this.applySubstitution(type1, substitution);
      console.log(`[unify] SUCCESS: Unified GenericType ${unifiedType}`);
      console.log(`[unify] EXIT`);
      return unifiedType;
    }

    if (type1 instanceof GenericType && type1.typeArguments.length === 0) {
      console.log(
        `[unify] BRANCH: GenericType (no args) '${type1.name}' vs ${type2.constructor.name}`
      );
      // A generic type with no arguments can be unified with any type
      // This is similar to a type variable
      const occurs = this.occursIn(new TypeVariable(type1.name), type2);
      console.log(
        `  > Occurs check for '${
          type1.name
        }' in '${type2.toString()}': ${occurs}`
      );
      if (occurs) {
        const error = new Error(
          `Cannot unify ${type1} with ${type2} (fails occurs check)`
        );
        console.error(`[unify] ERROR: ${error.message}`);
        console.log(`[unify] EXIT (error)`);
        return error;
      }
      console.log(
        `  > Setting substitution: '${type1.name}' -> '${type2.toString()}'`
      );
      substitution.set(type1.name, type2);
      console.log(`  substitution (out):`, new Map(substitution));
      console.log(`[unify] SUCCESS: Bound GenericType (no args).`);
      console.log(`[unify] EXIT`);
      return type2;
    }

    // Also handle the reverse case
    if (type2 instanceof GenericType && type2.typeArguments.length === 0) {
      console.log(
        `[unify] BRANCH: Swapping GenericType (no args) '${type2.name}' and recursing.`
      );
      console.log(`[unify] EXIT (recursive swap)`);
      return this.unify(type2, type1, substitution);
    }

    if (type1 instanceof AdtType && type2 instanceof AdtType) {
      console.log(`[unify] BRANCH: AdtType vs AdtType`);
      if (type1.name === type2.name) {
        console.log(`[unify] SUCCESS: ADT names match.`);
        console.log(`[unify] EXIT`);
        return type1;
      }
      const error = new Error(
        `Cannot unify ADT types with different names: ${type1.name} and ${type2.name}`
      );
      console.error(`[unify] ERROR: ${error.message}`);
      console.log(`[unify] EXIT (error)`);
      return error;
    }

    if (type1 instanceof TypeVariable) {
      console.log(`[unify] BRANCH: type1 is TypeVariable ('${type1.name}')`);
      if (substitution.has(type1.name)) {
        console.log(
          `  > Recursing due to existing substitution for '${type1.name}'`
        );
        console.log(`[unify] EXIT (recursive)`);
        return this.unify(substitution.get(type1.name)!, type2, substitution);
      }
      if (type2 instanceof TypeVariable && type1.name === type2.name) {
        console.log(`[unify] SUCCESS: Same TypeVariable.`);
        console.log(`[unify] EXIT`);
        return type1; // Already equal
      }
      const occurs = this.occursIn(type1, type2);
      console.log(
        `  > Occurs check for '${
          type1.name
        }' in '${type2.toString()}': ${occurs}`
      );
      if (occurs) {
        const error = new Error(
          `Cannot unify ${type1} with ${type2} (fails occurs check)`
        );
        console.error(`[unify] ERROR: ${error.message}`);
        console.log(`[unify] EXIT (error)`);
        return error;
      }
      console.log(
        `  > Setting substitution: '${type1.name}' -> '${type2.toString()}'`
      );
      substitution.set(type1.name, type2);
      console.log(`  substitution (out):`, new Map(substitution)); // Log updated map
      console.log(`[unify] SUCCESS: Bound TypeVariable.`);
      console.log(`[unify] EXIT`);
      return type2; // Return the unified type
    }

    if (type2 instanceof TypeVariable) {
      console.log(
        `[unify] BRANCH: type2 is TypeVariable ('${type2.name}'), swapping and recursing.`
      );
      console.log(`[unify] EXIT (recursive swap)`);
      // Ensure the swap doesn't cause infinite recursion if occursIn fails later
      return this.unify(type2, type1, substitution);
    }

    if (type1 instanceof ArrayType && type2 instanceof ArrayType) {
      console.log(`[unify] BRANCH: ArrayType vs ArrayType`);
      // Unify element types
      console.log(`  > Recursively unifying element types`);
      const elementResult = this.unify(
        type1.elementType,
        type2.elementType,
        substitution
      );
      if (elementResult instanceof Error) {
        const error = new Error(
          `Cannot unify array types: ${elementResult.message}`
        );
        console.error(`[unify] ERROR: ${error.message}`);
        console.log(`[unify] EXIT (error)`);
        return error;
      }
      // Return an array type with the potentially updated element type
      // applySubstitution is crucial here as elementResult might just be a TypeVar that got bound
      const unifiedType = new ArrayType(
        this.applySubstitution(elementResult, substitution)
      );
      console.log(`[unify] SUCCESS: Unified ArrayType ${unifiedType}`);
      console.log(`[unify] EXIT`);
      return unifiedType;
    }

    if (type1 instanceof FunctionType && type2 instanceof FunctionType) {
      console.log(`[unify] BRANCH: FunctionType vs FunctionType`);
      if (type1.paramTypes.length !== type2.paramTypes.length) {
        const error = new Error(
          "Cannot unify function types with different number of parameters"
        );
        console.error(`[unify] ERROR: ${error.message}`);
        console.log(`[unify] EXIT (error)`);
        return error;
      }
      console.log(`  > Recursively unifying parameter types`);
      for (let i = 0; i < type1.paramTypes.length; i++) {
        const result = this.unify(
          type1.paramTypes[i],
          type2.paramTypes[i],
          substitution
        );
        if (result instanceof Error) {
          console.error(
            `[unify] ERROR: Failed unifying function param ${i}: ${result.message}`
          );
          console.log(`[unify] EXIT (error)`);
          return result;
        }
      }
      console.log(`  > Recursively unifying return types`);
      const returnResult = this.unify(
        type1.returnType,
        type2.returnType,
        substitution
      );
      if (returnResult instanceof Error) {
        console.error(
          `[unify] ERROR: Failed unifying function return type: ${returnResult.message}`
        );
        console.log(`[unify] EXIT (error)`);
        return returnResult;
      }
      const unifiedType = this.applySubstitution(type1, substitution); // Re-apply subs to get final func type
      console.log(`[unify] SUCCESS: Unified FunctionType ${unifiedType}`);
      console.log(`[unify] EXIT`);
      return unifiedType;
    }

    if (type1 instanceof TupleType && type2 instanceof TupleType) {
      console.log(`[unify] BRANCH: TupleType vs TupleType`);
      if (type1.elementTypes.length !== type2.elementTypes.length) {
        const error = new Error("Cannot unify tuples with different lengths");
        console.error(`[unify] ERROR: ${error.message}`);
        console.log(`[unify] EXIT (error)`);
        return error;
      }

      console.log(`  > Recursively unifying element types`);
      for (let i = 0; i < type1.elementTypes.length; i++) {
        const result = this.unify(
          type1.elementTypes[i],
          type2.elementTypes[i],
          substitution
        );
        if (result instanceof Error) {
          console.error(
            `[unify] ERROR: Failed unifying tuple element ${i}: ${result.message}`
          );
          console.log(`[unify] EXIT (error)`);
          return result;
        }
      }
      const unifiedType = this.applySubstitution(type1, substitution); // Re-apply subs
      console.log(`[unify] SUCCESS: Unified TupleType ${unifiedType}`);
      console.log(`[unify] EXIT`);
      return unifiedType;
    }

    // Add other type-specific unification rules (RecordType etc.) as needed
    const finalError = new Error(`Cannot unify ${type1} with ${type2}`);
    console.error(`[unify] ERROR: Fallthrough - ${finalError.message}`);
    console.log(`[unify] EXIT (error)`);
    return finalError;
  }

  applySubstitution(
    type: ChicoryType,
    substitution: SubstitutionMap
  ): ChicoryType {
    // console.log(`[applySubstitution] ENTER`);
    // console.log(`  type: ${type.toString()} (${type.constructor.name})`);
    // console.log(`  substitution:`, new Map(substitution));

    if (type instanceof TypeVariable) {
      // console.log(`  > Type is TypeVariable ('${type.name}')`);
      if (substitution.has(type.name)) {
        // console.log(`  > Found substitution for '${type.name}', recursing.`);
        const substituted = this.applySubstitution(
          substitution.get(type.name)!,
          substitution
        );
        // console.log(`[applySubstitution] EXIT (substituted TypeVariable '${type.name}' -> '${substituted.toString()}')`);
        return substituted;
      }
      // console.log(`  > No substitution found for '${type.name}'.`);
      // console.log(`[applySubstitution] EXIT (no change)`);
      return type;
    }

    // Add ArrayType substitution
    if (type instanceof ArrayType) {
      // console.log(`  > Type is ArrayType`);
      const substitutedElementType = this.applySubstitution(
        type.elementType,
        substitution
      );
      if (substitutedElementType === type.elementType) {
        // console.log(`[applySubstitution] EXIT (no change to element)`);
        return type; // Optimization: return original if element didn't change
      }
      const result = new ArrayType(substitutedElementType);
      // console.log(`[applySubstitution] EXIT (new ArrayType: ${result.toString()})`);
      return result;
    }

    // Add case for GenericType
    if (type instanceof GenericType) {
      // console.log(`  > Type is GenericType ('${type.name}')`);
      if (type.typeArguments.length === 0 && substitution.has(type.name)) {
        // console.log(`  > Found substitution for generic name '${type.name}', recursing.`);
        const substituted = this.applySubstitution(
          substitution.get(type.name)!,
          substitution
        );
        // console.log(`[applySubstitution] EXIT (substituted GenericType name '${type.name}' -> '${substituted.toString()}')`);
        return substituted;
      }
      // console.log(`  > Applying substitution to type arguments.`);
      let changed = false;
      const newArgs = type.typeArguments.map((t) => {
        const newT = this.applySubstitution(t, substitution);
        if (newT !== t) changed = true;
        return newT;
      });
      if (!changed) {
        // console.log(`[applySubstitution] EXIT (no change to arguments)`);
        return type; // Optimization
      }
      const result = new GenericType(type.name, newArgs);
      // console.log(`[applySubstitution] EXIT (new GenericType: ${result.toString()})`);
      return result;
    }

    if (type instanceof FunctionType) {
      // console.log(`  > Type is FunctionType`);
      let paramsChanged = false;
      const newParamTypes = type.paramTypes.map((p) => {
        const newP = this.applySubstitution(p, substitution);
        if (newP !== p) paramsChanged = true;
        return newP;
      });
      const newReturnType = this.applySubstitution(
        type.returnType,
        substitution
      );
      const returnChanged = newReturnType !== type.returnType;

      if (!paramsChanged && !returnChanged) {
        // console.log(`[applySubstitution] EXIT (no change to params or return)`);
        return type; // Optimization
      }
      const result = new FunctionType(
        newParamTypes,
        newReturnType,
        type.constructorName
      );
      // console.log(`[applySubstitution] EXIT (new FunctionType: ${result.toString()})`);
      return result;
    }

    if (type instanceof TupleType) {
      // console.log(`  > Type is TupleType`);
      let changed = false;
      const newElementTypes = type.elementTypes.map((e) => {
        const newE = this.applySubstitution(e, substitution);
        if (newE !== e) changed = true;
        return newE;
      });
      if (!changed) {
        // console.log(`[applySubstitution] EXIT (no change to elements)`);
        return type; // Optimization
      }
      const result = new TupleType(newElementTypes);
      // console.log(`[applySubstitution] EXIT (new TupleType: ${result.toString()})`);
      return result;
    }

    // console.log(`  > Type is primitive or other non-substitutable type.`);
    // console.log(`[applySubstitution] EXIT (no change)`);
    return type;
  }

  occursIn(typeVar: TypeVariable, type: ChicoryType): boolean {
    // Basic occurs check logging can be added here if needed
    if (type instanceof TypeVariable) {
      return typeVar.name === type.name;
    }

    // Add ArrayType check
    if (type instanceof ArrayType) {
      return this.occursIn(typeVar, type.elementType);
    }

    // Add case for GenericType
    if (type instanceof GenericType) {
      if (type.name === typeVar.name) {
        return true;
      }
      return type.typeArguments.some((t) => this.occursIn(typeVar, t));
    }

    if (type instanceof FunctionType) {
      return (
        type.paramTypes.some((p) => this.occursIn(typeVar, p)) ||
        this.occursIn(typeVar, type.returnType)
      );
    }

    if (type instanceof TupleType) {
      return type.elementTypes.some((e) => this.occursIn(typeVar, e));
    }

    if (type instanceof RecordType) {
      return Array.from(type.fields.values()).some((f) =>
        this.occursIn(typeVar, f)
      );
    }

    if (type instanceof AdtType) {
      // An ADT doesn't contain type variables itself (in our simplified representation)
      // Type vars might appear within the types of its *constructors*, but we handle that
      // when unifying function types (constructor types). So an ADT doesn't "contain"
      // the type var in the sense of the `occursIn` check.
      return false;
    }

    // Primitives and UnknownType don't contain type vars
    return false;
  }

  // Helper function to instantiate a function type with fresh type variables
  private instantiateFunctionType(funcType: FunctionType): FunctionType {
    console.log(`[instantiateFunctionType] ENTER`);
    console.log(`  funcType: ${funcType.toString()}`);

    // Find all unique type variables within the function type signature
    const typeVars = new Set<string>();
    const findVars = (type: ChicoryType) => {
      // console.log(`  [findVars] Checking type: ${type.toString()}`);
      if (type instanceof TypeVariable) {
        // Only consider variables not bound in the immediate environment
        // For simplicity, we assume top-level constructor/function types need full instantiation.
        // A more complex implementation might check environment depth.
        typeVars.add(type.name);
      } else if (type instanceof FunctionType) {
        type.paramTypes.forEach(findVars);
        findVars(type.returnType);
      } else if (type instanceof ArrayType) {
        findVars(type.elementType);
      } else if (type instanceof TupleType) {
        type.elementTypes.forEach(findVars);
      } else if (type instanceof RecordType) {
        Array.from(type.fields.values()).forEach(findVars);
      } else if (type instanceof GenericType) {
        type.typeArguments.forEach(findVars);
      }
    };
    // Find variables in parameters and return type
    funcType.paramTypes.forEach(findVars);
    findVars(funcType.returnType);

    // Create a substitution map from old var names to fresh vars
    const substitution: SubstitutionMap = new Map();
    typeVars.forEach((varName) => {
      const freshVar = this.newTypeVar();
      console.log(
        `  > Mapping type var '${varName}' to fresh var '${freshVar.name}'`
      );
      substitution.set(varName, freshVar);
    });

    // If no variables were found, return the original type
    if (substitution.size === 0) {
      console.log(
        `[instantiateFunctionType] No type variables found to instantiate.`
      );
      console.log(`[instantiateFunctionType] EXIT (original)`);
      return funcType;
    }

    console.log(
      `  > Applying substitution to instantiate:`,
      new Map(substitution)
    );
    // Apply the substitution to create the new, instantiated function type
    // We need to ensure applySubstitution correctly handles FunctionType (which it should)
    const instantiatedType = this.applySubstitution(
      funcType,
      substitution
    ) as FunctionType;
    console.log(`  > Instantiated type: ${instantiatedType.toString()}`);
    console.log(`[instantiateFunctionType] EXIT (instantiated)`);
    return instantiatedType;
  }

  // Helper method to report errors
  private reportError(message: string, context: ParserRuleContext): void {
    this.errors.push({ message, context });
  }

  getConstructors(): ConstructorDefinition[] {
    return this.constructors;
  }

  // Main entry point for type checking
  check(
    ctx: parser.ProgramContext,
    filePath: string, // Absolute path of the file to check
    readFile: (filePath: string) => string, // Function to read file content
    compilationCache: CompilationCache, // Shared cache
    processingFiles: ProcessingFiles // Shared set for cycle detection
  ): {
    errors: CompilationError[];
    hints: TypeHintWithContext[];
    expressionTypes: Map<ParserRuleContext, ChicoryType>;
    prelude: Prelude;
    exports: Map<string, ChicoryType>;
  } {
    // --- Setup ---
    this.currentFilePath = filePath;
    this.readFile = readFile;
    this.compilationCache = compilationCache;
    this.processingFiles = processingFiles;

    // Reset for this check
    this.environment = new TypeEnvironment(null);
    this.prelude = new Prelude();
    this.initializePrelude();
    this.errors = [];
    this.hints = [];
    this.constructors = this.constructors.filter(
      (c) => c.adtName === "Option" || c.adtName === "Result"
    ); // Keep built-ins
    this.currentSubstitution = new Map();
    this.nextTypeVarId = 0;
    this.expressionTypes.clear();
    this.exportedBindings = new Map();

    // --- Cycle Detection ---
    if (this.processingFiles.has(this.currentFilePath)) {
      // This is a simplified check. A more robust one might allow the file
      // to be revisited if its exports are already computed.
      this.reportError(
        `Circular dependency detected: File ${this.currentFilePath} is already being processed.`,
        ctx
      );
      // Return minimal info to break the cycle
      return {
        errors: this.errors,
        hints: [],
        expressionTypes: new Map(),
        prelude: this.prelude,
        exports: new Map(),
      };
    }
    this.processingFiles.add(this.currentFilePath);

    // --- Main Analysis ---
    try {
      // Type check the current file based on the known context
      this.visitProgram(ctx);
    } catch (e) {
      // Catch unexpected errors during analysis
      this.reportError(
        `Internal error during analysis of ${this.currentFilePath}: ${
          e instanceof Error ? e.message : String(e)
        }`,
        ctx
      );
    }

    // --- Teardown ---
    this.processingFiles.delete(this.currentFilePath);

    // --- Result ---
    const result = {
      errors: this.errors,
      hints: this.hints,
      expressionTypes: this.expressionTypes,
      prelude: this.prelude,
      exports: this.exportedBindings,
    };

    // Store result in cache *before* returning
    this.compilationCache.set(this.currentFilePath, {
      exports: result.exports,
      errors: result.errors,
      // Potentially cache hints/prelude if needed across files, but exports/errors are primary
    });

    return result;
  }

  visitProgram(ctx: parser.ProgramContext): ChicoryType {
    // We don't need to store any types here, we just need to process the
    // tree to perform unifications etc. and make sure that we know what
    // we're exporting
    ctx.stmt().forEach((stmt) => this.visitStmt(stmt));
    if (ctx.exportStmt()) {
      this.visitExportStmt(ctx.exportStmt()!);
    }
    return UnitType;
  }

  visitStmt(ctx: parser.StmtContext): ChicoryType {
    if (ctx.assignStmt()) {
      return this.visitAssignStmt(ctx.assignStmt()!);
    } else if (ctx.typeDefinition()) {
      return this.visitTypeDefinition(ctx.typeDefinition()!);
    } else if (ctx.importStmt()) {
      return this.visitImportStmt(ctx.importStmt()!);
    } else if (ctx.expr()) {
      return this.visitExpr(ctx.expr()!);
    }
    this.reportError(`Unknown statement type: ${ctx.getText()}`, ctx);
    return UnknownType;
  }

  visitAssignStmt(ctx: parser.AssignStmtContext): ChicoryType {
    const targetCtx = ctx.assignTarget();
    const expressionCtx = ctx.expr();
    const annotationCtx = ctx.typeExpr();

    let expressionType = this.visitExpr(expressionCtx);
    expressionType = this.applySubstitution(
      expressionType,
      this.currentSubstitution
    ); // Apply subs before unification

    let annotatedType: ChicoryType | null = null;
    let rhsFinalType: ChicoryType = expressionType; // The type of the RHS after potential annotation unification

    if (annotationCtx) {
      annotatedType = this.visitTypeExpr(annotationCtx);
      annotatedType = this.applySubstitution(
        annotatedType,
        this.currentSubstitution
      ); // Apply subs to annotation too

      // Unify the annotated type with the inferred expression type
      const unificationResult = this.unify(
        annotatedType,
        expressionType,
        this.currentSubstitution
      );

      if (unificationResult instanceof Error) {
        this.reportError(
          `Type mismatch: Cannot assign expression of type '${expressionType}' to target annotated with type '${annotatedType}'. ${unificationResult.message}`,
          ctx
        );
        // Use annotated type to proceed, respecting user intent partially
        rhsFinalType = annotatedType;
      } else {
        // Unification successful, use the unified type (which might be more specific)
        // Apply substitutions resulting from unification
        rhsFinalType = this.applySubstitution(
          annotatedType,
          this.currentSubstitution
        );
      }
    }

    // Handle different assignment targets
    if (targetCtx.IDENTIFIER()) {
      // Simple assignment: let x = ...
      const identifierName = targetCtx.IDENTIFIER()!.getText();
      this.environment.declare(identifierName, rhsFinalType, ctx, (str) =>
        this.reportError(str, ctx)
      );
      this.hints.push({ context: targetCtx, type: rhsFinalType.toString() });
    } else if (targetCtx.recordDestructuringPattern()) {
      // Record destructuring: let { a, b } = ...
      const patternCtx = targetCtx.recordDestructuringPattern()!;
      if (!(rhsFinalType instanceof RecordType)) {
        this.reportError(
          `Cannot destructure non-record type '${rhsFinalType}' as a record.`,
          expressionCtx
        );
        // Declare variables as Unknown to avoid cascading errors
        patternCtx.IDENTIFIER().forEach((idNode) => {
          const idName = idNode.getText();
          this.environment.declare(idName, UnknownType, null, (str) =>
            this.reportError(str, patternCtx)
          );
          this.hints.push({
            context: patternCtx,
            type: UnknownType.toString(),
          });
        });
      } else {
        patternCtx.IDENTIFIER().forEach((idNode) => {
          const idName = idNode.getText();
          if (!rhsFinalType.fields.has(idName)) {
            this.reportError(
              `Property '${idName}' does not exist on type '${rhsFinalType}'.`,
              patternCtx
            );
            this.environment.declare(idName, UnknownType, null, (str) =>
              this.reportError(str, patternCtx)
            );
            this.hints.push({
              context: patternCtx,
              type: UnknownType.toString(),
            });
          } else {
            const fieldType = this.applySubstitution(
              rhsFinalType.fields.get(idName)!,
              this.currentSubstitution
            );
            this.environment.declare(idName, fieldType, null, (str) =>
              this.reportError(str, patternCtx)
            );
            this.hints.push({
              context: patternCtx,
              type: fieldType.toString(),
            });
          }
        });
      }
    } else if (targetCtx.arrayDestructuringPattern()) {
      // Array/Tuple destructuring: let [x, y] = ...
      const patternCtx = targetCtx.arrayDestructuringPattern()!;
      const identifiers = patternCtx.IDENTIFIER();

      if (rhsFinalType instanceof ArrayType) {
        const elementType = this.applySubstitution(
          rhsFinalType.elementType,
          this.currentSubstitution
        );
        identifiers.forEach((idNode) => {
          const idName = idNode.getText();
          this.environment.declare(idName, elementType, null, (str) =>
            this.reportError(str, patternCtx)
          );
          this.hints.push({
            context: patternCtx,
            type: elementType.toString(),
          });
        });
      } else if (rhsFinalType instanceof TupleType) {
        if (identifiers.length > rhsFinalType.elementTypes.length) {
          this.reportError(
            `Destructuring pattern has ${identifiers.length} elements, but tuple type '${rhsFinalType}' only has ${rhsFinalType.elementTypes.length}.`,
            patternCtx
          );
        }
        identifiers.forEach((idNode, index) => {
          const idName = idNode.getText();
          if (index < rhsFinalType.elementTypes.length) {
            const elementType = this.applySubstitution(
              rhsFinalType.elementTypes[index],
              this.currentSubstitution
            );
            this.environment.declare(idName, elementType, null, (str) =>
              this.reportError(str, patternCtx)
            );
            this.hints.push({
              context: patternCtx,
              type: elementType.toString(),
            });
          } else {
            // Error already reported about length mismatch, declare as Unknown
            this.environment.declare(idName, UnknownType, null, (str) =>
              this.reportError(str, patternCtx)
            );
            this.hints.push({
              context: patternCtx,
              type: UnknownType.toString(),
            });
          }
        });
      } else {
        this.reportError(
          `Cannot destructure non-array/non-tuple type '${rhsFinalType}' as an array.`,
          expressionCtx
        );
        // Declare variables as Unknown
        identifiers.forEach((idNode) => {
          const idName = idNode.getText();
          this.environment.declare(idName, UnknownType, null, (str) =>
            this.reportError(str, patternCtx)
          );
          this.hints.push({
            context: patternCtx,
            type: UnknownType.toString(),
          });
        });
      }
    } else {
      this.reportError("Unknown assignment target type.", targetCtx);
    }

    return rhsFinalType; // Return the type of the right-hand side
  }

  visitTypeDefinition(ctx: parser.TypeDefinitionContext): ChicoryType {
    const typeName = ctx.IDENTIFIER().getText();
    if (typeName[0].toUpperCase() !== typeName[0]) {
      this.reportError(
        `User defined types should begin with a capital letter: ${typeName}`,
        ctx
      );
    }

    // Create a new scope for type parameters
    this.environment = this.environment.pushScope();

    // Handle type parameters if present
    const typeParams: TypeVariable[] = [];
    if (ctx.typeParams()) {
      ctx
        .typeParams()!
        .IDENTIFIER()
        .forEach((param) => {
          const paramName = param.getText();
          const typeVar = new TypeVariable(paramName);

          // Add type parameter to environment
          this.environment.declare(paramName, typeVar, ctx, (str) =>
            this.reportError(str, ctx)
          );

          typeParams.push(typeVar);
        });
    }

    // Visit the type expression in the context of the type parameters
    const baseType = this.visitTypeExpr(ctx.typeExpr(), typeName);

    // Create the final type
    let finalType: ChicoryType;
    if (typeParams.length > 0) {
      // If we have type parameters, create a generic type
      finalType = new GenericType(typeName, typeParams);

      // Store the constructors with the generic type
      // This is important for later when we need to instantiate the type
      const adtConstructors = this.constructors.filter(
        (c) => c.adtName === typeName
      );
      (finalType as any).constructors = adtConstructors;
    } else {
      // Otherwise, use the base type
      finalType = baseType;
    }

    // Pop the type parameter scope
    this.environment = this.environment.popScope();

    // Declare the type in the outer scope
    this.environment.declare(typeName, finalType, ctx, (str) =>
      this.reportError(str, ctx)
    );

    return finalType;
  }

  private visitTypeExpr(
    ctx: parser.TypeExprContext,
    typeName?: string,
    typeVarsInSig?: Map<string, TypeVariable> // Added optional map parameter
  ): ChicoryType {
    // Pass map down to primary type visit
    let baseType = this.visitPrimaryTypeExpr(
      ctx.primaryTypeExpr(),
      typeName,
      typeVarsInSig
    );

    // Array handling remains the same
    const arraySuffixCount =
      ctx.children?.filter((c) => c.getText() === "[]").length ?? 0;
    for (let i = 0; i < arraySuffixCount; i++) {
      baseType = new ArrayType(baseType);
    }

    return baseType;
  }

  // Add the new visitPrimaryTypeExpr method
  private visitPrimaryTypeExpr(
    ctx: parser.PrimaryTypeExprContext,
    typeName?: string,
    typeVarsInSig?: Map<string, TypeVariable>
  ): ChicoryType {
    if (ctx.adtType()) {
      //     // This context likely refers to an ADT *name*.
      //     // The full ADT definition syntax (| A | B) shouldn't appear here typically.
      //     // Let's assume it's an identifier representing an ADT.
      //     // We need a robust way to get the intended name. getText() is broad.
      //     // If adtType ONLY contains an IDENTIFIER in this context (grammar dependent):
      //     const adtName = ctx.adtType()!.getText(); // Adjust if grammar is more complex
      //     const type = this.environment.getType(adtName);
      //     if (type) {
      //       // Found in env (could be ADT, Generic, or TypeVar)
      //       return type;
      //     }
      //     // Assume it's an ADT defined elsewhere if not in env
      //     return new AdtType(adtName);

      // This is a generic if the "ADT" is not already declared
      const maybeAdtOption = ctx.adtType()?.adtOption();
      if (
        maybeAdtOption?.length === 1 &&
        maybeAdtOption[0] instanceof parser.AdtOptionNoArgContext
      ) {
        const possibleGeneric = maybeAdtOption[0].IDENTIFIER().getText();
        if (typeVarsInSig?.has(possibleGeneric)) {
          return typeVarsInSig.get(possibleGeneric)!;
        }
        const isInEnvironment = this.environment.getType(possibleGeneric);
        if (!isInEnvironment) {
          return new GenericType(possibleGeneric, []);
        }
      }
      // Otherwise, it's an ADT
      return this.visitAdtType(ctx.adtType()!, typeName);
    } else if (ctx.functionType()) {
      return this.visitFunctionType(ctx.functionType()!);
    } else if (ctx.genericTypeExpr()) {
      return this.visitGenericTypeExpr(ctx.genericTypeExpr()!, typeVarsInSig);
    } else if (ctx.recordType()) {
      return this.visitRecordType(ctx.recordType()!, typeVarsInSig);
    } else if (ctx.tupleType()) {
      return this.visitTupleType(ctx.tupleType()!, typeVarsInSig);
    } else if (ctx.primitiveType()) {
      return this.getPrimitiveType(ctx.primitiveType()!);
    } else if (ctx.IDENTIFIER()) {
      const name = ctx.IDENTIFIER()!.getText();
      // --- Add Logging ---
      if (name === "T") {
        // Or adjust if the type var name might differ
        console.log(`[visitPrimaryTypeExpr] Encountered IDENTIFIER '${name}'.`);
        if (typeVarsInSig) {
          console.log(
            `  - typeVarsInSig provided. Keys: [${Array.from(
              typeVarsInSig.keys()
            ).join(", ")}]`
          );
          console.log(
            `  - typeVarsInSig.has('${name}'): ${typeVarsInSig.has(name)}`
          );
          if (typeVarsInSig.has(name)) {
            const tvis = typeVarsInSig.get(name);
            console.log(
              `  - Found in typeVarsInSig. Type: ${typeVarsInSig
                .get(name)
                ?.toString()} (Kind: ${
                tvis && "kind" in tvis ? tvis.kind : "no kind"
              })`
            );
          }
        } else {
          console.log(`  - typeVarsInSig is null/undefined.`);
        }
      }
      // --- End Logging ---

      if (typeVarsInSig?.has(name)) {
        return typeVarsInSig.get(name)!;
      }

      const type = this.environment.getType(name);
      if (name === "T")
        console.log(
          `[visitPrimaryTypeExpr] '${name}' not in typeVarsInSig. Checking environment. Found: ${type?.toString()}`
        ); // Log env check specifically for T

      // Check environment SECOND
      if (type) {
        console.log(`[visitPrimaryTypeExpr] Found '${name}' in environment.`);
        // If found in env, it's a concrete type (or already declared generic/ADT)
        return type;
      }

      // THIRD: If we are likely parsing a type signature (typeVarsInSig exists)
      // AND the identifier is uppercase, assume it's an intended type variable
      // that might be defined later in the signature (e.g., return type uses a param var).
      // This helps catch cases missed by visitParameterType.
      if (typeVarsInSig && name[0].toUpperCase() === name[0]) {
        console.log(
          `[visitPrimaryTypeExpr] Assuming '${name}' is a signature TypeVariable (not found yet).`
        );
        const typeVar = new TypeVariable(name);
        // Add it to the map now so it's found if referenced again in the same signature
        typeVarsInSig.set(name, typeVar);
        // Optionally declare in temp env too? Might be redundant if visitParameterType handles it.
        // this.environment.declare(name, typeVar, ctx, ...);
        return typeVar;
      }

      // LAST RESORT: Undefined type. Report error and return Unknown.
      this.reportError(`Type identifier '${name}' not found.`, ctx);
      console.log(
        `[visitPrimaryTypeExpr] Identifier '${name}' not found in typeVarsInSig or environment. Reporting error.`
      );
      return UnknownType; // Changed from GenericType fallback
    } else if (ctx.typeExpr()) {
      // For '(' typeExpr ')'
      return this.visitTypeExpr(ctx.typeExpr()!, typeName, typeVarsInSig); // Recursively call visitTypeExpr
    }

    this.reportError(
      `Unsupported primary type expression: ${ctx.getText()}`,
      ctx
    );
    return UnknownType;
  }

  private visitGenericTypeExpr(
    ctx: parser.GenericTypeExprContext,
    typeVarsInSig?: Map<string, TypeVariable> // Added map
  ): ChicoryType {
    const typeName = ctx.IDENTIFIER().getText();
    // Pass map when visiting arguments
    const typeArguments = ctx
      .typeExpr()
      .map((e) => this.visitTypeExpr(e, undefined, typeVarsInSig));
    // Check if the base typeName itself is a signature type variable
    if (typeVarsInSig?.has(typeName)) {
      // This case is complex: e.g. T<number> where T is a type var bound to a generic type constructor
      // For now, let's assume the base name refers to a type in the environment or a defined generic.
      // A more advanced system might handle higher-kinded types here.
      console.warn(
        `[visitGenericTypeExpr] Using type variable '${typeName}' as base of generic type application is not fully supported.`
      );
    }
    return new GenericType(typeName, typeArguments);
  }

  private visitFunctionType(ctx: parser.FunctionTypeContext): ChicoryType {
    // --- NEW: Scope and Map for Signature Vars ---
    this.environment = this.environment.pushScope(); // Push scope for params FIRST
    const typeVarsInSig = new Map<string, TypeVariable>(); // Track vars for this signature
    // --- END NEW ---

    const paramTypes = ctx.typeParam()
      ? ctx.typeParam().map((p) => this.visitParameterType(p, typeVarsInSig)) // Pass map
      : [];
    // Pass map to return type visit
    const returnType = this.visitTypeExpr(
      ctx.typeExpr(),
      undefined,
      typeVarsInSig
    );

    // --- NEW: Pop scope AFTER parsing everything ---
    this.environment = this.environment.popScope();
    // --- END NEW ---

    return new FunctionType(paramTypes, returnType);
  }

  // 2. Modify visitParameterType signature and logic
  private visitParameterType(
    ctx: parser.TypeParamContext,
    typeVarsInSig: Map<string, TypeVariable> // Added map parameter
  ): ChicoryType {
    // Replace the content of this block:
    if (ctx instanceof parser.UnnamedTypeParamContext) {
      const typeExprCtx = ctx.typeExpr();
      const primaryTypeExprCtx = typeExprCtx.primaryTypeExpr();
      const primaryText = primaryTypeExprCtx?.getText(); // Get the text content

      // --- REVISED CONDITION ---
      // Check if the text is a single uppercase identifier and there's no array suffix
      // Check child count: > 1 implies the '[]' suffix is present.
      if (
        primaryText &&
        /^[A-Z][a-zA-Z0-9_]*$/.test(primaryText) &&
        typeExprCtx.getChildCount() <= 1
      ) {
        // <<< MODIFIED CHECK
        const name = primaryText;
        // Convention: Uppercase identifiers in type param position are type vars for this sig
        // (The regex already checked the uppercase start)

        if (typeVarsInSig.has(name)) {
          console.log(
            `[visitParameterType] Reusing existing TypeVariable '${name}' for signature.`
          );
          return typeVarsInSig.get(name)!; // Reuse if already seen
        }
        // Treat as a new Type Variable for this signature
        const typeVar = new TypeVariable(name);
        typeVarsInSig.set(name, typeVar);
        // Declare in the temporary environment scope too
        this.environment.declare(name, typeVar, ctx, (str) =>
          this.reportError(str, ctx)
        );
        console.log(
          `[visitParameterType] Parsed '${name}' as NEW TypeVariable for signature (using getText).` // Updated log
        );
        return typeVar; // <<< Ensure this return happens
      }
      // --- END REVISED CONDITION ---

      // If not a simple uppercase identifier based on text, or if it has '[]', treat as regular type expression
      console.log(
        `[visitParameterType] '${ctx.getText()}' is not a simple uppercase identifier or has array suffix. Parsing as regular type expression.` // Updated log
      );
      return this.visitTypeExpr(typeExprCtx, undefined, typeVarsInSig); // Pass map down
    } else if (ctx instanceof parser.NamedTypeParamContext) {
      // For named params like 'x: T', parse the type 'T' using the context
      const paramName = ctx.IDENTIFIER().getText(); // TODO: Use paramName? Currently unused.
      const paramType = this.visitTypeExpr(
        ctx.typeExpr(),
        undefined,
        typeVarsInSig
      ); // Pass map
      // Decide semantics: does 'x: T' declare 'x' with type 'T', or is 'T' itself the param type?
      // Assuming 'x' is the runtime parameter and 'paramType' is its type.
      // We declare 'x' later when visiting the function *body* or parameters list.
      // Here, we are parsing the *type signature*, so we return the parsed type.
      // If 'T' needed to be declared as a type var itself, it should follow the unnamed convention.
      return paramType; // Return the parsed type T
    }

    throw new Error(`Unknown parameter type: ${ctx.getText()}`);
  }

  private visitRecordType(
    ctx: parser.RecordTypeContext,
    typeVarsInSig?: Map<string, TypeVariable> // Added map
  ): ChicoryType {
    const recordType = new RecordType(new Map());
    ctx.recordTypeAnontation().forEach((kv) => {
      const id = kv.IDENTIFIER()[0].getText();
      let val: ChicoryType;

      // Pass map down when resolving field types
      if (kv.primitiveType()) {
        val = this.getPrimitiveType(kv.primitiveType()!);
      } else if (kv.recordType()) {
        val = this.visitRecordType(kv.recordType()!, typeVarsInSig); // Pass map
      } else if (kv.tupleType()) {
        val = this.visitTupleType(kv.tupleType()!, typeVarsInSig); // Pass map
      } else if (kv.functionType()) {
        // visitFunctionType creates its own scope/map, doesn't need the outer one passed
        val = this.visitFunctionType(kv.functionType()!);
      } else if (kv.IDENTIFIER()?.length > 1) {
        // Ensure it's the type identifier case
        const rhs = kv.IDENTIFIER()[1].getText();
        // Check signature vars first, then environment, then fallback
        val =
          typeVarsInSig?.get(rhs) ||
          this.environment.getType(rhs) ||
          new GenericType(rhs, []); // Fallback placeholder
      } else {
        this.reportError(`Unknown record type annotation: ${kv.getText()}`, kv);
        val = UnknownType;
      }
      recordType.fields.set(id, val);
    });
    return recordType;
  }

  private visitAdtType(
    ctx: parser.AdtTypeContext,
    typeName = "AnonymousADT"
  ): ChicoryType {
    const adtType = new AdtType(typeName);
    // Declare the ADT type itself
    // this.environment.declare(typeName, adtType, ctx, (str) =>
    //   this.reportError(str, ctx)
    // );

    ctx.adtOption().forEach((option) => {
      let constructorName: string;
      let constructorType: ChicoryType;

      if (option instanceof parser.AdtOptionAnonymousRecordContext) {
        constructorName = option.IDENTIFIER().getText();

        const recordType = new RecordType(new Map());
        option.adtTypeAnnotation().forEach((annotation) => {
          const fieldName = annotation.IDENTIFIER()[0].getText();
          let fieldType: ChicoryType;

          if (annotation.primitiveType()) {
            fieldType = this.getPrimitiveType(annotation.primitiveType()!);
          } else {
            // Check if it's a type parameter
            const typeName = annotation.IDENTIFIER()[1].getText();
            fieldType =
              this.environment.getType(typeName) ||
              new GenericType(typeName, []); // Assume it's a generic if not found
          }

          recordType.fields.set(fieldName, fieldType);
        });

        // Constructor is a function that takes the record and returns the ADT
        constructorType = new FunctionType(
          [recordType],
          adtType,
          constructorName
        );
      } else if (option instanceof parser.AdtOptionNamedTypeContext) {
        constructorName = option.IDENTIFIER()[0].getText();

        // Get the parameter type name
        const paramTypeName = option.IDENTIFIER()[1].getText();

        // Check if it's a type parameter
        const paramType = this.environment.getType(paramTypeName);
        if (paramType) {
          constructorType = new FunctionType(
            [paramType],
            adtType,
            constructorName
          );
        } else {
          // If not found, it might be a reference to another type
          // For now, create a generic reference
          constructorType = new FunctionType(
            [new GenericType(paramTypeName, [])],
            adtType,
            constructorName
          );
        }
      } else if (option instanceof parser.AdtOptionPrimitiveTypeContext) {
        constructorName = option.IDENTIFIER().getText();

        const paramType = this.getPrimitiveType(option.primitiveType()!);
        constructorType = new FunctionType(
          [paramType],
          adtType,
          constructorName
        );
      } else if (option instanceof parser.AdtOptionNoArgContext) {
        constructorName = option.IDENTIFIER().getText();
        constructorType = new FunctionType([], adtType, constructorName);
      } else {
        throw new Error(`Unknown adt option type: ${option.getText()}`);
      }

      this.constructors.push({
        adtName: typeName,
        name: constructorName,
        type: constructorType,
      });
    });

    return adtType;
  }

  private visitTupleType(
    ctx: parser.TupleTypeContext,
    typeVarsInSig?: Map<string, TypeVariable> // Added map
  ): ChicoryType {
    // Pass map when visiting element types
    return new TupleType(
      ctx.typeExpr().map((e) => this.visitTypeExpr(e, undefined, typeVarsInSig))
    );
  }

  private getPrimitiveType(ctx: parser.PrimitiveTypeContext): ChicoryType {
    if (ctx.getText() === "number") return NumberType;
    if (ctx.getText() === "string") return StringType;
    if (ctx.getText() === "boolean") return BooleanType;
    if (ctx.getText() === "void") return UnitType;
    return UnknownType;
  }

  visitImportStmt(ctx: parser.ImportStmtContext): ChicoryType {
    if (
      !(
        ctx instanceof parser.ImportStatementContext ||
        ctx instanceof parser.BindStatementContext
      )
    ) {
      throw new Error("Invalid import statement");
    }

    if (ctx instanceof parser.BindStatementContext) {
      if (ctx.IDENTIFIER()) {
        // There will definitely be a typeExpr if there is an IDENTIFIER (for bind statements)
        const type = this.visitTypeExpr(ctx.typeExpr()!);
        this.environment.declare(
          ctx.IDENTIFIER()!.getText(),
          type,
          ctx,
          (str) => this.reportError(str, ctx)
        );
      }

      if (ctx.bindingImportIdentifier()) {
        ctx
          .bindingImportIdentifier()!
          .bindingIdentifier()
          .forEach((bindingId) => {
            const id = bindingId.IDENTIFIER().getText();
            const type = this.visitTypeExpr(bindingId.typeExpr());
            this.environment.declare(id, type, ctx, (str) =>
              this.reportError(str, ctx)
            );
          });
      }

      return UnitType;
    }

    let fromPathRaw = ctx.STRING().getText(); // e.g., '"./other.chic"' or '"lodash"'
    const fromPath = fromPathRaw.substring(1, fromPathRaw.length - 1); // Remove quotes

    if (fromPath.endsWith(".chic")) {
      const importerDir = path.dirname(this.currentFilePath);
      const absoluteImportPath = path.resolve(importerDir, fromPath);

      let importedData: CompilationCacheEntry | undefined =
        this.compilationCache.get(absoluteImportPath);

      if (!importedData) {
        // Not in cache, need to parse and check the imported file
        try {
          const importedFileContent = this.readFile(absoluteImportPath);

          const inputStream = CharStream.fromString(importedFileContent);
          const lexer = new ChicoryLexer(inputStream);
          // TODO: Add Error Listener to lexer/parser for imported file syntax errors
          const tokenStream = new CommonTokenStream(lexer);
          const importedParser = new ChicoryParser(tokenStream);
          const importedTree = importedParser.program();

          // Create a *new* checker instance for the imported file
          // It shares the cache and processing set, but has its own environment etc.
          const importedChecker =
            new ChicoryTypeChecker(/* pass necessary initial state if any */);
          const analysisResult = importedChecker.check(
            importedTree,
            absoluteImportPath,
            this.readFile, // Pass down the reader
            this.compilationCache, // Pass down the cache
            this.processingFiles // Pass down the processing set
          );

          // The result is now in the cache, retrieve it
          importedData = this.compilationCache.get(absoluteImportPath);

          // Aggregate errors from the imported file into the current one
          if (analysisResult.errors.length > 0) {
            analysisResult.errors.forEach((err) => {
              // Modify error message to indicate origin?
              this.errors.push({
                ...err,
                message: `(From ${path.basename(absoluteImportPath)}) ${
                  err.message
                }`,
              });
            });
          }
        } catch (e) {
          this.reportError(
            `Failed to read or parse imported file: ${absoluteImportPath}. ${
              e instanceof Error ? e.message : String(e)
            }`,
            ctx
          );
          // Mark as processed with error in cache? Or just return?
          // For now, just report error and continue.
          return UnitType;
        }
      }

      // If we still don't have data (e.g., read error, circular dependency detected earlier)
      if (!importedData) {
        this.reportError(
          `Could not load exports from ${fromPath}. Check for errors in that file or circular dependencies.`,
          ctx
        );
        return UnitType;
      }

      // --- Add imported bindings to the current environment ---
      const availableExports = importedData.exports;

      // Handle default import (if syntax allows later)
      // if (ctx.IDENTIFIER() && !ctx.destructuringImportIdentifier()) { ... }

      // Handle named imports
      if (ctx.destructuringImportIdentifier()) {
        ctx
          .destructuringImportIdentifier()!
          .IDENTIFIER()
          .forEach((idNode) => {
            const importName = idNode.getText();
            if (availableExports.has(importName)) {
              const importedType = availableExports.get(importName)!;
              // TODO: Handle potential generic instantiation if needed here?
              // For now, declare with the type as stored in exports.
              this.environment.declare(importName, importedType, null, (str) =>
                this.reportError(str, ctx)
              );
              this.hints.push({
                context: ctx,
                type: importedType.toString(),
              });
            } else {
              this.reportError(
                `Module "${fromPath}" does not export "${importName}".`,
                ctx
              );
              // Declare as Unknown to prevent cascade errors
              this.environment.declare(importName, UnknownType, null, (str) =>
                this.reportError(str, ctx)
              );
            }
          });
      }
      // Handle import * (if syntax allows later)
      // else if (ctx.ASTERISK()) { ... }
    } else {
      // Treat as a JS import if not ending in .chic and not using 'bind'
      // This might need refinement based on desired behavior.
      // For now, assume non-`.chic` imports without `bind` are errors or need specific handling.
      this.reportError(
        `Unsupported import path: ${fromPathRaw}. Use 'bind' for JS modules or ensure Chicory files end with '.chic'.`,
        ctx
      );
      // Declare imports as UnknownType if needed
      if (ctx.destructuringImportIdentifier()) {
        ctx
          .destructuringImportIdentifier()!
          .IDENTIFIER()
          .forEach((idNode) => {
            const importName = idNode.getText();
            this.environment.declare(importName, UnknownType, null, (str) =>
              this.reportError(str, ctx)
            );
          });
      }
    }

    return UnitType;
  }

  visitExportStmt(ctx: parser.ExportStmtContext): ChicoryType {
    // Assuming it's visited within visitProgram/visitStmt
    ctx.IDENTIFIER().forEach((idNode) => {
      const exportName = idNode.getText();
      const exportType = this.environment.getType(exportName); // Look up in current env

      if (exportType) {
        // Apply substitution before storing? Usually yes, to capture inferred types.
        const finalExportType = this.applySubstitution(
          exportType,
          this.currentSubstitution
        );
        this.exportedBindings.set(exportName, finalExportType);
      } else {
        this.reportError(
          `Cannot export undefined identifier '${exportName}'.`,
          ctx
        );
        // Optionally add to exports as UnknownType? Or omit? Omit is safer.
      }
    });
    return UnitType; // Export statement itself has no type
  }

  visitExpr(ctx: parser.ExprContext): ChicoryType {
    let primaryType = this.visitPrimaryExpr(ctx.primaryExpr());
    for (const tailExpr of ctx.tailExpr()) {
      primaryType = this.visitTailExpr(tailExpr, primaryType);
    }
    return primaryType;
  }

  visitTailExpr(
    ctx: parser.TailExprContext,
    baseType: ChicoryType
  ): ChicoryType {
    // Apply substitution accumulated so far to the base type BEFORE checking it
    baseType = this.applySubstitution(baseType, this.currentSubstitution);
    let resultType: ChicoryType = UnknownType; // Default result

    if (ctx.ruleContext instanceof parser.MemberExpressionContext) {
      const memberName = (ctx as parser.MemberExpressionContext)
        .IDENTIFIER()
        .getText();

      if (baseType instanceof RecordType) {
        if (!baseType.fields.has(memberName)) {
          this.reportError(
            `Member '${memberName}' not found on record type '${baseType}'`,
            ctx
          );
          resultType = UnknownType;
        } else {
          // Get field type and apply substitution
          resultType = this.applySubstitution(
            baseType.fields.get(memberName)!,
            this.currentSubstitution
          );
        }
      } else if (baseType instanceof ArrayType) {
        const elementType = this.applySubstitution(
          baseType.elementType,
          this.currentSubstitution
        ); // Substituted element type

        switch (memberName) {
          case "length":
            resultType = NumberType;
            break;
          case "map": {
            // Type: ( (T) => U ) => U[]
            const callbackReturnTypeVar = this.newTypeVar();
            const callbackType = new FunctionType(
              [elementType],
              callbackReturnTypeVar
            );
            resultType = new FunctionType(
              [callbackType],
              new ArrayType(callbackReturnTypeVar)
            );
            break;
          }
          case "filter": {
            // Type: ( (T) => boolean ) => T[]
            const callbackType = new FunctionType([elementType], BooleanType);
            resultType = new FunctionType(
              [callbackType],
              new ArrayType(elementType) // Returns array of the *original* element type
            );
            break;
          }
          case "reduce": {
            // Type: ( (Acc, T) => Acc, Acc ) => Acc
            const accumulatorTypeVar = this.newTypeVar();
            const callbackType = new FunctionType(
              [accumulatorTypeVar, elementType],
              accumulatorTypeVar
            );
            resultType = new FunctionType(
              [callbackType, accumulatorTypeVar], // Takes callback and initial value
              accumulatorTypeVar // Returns the final accumulator value
            );
            break;
          }
          // TODO: Add other methods: push, pop, slice, etc.
          // pop: () => Option<T>
          // push: (T) => void (or number?) - Consider immutability implications
          case "find": {
            // Type: ( (T) => boolean ) => Option<T>
            const callbackType = new FunctionType([elementType], BooleanType);
            const optionType = this.environment.getType("Option");

            if (
              optionType instanceof GenericType &&
              optionType.typeArguments.length > 0 &&
              optionType.typeArguments[0] instanceof TypeVariable
            ) {
              resultType = new FunctionType(
                [callbackType],
                new GenericType(optionType.name, [elementType]) // Option<T>
              );
              this.prelude.requireOptionType();
            } else {
              this.reportError(
                "The 'Option' type is required for 'find' but is not defined or not generic.",
                ctx
              );
              // Fallback placeholder
              resultType = new FunctionType(
                [callbackType],
                new GenericType("Option", [elementType])
              );
            }
            break;
          }
          case "findIndex": {
            // Type: ( (T) => boolean ) => Option<number>
            const callbackType = new FunctionType([elementType], BooleanType);
            const optionType = this.environment.getType("Option");

            if (
              optionType instanceof GenericType &&
              optionType.typeArguments.length > 0 &&
              optionType.typeArguments[0] instanceof TypeVariable
            ) {
              resultType = new FunctionType(
                [callbackType],
                new GenericType(optionType.name, [NumberType]) // Option<number>
              );
              this.prelude.requireOptionType();
            } else {
              this.reportError(
                "The 'Option' type is required for 'findIndex' but is not defined or not generic.",
                ctx
              );
              // Fallback placeholder
              resultType = new FunctionType(
                [callbackType],
                new GenericType("Option", [NumberType])
              );
            }
            break;
          }
          case "includes": {
            // Type: (T) => boolean (Ignoring optional fromIndex for now)
            resultType = new FunctionType([elementType], BooleanType);
            break;
          }
          default:
            this.reportError(
              `Member '${memberName}' not found on array type '${baseType}'`,
              ctx
            );
            resultType = UnknownType;
        }
      } else if (baseType instanceof TypeVariable) {
        this.reportError(
          `Cannot access member '${memberName}' on value of unknown type '${baseType}'. Add type annotation.`,
          ctx
        );
        resultType = UnknownType;
      } else if (baseType === StringType) {
        // Handle string members if/when added (e.g., length, slice)
        if (memberName === "length") {
          resultType = NumberType;
        } else {
          this.reportError(
            `Member '${memberName}' not found on type 'string'`,
            ctx
          );
          resultType = UnknownType;
        }
      } else {
        this.reportError(
          `Cannot access member '${memberName}' on type '${baseType}' (expected Record, Array, or String).`,
          ctx
        );
        resultType = UnknownType;
      }
      // Add hint for the resulting type of the member access
      this.hints.push({ context: ctx, type: resultType.toString() });
    } else if (ctx.ruleContext instanceof parser.IndexExpressionContext) {
      const indexExprCtx = (ctx as parser.IndexExpressionContext).expr();
      const indexType = this.applySubstitution(
        this.visitExpr(indexExprCtx),
        this.currentSubstitution
      );

      // --- Index Type Check ---
      let isIndexValid = false;
      if (indexType === NumberType) {
        isIndexValid = true;
      } else if (indexType instanceof TypeVariable) {
        const result = this.unify(
          indexType,
          NumberType,
          this.currentSubstitution
        );
        if (!(result instanceof Error)) {
          isIndexValid = true; // Unification succeeded
        } else {
          this.reportError(
            `Index must be a number, but got potentially non-number type '${indexType}'`,
            indexExprCtx
          );
        }
      } else {
        this.reportError(
          `Index must be a number, but got '${indexType}'`,
          indexExprCtx
        );
      }
      // --- End Index Type Check ---

      if (baseType instanceof TupleType) {
        // Tuple indexing: Requires literal number index at compile time
        const indexExpr = indexExprCtx.primaryExpr();
        if (
          isIndexValid &&
          indexExpr instanceof parser.LiteralExpressionContext &&
          indexExpr.literal() instanceof parser.NumberLiteralContext
        ) {
          const indexValue = parseInt(indexExpr.getText());
          if (
            isNaN(indexValue) ||
            indexValue < 0 ||
            indexValue >= baseType.elementTypes.length
          ) {
            this.reportError(
              `Tuple index ${indexValue} is out of bounds for type '${baseType}' (length ${baseType.elementTypes.length})`,
              indexExprCtx
            );
            resultType = UnknownType;
          } else {
            // Index is valid and literal, return the specific element type
            const elementType = baseType.elementTypes[indexValue];
            resultType = this.applySubstitution(
              elementType,
              this.currentSubstitution
            ); // Apply substitution
          }
        } else {
          if (isIndexValid) {
            this.reportError(
              `Tuple index must be a literal number for compile-time type checking. Found non-literal index for type '${baseType}'`,
              indexExprCtx
            );
          } // Else: Index type error already reported
          resultType = UnknownType;
        }
      } else if (baseType instanceof ArrayType) {
        // Array indexing: Returns Option<ElementType>
        if (!isIndexValid) {
          resultType = UnknownType; // Index error already reported
        } else {
          const elementType = this.applySubstitution(
            baseType.elementType,
            this.currentSubstitution
          );
          const optionType = this.environment.getType("Option"); // Look up the generic Option type

          if (optionType instanceof GenericType) {
            // Ensure the Option type definition has at least one type parameter
            if (
              optionType.typeArguments.length > 0 &&
              optionType.typeArguments[0] instanceof TypeVariable
            ) {
              // Directly create the instantiated GenericType: Option<ElementType>
              resultType = new GenericType(optionType.name, [elementType]);
              this.prelude.requireOptionType(); // Mark Option as used
            } else {
              this.reportError(
                `The 'Option' type definition found is not correctly defined as a generic type with a type parameter (e.g., Option<T>). Found: ${optionType}`,
                ctx
              );
              resultType = new GenericType("Option", [elementType]); // Fallback placeholder
            }
          } else {
            this.reportError(
              "The 'Option' type is required for array indexing but is not defined or is not a generic type.",
              ctx
            );
            // Fallback: return placeholder Option<T>
            resultType = new GenericType("Option", [elementType]);
          }
        }
      } else if (baseType instanceof TypeVariable) {
        this.reportError(
          `Cannot index into a value of unknown type '${baseType}'. Add type annotation.`,
          ctx
        );
        resultType = UnknownType;
      } else {
        this.reportError(
          `Type '${baseType}' is not indexable (expected Tuple or Array).`,
          ctx
        );
        resultType = UnknownType;
      }
      // Add hint for the resulting type of the index operation
      this.hints.push({ context: ctx, type: resultType.toString() });
    } else if (ctx.ruleContext instanceof parser.CallExpressionContext) {
      // Pass the *substituted* baseType (which should be a function type)
      resultType = this.visitCallExpr(
        (ctx as parser.CallExpressionContext).callExpr(),
        baseType
      ); // Pass substituted baseType
      // visitCallExpr already adds hints internally
    } else if (ctx.ruleContext instanceof parser.OperationExpressionContext) {
      // Pass the *substituted* baseType
      resultType = this.visitOperation(
        ctx as parser.OperationExpressionContext,
        baseType
      );
      // visitOperation adds hints internally
    } else {
      this.reportError(`Unknown tail expression type: ${ctx.getText()}`, ctx);
      resultType = UnknownType;
      this.hints.push({ context: ctx, type: resultType.toString() });
    }

    // Store the result type for this tail expression context
    // This helps the compiler later potentially
    this.setExpressionType(ctx, resultType); // Assuming expressionTypes map exists

    return resultType; // Return the computed type for this tail expression
  }

  visitOperation(
    ctx: parser.OperationExpressionContext,
    baseType: ChicoryType
  ): ChicoryType {
    const operator = ctx.OPERATOR().getText();
    const rhsType = this.visitExpr(ctx.expr());

    // Apply current substitutions to the operand types
    baseType = this.applySubstitution(baseType, this.currentSubstitution);
    const rhsTypeSubstituted = this.applySubstitution(
      rhsType,
      this.currentSubstitution
    );

    switch (operator) {
      case "+":
        if (baseType === NumberType && rhsTypeSubstituted === NumberType) {
          return NumberType;
        } else if (
          baseType === StringType &&
          rhsTypeSubstituted === StringType
        ) {
          return StringType;
        } else {
          // Try to unify with expected types
          if (baseType instanceof TypeVariable) {
            const result = this.unify(
              baseType,
              NumberType,
              this.currentSubstitution
            );
            if (!(result instanceof Error)) {
              // If baseType can be a number, check if rhsType can also be a number
              if (rhsTypeSubstituted instanceof TypeVariable) {
                const rhsResult = this.unify(
                  rhsTypeSubstituted,
                  NumberType,
                  this.currentSubstitution
                );
                if (!(rhsResult instanceof Error)) {
                  return NumberType;
                }
              } else if (rhsTypeSubstituted === NumberType) {
                return NumberType;
              }
            }

            // Try string concatenation
            const strResult = this.unify(
              baseType,
              StringType,
              this.currentSubstitution
            );
            if (!(strResult instanceof Error)) {
              // If baseType can be a string, check if rhsType can also be a string
              if (rhsTypeSubstituted instanceof TypeVariable) {
                const rhsResult = this.unify(
                  rhsTypeSubstituted,
                  StringType,
                  this.currentSubstitution
                );
                if (!(rhsResult instanceof Error)) {
                  return StringType;
                }
              } else if (rhsTypeSubstituted === StringType) {
                return StringType;
              }
            }
          } else if (rhsTypeSubstituted instanceof TypeVariable) {
            // If the right side is a type variable, try to unify it with the base type
            if (baseType === NumberType) {
              const result = this.unify(
                rhsTypeSubstituted,
                NumberType,
                this.currentSubstitution
              );
              if (!(result instanceof Error)) {
                return NumberType;
              }
            } else if (baseType === StringType) {
              const result = this.unify(
                rhsTypeSubstituted,
                StringType,
                this.currentSubstitution
              );
              if (!(result instanceof Error)) {
                return StringType;
              }
            }
          }

          this.reportError(
            `Operator '+' cannot be applied to types '${baseType}' and '${rhsTypeSubstituted}'`,
            ctx
          );
          return UnknownType;
        }
      case "-":
      case "*":
      case "/":
        // Try to unify operands with NumberType
        if (baseType instanceof TypeVariable) {
          const result = this.unify(
            baseType,
            NumberType,
            this.currentSubstitution
          );
          if (result instanceof Error) {
            this.reportError(
              `Left operand of '${operator}' must be a number, but got '${baseType}'`,
              ctx
            );
          }
        } else if (baseType !== NumberType) {
          this.reportError(
            `Left operand of '${operator}' must be a number, but got '${baseType}'`,
            ctx
          );
        }

        if (rhsTypeSubstituted instanceof TypeVariable) {
          const result = this.unify(
            rhsTypeSubstituted,
            NumberType,
            this.currentSubstitution
          );
          if (result instanceof Error) {
            this.reportError(
              `Right operand of '${operator}' must be a number, but got '${rhsTypeSubstituted}'`,
              ctx
            );
          }
        } else if (rhsTypeSubstituted !== NumberType) {
          this.reportError(
            `Right operand of '${operator}' must be a number, but got '${rhsTypeSubstituted}'`,
            ctx
          );
        }

        return NumberType;
      case "==":
      case "!=":
      case "<":
      case ">":
      case "<=":
      case ">=":
        // Basic compatibility check
        if (
          (baseType === NumberType && rhsTypeSubstituted === NumberType) ||
          (baseType === StringType && rhsTypeSubstituted === StringType) ||
          (baseType === BooleanType && rhsTypeSubstituted === BooleanType)
        ) {
          return BooleanType;
        } else if (
          baseType instanceof TypeVariable ||
          rhsTypeSubstituted instanceof TypeVariable
        ) {
          // If either operand is a type variable, try to unify them
          const result = this.unify(
            baseType,
            rhsTypeSubstituted,
            this.currentSubstitution
          );
          if (!(result instanceof Error)) {
            // Successfully unified the types
            const unifiedType = this.applySubstitution(
              baseType,
              this.currentSubstitution
            );

            // Check if the unified type is a valid operand for comparison
            if (
              unifiedType === NumberType ||
              unifiedType === StringType ||
              unifiedType === BooleanType
            ) {
              return BooleanType;
            }
          }

          this.reportError(
            `Operator '${operator}' cannot be applied to types '${baseType}' and '${rhsTypeSubstituted}'`,
            ctx
          );
          return UnknownType;
        } else {
          this.reportError(
            `Operator '${operator}' cannot be applied to types '${baseType}' and '${rhsTypeSubstituted}'`,
            ctx
          );
          return UnknownType;
        }

      case "&&":
      case "||":
        // Try to unify operands with BooleanType
        if (baseType instanceof TypeVariable) {
          const result = this.unify(
            baseType,
            BooleanType,
            this.currentSubstitution
          );
          if (result instanceof Error) {
            this.reportError(
              `Left operand of '${operator}' must be a boolean, but got '${baseType}'`,
              ctx
            );
          }
        } else if (baseType !== BooleanType) {
          this.reportError(
            `Left operand of '${operator}' must be a boolean, but got '${baseType}'`,
            ctx
          );
        }

        if (rhsTypeSubstituted instanceof TypeVariable) {
          const result = this.unify(
            rhsTypeSubstituted,
            BooleanType,
            this.currentSubstitution
          );
          if (result instanceof Error) {
            this.reportError(
              `Right operand of '${operator}' must be a boolean, but got '${rhsTypeSubstituted}'`,
              ctx
            );
          }
        } else if (rhsTypeSubstituted !== BooleanType) {
          this.reportError(
            `Right operand of '${operator}' must be a boolean, but got '${rhsTypeSubstituted}'`,
            ctx
          );
        }

        return BooleanType;
      default:
        this.reportError(`Unsupported operator: ${operator}`, ctx);
        return UnknownType;
    }
  }

  visitPrimaryExpr(ctx: parser.PrimaryExprContext): ChicoryType {
    if (ctx instanceof parser.IdentifierExpressionContext) {
      return this.visitIdentifier(ctx);
    } else if (ctx instanceof parser.LiteralExpressionContext) {
      return this.visitLiteral(ctx.literal());
    } else if (ctx instanceof parser.ParenExpressionContext) {
      return this.visitExpr(ctx.expr());
    } else if (ctx instanceof parser.RecordExpressionContext) {
      return this.visitRecordExpr(ctx.recordExpr());
    } else if (ctx instanceof parser.ArrayLikeExpressionContext) {
      return this.visitArrayLikeExpr(ctx.arrayLikeExpr());
    } else if (ctx instanceof parser.BlockExpressionContext) {
      return this.visitBlockExpr(ctx.blockExpr());
    } else if (ctx instanceof parser.IfExpressionContext) {
      return this.visitIfExpr(ctx.ifExpr());
    } else if (ctx instanceof parser.FunctionExpressionContext) {
      return this.visitFuncExpr(ctx.funcExpr());
    } else if (ctx instanceof parser.MatchExpressionContext) {
      return this.visitMatchExpr(ctx.matchExpr());
      // } else if (ctx instanceof parser.JsxExpressionContext) {
      //   return this.visitJsxExpr(ctx.jsxExpr());
    }

    this.reportError(`Unknown primary expression type: ${ctx.getText()}`, ctx);
    return UnknownType;
  }

  visitIdentifier(ctx: parser.IdentifierExpressionContext): ChicoryType {
    const identifierName = ctx.IDENTIFIER().getText();
    console.log(`[visitIdentifier] ENTER: '${identifierName}'`);

    // 1. Check environment (variables, functions declared with let/const, etc.)
    const envType = this.environment.getType(identifierName);
    console.log(
      `  > Found in environment: ${envType ? envType.toString() : "null"}`
    );
    if (envType) {
      // Apply substitutions to the type found in the environment
      console.log(
        `  > Applying current substitution to env type:`,
        new Map(this.currentSubstitution)
      );
      let substitutedType = this.applySubstitution(
        envType,
        this.currentSubstitution
      );
      console.log(`  > Substituted env type: ${substitutedType.toString()}`);

      // If it's a function type from the env that might be generic, instantiate it.
      // (Keep existing logic for this part, ensure it handles generic functions correctly)
      if (substitutedType instanceof FunctionType) {
        console.log(
          `  > Substituted type is FunctionType. Checking if instantiation needed.`
        );
        // Check if it contains type variables that might need instantiation
        let containsTypeVars = false;
        const checkVars = (t: ChicoryType) => {
          if (t instanceof TypeVariable) containsTypeVars = true;
          else if (t instanceof FunctionType) {
            t.paramTypes.forEach(checkVars);
            checkVars(t.returnType);
          } else if (t instanceof ArrayType) checkVars(t.elementType);
          else if (t instanceof TupleType) t.elementTypes.forEach(checkVars);
          else if (t instanceof RecordType)
            Array.from(t.fields.values()).forEach(checkVars);
          else if (t instanceof GenericType) t.typeArguments.forEach(checkVars);
        };
        checkVars(substitutedType);
        console.log(`  > Contains type vars? ${containsTypeVars}`);

        if (containsTypeVars) {
          // Potentially generic function found in env, instantiate it
          console.log(`  > Instantiating function type from environment.`);
          substitutedType = this.instantiateFunctionType(substitutedType);
          console.log(
            `  > Instantiated function from env ${identifierName}: ${substitutedType}`
          );
        } else {
          console.log(`  > No instantiation needed for function type.`);
        }
      }
      // Note: We are NOT instantiating GenericType references found directly in the environment here.
      // Example: If `let x: Option<T> = ...`, looking up `x` should return the instantiated type.
      // If looking up the type name `Option` itself, it should return the generic definition.
      // The current logic applies substitution, which might be sufficient if `T` gets bound.

      this.hints.push({ context: ctx, type: substitutedType.toString() });
      console.log(
        `[visitIdentifier] EXIT: Returning from environment: ${substitutedType.toString()}`
      );
      return substitutedType; // Return type from env (potentially substituted and/or instantiated)
    }

    // 2. Check if it's an ADT constructor
    console.log(`  > Not found in env. Checking ADT constructors.`);
    const constructor = this.getConstructors().find(
      (c) => c.name === identifierName
    );
    console.log(
      `  > Found constructor definition: ${
        constructor ? constructor.name : "null"
      }`
    );

    if (constructor) {
      const originalConstructorType = constructor.type; // This is always a FunctionType
      console.log(
        `  > Original constructor type: ${originalConstructorType.toString()}`
      );

      // --- NEW LOGIC ---
      if (originalConstructorType instanceof FunctionType) {
        console.log(`  > Constructor type is FunctionType.`);
        // Check if it's a nullary constructor (takes no parameters)
        if (originalConstructorType.paramTypes.length === 0) {
          console.log(`  > Constructor is nullary (no params).`);
          // For nullary constructors used as values (e.g., `None` in `let x = None;`),
          // return the ADT *instance type* directly.
          const returnType = originalConstructorType.returnType; // e.g., Operation, Option<T>, Result<T, E>
          console.log(
            `  > Nullary constructor return type (pre-instantiation): ${returnType.toString()}`
          );

          // IMPORTANT: If the return type itself is generic (like Option<T>),
          // we need to instantiate it with fresh variables here, because
          // the specific type isn't known yet just from referencing the constructor.
          // Example: `None` should resolve to `Option<T'>` where T' is a fresh variable.
          let finalReturnType = returnType;
          if (
            returnType instanceof GenericType &&
            returnType.typeArguments.some(
              (arg) =>
                arg instanceof TypeVariable ||
                (arg instanceof GenericType && arg.typeArguments.length === 0)
            )
          ) {
            console.log(`  > Return type is generic and needs instantiation.`);
            // This is a nullary constructor for a GENERIC type (like None for Option<T>)
            // Instantiate the return type with fresh variables.
            finalReturnType = this.instantiateGenericType(returnType); // Use the helper
            console.log(
              `  > Instantiated nullary generic constructor return type ${identifierName}: ${returnType} -> ${finalReturnType}`
            );
          } else {
            console.log(
              `  > Return type is not generic or doesn't need instantiation.`
            );
            // Nullary constructor for a non-generic type (like Add for Operation)
            console.log(
              `  > Resolved nullary constructor ${identifierName} to its return type: ${finalReturnType}`
            );
          }

          this.hints.push({ context: ctx, type: finalReturnType.toString() });
          console.log(
            `[visitIdentifier] EXIT: Returning nullary constructor instance type: ${finalReturnType.toString()}`
          );
          return finalReturnType; // Return Operation, Option<T'>, Result<T', E'> etc.
        } else {
          console.log(`  > Constructor is non-nullary (has params).`);
          // For non-nullary constructors (like Some, Ok), return the *function* type.
          // This function type might need instantiation if the ADT is generic.
          // Example: `Some` should yield `(T) => Option<T>`. Using `Some` directly
          //          in a value context like `{ makeSome: Some }` will correctly
          //          assign the function type `(T') => Option<T'>` to `makeSome`.

          const adtDefinition = this.environment.getType(constructor.adtName);
          console.log(
            `  > ADT definition for '${constructor.adtName}': ${
              adtDefinition ? adtDefinition.toString() : "null"
            }`
          );
          let typeToReturn: ChicoryType = originalConstructorType; // Start with the original function type

          // Check if the ADT itself is generic. If so, instantiate the constructor's FUNCTION type.
          if (
            adtDefinition instanceof GenericType &&
            adtDefinition.typeArguments.length > 0
          ) {
            console.log(
              `  > ADT '${constructor.adtName}' is generic. Checking if constructor function needs instantiation.`
            );
            // Ensure the constructor function type itself involves those generic params.
            // This check might be redundant if instantiation handles non-generic cases gracefully.
            let needsInstantiation = false;
            const checkVars = (t: ChicoryType) => {
              if (t instanceof TypeVariable) needsInstantiation = true;
              else if (t instanceof FunctionType) {
                t.paramTypes.forEach(checkVars);
                checkVars(t.returnType);
              } else if (t instanceof ArrayType) checkVars(t.elementType);
              else if (t instanceof TupleType)
                t.elementTypes.forEach(checkVars);
              else if (t instanceof RecordType)
                Array.from(t.fields.values()).forEach(checkVars);
              else if (t instanceof GenericType)
                t.typeArguments.forEach(checkVars);
            };
            checkVars(typeToReturn);
            console.log(
              `  > Constructor function contains type vars? ${needsInstantiation}`
            );

            if (needsInstantiation) {
              console.log(
                `  > Instantiating non-nullary constructor function type.`
              );
              typeToReturn = this.instantiateFunctionType(
                originalConstructorType
              );
              console.log(
                `  > Instantiated non-nullary generic constructor FUNCTION ${identifierName}: ${originalConstructorType} -> ${typeToReturn}`
              );
            } else {
              console.log(
                `  > Using non-nullary constructor function type (ADT generic, but func not?) ${identifierName}: ${typeToReturn}`
              );
            }
          } else {
            console.log(
              `  > ADT '${constructor.adtName}' is not generic, or constructor function doesn't need instantiation.`
            );
            // Non-nullary constructor for a non-generic ADT.
            console.log(
              `  > Resolved non-nullary constructor function type ${identifierName}: ${typeToReturn}`
            );
          }

          this.hints.push({ context: ctx, type: typeToReturn.toString() });
          console.log(
            `[visitIdentifier] EXIT: Returning non-nullary constructor function type: ${typeToReturn.toString()}`
          );
          return typeToReturn; // Return FunctionType like (T) => Option<T>, potentially instantiated
        }
      } else {
        // Should not happen based on how constructors are defined (they should always have FunctionType)
        const errorMsg = `Internal Error: Constructor ${identifierName} has unexpected type structure: ${originalConstructorType}`;
        console.error(`[visitIdentifier] ERROR: ${errorMsg}`);
        this.reportError(errorMsg, ctx);
        this.hints.push({ context: ctx, type: UnknownType.toString() });
        console.log(`[visitIdentifier] EXIT (error)`);
        return UnknownType;
      }
      // --- END NEW LOGIC ---
    }

    // 3. Not found in environment or as a constructor
    const errorMsg = `Identifier '${identifierName}' is not defined.`;
    console.error(`[visitIdentifier] ERROR: ${errorMsg}`);
    this.reportError(errorMsg, ctx);
    this.hints.push({ context: ctx, type: UnknownType.toString() });
    console.log(`[visitIdentifier] EXIT (error)`);
    return UnknownType;
  }

  visitLiteral(ctx: parser.LiteralContext): ChicoryType {
    // Basic logging can be added here if needed
    const content = ctx.getText();
    if (content === "true" || content === "false") {
      return BooleanType;
    } else if (Number.isFinite(Number(content))) {
      return NumberType;
    } else {
      return StringType;
    }

    throw new Error(`Unknown literal type: ${content}`);
    // Add unit literal handling if needed
    return UnknownType;
  }

  visitRecordExpr(ctx: parser.RecordExprContext): ChicoryType {
    const fields = new Map<string, ChicoryType>();
    ctx.recordKvExpr().forEach((kv) => {
      const key = kv.IDENTIFIER().getText();
      const valueType = this.visitExpr(kv.expr());
      fields.set(key, valueType);
    });

    // Add a hint for debugging
    const recordType = new RecordType(fields);
    this.hints.push({ context: ctx, type: recordType.toString() });

    return recordType;
  }

  visitArrayLikeExpr(ctx: parser.ArrayLikeExprContext): ChicoryType {
    const elementExprs = ctx.expr(); // Get all expression contexts
    if (elementExprs.length === 0) {
      // It doesn't make sense to assume an empty tuple, since they have a fixed number of elements.
      // So, defaulting to ArrayType<Unknown>.
      // Unification might resolve Unknown later if assigned or used.
      const emptyArrayType = new ArrayType(UnknownType); // Default empty array to Array<unknown>
      this.hints.push({
        context: ctx,
        type: emptyArrayType.toString(),
      });
      return emptyArrayType;
      // Alternative: Default to ArrayType<UnknownType>
      // return new ArrayType(UnknownType);
    }

    const elementTypes = elementExprs.map((exprCtx) => this.visitExpr(exprCtx));

    // Use a *local* substitution for checking homogeneity within this literal
    const localSubstitution: SubstitutionMap = new Map(); // Map<string, ChicoryType>();
    let unifiedElementType: ChicoryType | Error = this.applySubstitution(
      elementTypes[0],
      this.currentSubstitution
    ); // Start with the first element's type (after outer sub)

    let isPotentiallyHomogeneous = true;

    for (let i = 1; i < elementTypes.length; i++) {
      let currentElementType = this.applySubstitution(
        elementTypes[i],
        this.currentSubstitution
      ); // Apply outer sub

      // Try to unify the current element type with the unified type *so far* using the local substitution
      const unificationResult = this.unify(
        unifiedElementType,
        currentElementType,
        localSubstitution
      );

      if (unificationResult instanceof Error) {
        // If unification fails *at any point*, it cannot be homogeneous. Treat as Tuple.
        isPotentiallyHomogeneous = false;
        this.hints.push({
          context: ctx.expr(i)!,
          type: currentElementType.toString(),
          // message: `Element type ${currentElementType} differs from previous elements, treating as Tuple.`
        });
        // Don't break, collect all types for the tuple.
      } else {
        // Unification succeeded, update the potential unified type *based on the result*
        unifiedElementType = unificationResult;
      }
    }

    // Apply the *local* substitutions gathered during the loop to the final unified type
    if (isPotentiallyHomogeneous && !(unifiedElementType instanceof Error)) {
      unifiedElementType = this.applySubstitution(
        unifiedElementType,
        localSubstitution
      );

      // Merge local substitutions relevant to the element type back into the main substitution
      // Be careful here to avoid unintended side effects. Only merge if necessary for outer inference.
      // For now, we primarily care about the resulting ArrayType.
      // Example: If unifiedElementType became 'number' from 'T', and 'T' was unified with 'number' locally,
      // this knowledge might be useful outside.

      // REMOVED: Merging local substitutions into the main one
      // for (const [varName, type] of localSubstitution.entries()) {
      //   // Check if the variable exists outside or if the substitution provides new info
      //   // Simple merge for now:
      //   this.currentSubstitution.set(varName, type);
      // }

      // All elements unified successfully. Treat as Array.
      const arrayType = new ArrayType(unifiedElementType);
      this.hints.push({ context: ctx, type: arrayType.toString() });
      return arrayType;
    } else {
      // Elements had different types or unification failed. Treat as Tuple.
      // Apply the main substitution to all original element types for the tuple definition.
      const tupleElementTypes = elementTypes.map((t) =>
        this.applySubstitution(t, this.currentSubstitution)
      );
      const tupleType = new TupleType(tupleElementTypes);
      this.hints.push({ context: ctx, type: tupleType.toString() });
      return tupleType;
    }
  }

  visitBlockExpr(ctx: parser.BlockExprContext): ChicoryType {
    this.environment = this.environment.pushScope(); // Push a new scope
    ctx.stmt().forEach((stmt) => this.visitStmt(stmt));
    const blockType = this.visitExpr(ctx.expr());
    this.environment = this.environment.popScope()!; // Pop the scope
    return blockType;
  }

  visitIfExpr(ctx: parser.IfExprContext): ChicoryType {
    const conditionType = this.visitExpr(ctx.justIfExpr()[0].expr()[0]);

    // Try to unify condition with BooleanType
    if (conditionType instanceof TypeVariable) {
      const result = this.unify(
        conditionType,
        BooleanType,
        this.currentSubstitution
      );
      if (result instanceof Error) {
        this.reportError(
          `Condition of if expression must be boolean, but got '${conditionType}'`,
          ctx.justIfExpr()[0].expr()[0]
        );
      }
    } else if (conditionType !== BooleanType) {
      this.reportError(
        `Condition of if expression must be boolean, but got '${conditionType}'`,
        ctx.justIfExpr()[0].expr()[0]
      );
    }

    const thenType = this.visitExpr(ctx.justIfExpr()[0].expr()[1]);

    // Check 'else if' branches
    for (let i = 1; i < ctx.justIfExpr().length; i++) {
      const elseIfConditionType = this.visitExpr(ctx.justIfExpr()[i].expr()[0]);

      // Try to unify condition with BooleanType
      if (elseIfConditionType instanceof TypeVariable) {
        const result = this.unify(
          elseIfConditionType,
          BooleanType,
          this.currentSubstitution
        );
        if (result instanceof Error) {
          this.reportError(
            `Condition of else if expression must be boolean, but got '${elseIfConditionType}'`,
            ctx.justIfExpr()[i].expr()[0]
          );
        }
      } else if (elseIfConditionType !== BooleanType) {
        this.reportError(
          `Condition of else if expression must be boolean, but got '${elseIfConditionType}'`,
          ctx.justIfExpr()[i].expr()[0]
        );
      }

      // Note: We are not requiring same types for all branches
      this.visitExpr(ctx.justIfExpr()[i].expr()[1]);
    }

    if (ctx.expr()) {
      // Note: We are not requiring same types
      return this.visitExpr(ctx.expr()!);
    }

    return thenType;
  }

  visitFuncExpr(ctx: parser.FuncExprContext): ChicoryType {
    // Save the current substitution
    const outerSubstitution = new Map(this.currentSubstitution);
    // Create a fresh substitution for this function
    this.currentSubstitution = new Map();

    this.environment = this.environment.pushScope(); // Push a new scope for function parameters

    const paramTypes: ChicoryType[] = [];
    if (
      ctx instanceof parser.ParenFunctionExpressionContext &&
      ctx.parameterList()
    ) {
      ctx
        .parameterList()!
        .IDENTIFIER()
        .forEach((param) => {
          const paramName = param.getText();
          // Create a fresh type variable for each parameter
          const typeVar = this.newTypeVar();
          this.environment.declare(paramName, typeVar, ctx, (str) =>
            this.reportError(str, ctx)
          );
          paramTypes.push(typeVar);
        });
    } else if (ctx instanceof parser.ParenlessFunctionExpressionContext) {
      const paramName = ctx.IDENTIFIER().getText();
      const typeVar = this.newTypeVar();
      this.environment.declare(paramName, typeVar, ctx, (str) =>
        this.reportError(str, ctx)
      );
      paramTypes.push(typeVar);
    }

    // This could be either kind, but both have `.expr`
    const returnType = this.visitExpr(
      (ctx as parser.ParenExpressionContext).expr()
    );

    // Apply the accumulated substitutions to parameter types and return type
    const inferredParamTypes = paramTypes.map((type) =>
      this.applySubstitution(type, this.currentSubstitution)
    );
    const inferredReturnType = this.applySubstitution(
      returnType,
      this.currentSubstitution
    );

    this.environment = this.environment.popScope()!; // Pop the function scope

    // Restore the outer substitution
    this.currentSubstitution = outerSubstitution;

    return new FunctionType(inferredParamTypes, inferredReturnType);
  }

  visitCallExpr(
    ctx: parser.CallExprContext,
    functionType: ChicoryType // This is the type of the expression being called
  ): ChicoryType {
    const callSiteText = ctx.parent?.getText() ?? ctx.getText(); // Try to get more context
    const callContext = callSiteText.substring(0, 40); // Limit context length
    console.log(`[visitCallExpr] ENTER: Context ~ "${callContext}..."`);
    console.log(
      `  functionType (raw): ${functionType.toString()} (${
        functionType.constructor.name
      })`
    );
    console.log(
      `  currentSubstitution (before call):`,
      new Map(this.currentSubstitution)
    );

    // Apply *outer* substitutions to the function type *before* doing anything else.
    // This resolves any type variables bound *outside* the function call itself.
    const substitutedFunctionType = this.applySubstitution(
      functionType,
      this.currentSubstitution // Use the substitution context from *before* this call
    );
    console.log(
      `  functionType (substituted): ${substitutedFunctionType.toString()} (${
        substitutedFunctionType.constructor.name
      })`
    );

    // Check if it's actually a function type after substitution
    if (!(substitutedFunctionType instanceof FunctionType)) {
      const errorMsg = `Cannot call a non-function type: '${substitutedFunctionType}'`;
      console.error(`[visitCallExpr] ERROR: ${errorMsg}`);
      this.reportError(errorMsg, ctx);
      // Store UnknownType for this expression node before returning
      this.setExpressionType(ctx, UnknownType);
      this.hints.push({ context: ctx, type: UnknownType.toString() });
      console.log(`[visitCallExpr] EXIT (error)`);
      return UnknownType;
    }

    // It IS a FunctionType, proceed.
    const funcType = substitutedFunctionType as FunctionType;
    console.log(`  Function signature: ${funcType.toString()}`);

    // Type check arguments in the current context.
    // visitExpr uses/updates this.currentSubstitution internally for argument inference.
    console.log(`  > Visiting arguments...`);
    const argumentTypes = ctx.expr()
      ? ctx.expr().map((expr, i) => {
          console.log(`    > Visiting arg ${i + 1}: ${expr.getText()}`);
          const argType = this.visitExpr(expr);
          console.log(`    > Arg ${i + 1} type (raw): ${argType.toString()}`);
          return argType;
        })
      : [];
    console.log(`  > Finished visiting arguments.`);
    console.log(
      `  currentSubstitution (after visiting args):`,
      new Map(this.currentSubstitution)
    );

    // Apply current substitutions to argument types as well, as visitExpr might have updated them.
    const substitutedArgumentTypes = argumentTypes.map((argType, i) => {
      const substArgType = this.applySubstitution(
        argType,
        this.currentSubstitution
      );
      console.log(
        `  > Arg ${i + 1} type (substituted): ${substArgType.toString()}`
      );
      return substArgType;
    });

    // Create a FRESH substitution map specific to *this function call*.
    // This map will capture how type variables *within* the function signature
    // are unified with the provided arguments.
    const callSubstitution: SubstitutionMap = new Map();
    console.log(
      `  > Initializing callSubstitution (empty):`,
      new Map(callSubstitution)
    );

    // Check arity (number of arguments)
    if (substitutedArgumentTypes.length !== funcType.paramTypes.length) {
      const errorMsg = `Expected ${funcType.paramTypes.length} arguments, but got ${substitutedArgumentTypes.length}`;
      console.error(`[visitCallExpr] ERROR: ${errorMsg}`);
      this.reportError(errorMsg, ctx);
      // Store UnknownType and return early on arity mismatch
      this.setExpressionType(ctx, UnknownType);
      this.hints.push({ context: ctx, type: UnknownType.toString() });
      console.log(`[visitCallExpr] EXIT (error)`);
      return UnknownType;
    }

    // Unify arguments with parameters using the call-specific substitution map (`callSubstitution`).
    console.log(`  > Unifying arguments with parameters...`);
    let unificationOk = true;
    for (let i = 0; i < substitutedArgumentTypes.length; i++) {
      const paramType = funcType.paramTypes[i];
      const argType = substitutedArgumentTypes[i];
      console.log(
        `    > Unifying param ${i + 1} ('${paramType}') with arg ${
          i + 1
        } ('${argType}')`
      );
      // Unify the function's parameter type with the (substituted) argument type.
      // The substitution map `callSubstitution` is updated by `unify`.
      const result = this.unify(
        paramType, // Parameter type from the (potentially substituted) function signature
        argType, // Argument type resolved in the current context
        callSubstitution // Update this map with bindings for type vars in funcType.paramTypes
      );
      if (result instanceof Error) {
        unificationOk = false;
        const errorMsg = `Argument ${
          i + 1
        } type mismatch: Cannot unify parameter type '${paramType}' with argument type '${argType}'. ${
          result.message
        }`;
        console.error(`[visitCallExpr] ERROR: ${errorMsg}`);
        this.reportError(
          errorMsg,
          ctx.expr(i)! // Report error on the specific argument
        );
        // Continue checking other args even if one fails, to report all mismatches
      } else {
        console.log(
          `    > Unification ${
            i + 1
          } successful. Resulting type: ${result.toString()}`
        );
        console.log(
          `    > callSubstitution (after arg ${i + 1}):`,
          new Map(callSubstitution)
        );
      }
    }

    // If any argument unification failed, the result type is Unknown
    if (!unificationOk) {
      console.error(`[visitCallExpr] ERROR: Argument unification failed.`);
      this.setExpressionType(ctx, UnknownType);
      this.hints.push({ context: ctx, type: UnknownType.toString() });
      console.log(`[visitCallExpr] EXIT (error)`);
      return UnknownType;
    }

    console.log(`  > Argument unification successful.`);
    console.log(`  > Final callSubstitution:`, new Map(callSubstitution));

    // Calculate the final return type by applying the call-specific substitution (`callSubstitution`)
    // to the function's declared return type.
    console.log(
      `  > Calculating final return type from '${funcType.returnType.toString()}' using callSubstitution.`
    );
    let finalReturnType = this.applySubstitution(
      funcType.returnType,
      callSubstitution
    );
    console.log(
      `  > Final return type (before constructor check): ${finalReturnType.toString()}`
    );

    // --- Special Handling for Generic Constructors ---
    // If this was a call to a generic ADT constructor (like Some<T>),
    // ensure the resulting type is correctly represented as GenericType<ConcreteArg(s)>.
    if (funcType.constructorName && finalReturnType instanceof AdtType) {
      console.log(
        `  > Handling potential generic constructor call: ${funcType.constructorName}`
      );
      const constructorDef = this.constructors.find(
        (c) => c.name === funcType.constructorName
      );
      const adtDef = constructorDef
        ? this.environment.getType(constructorDef.adtName)
        : null;
      console.log(`    > Constructor Def: ${constructorDef?.name}`);
      console.log(`    > ADT Def: ${adtDef ? adtDef.toString() : "null"}`);

      // Check if the ADT definition is indeed generic
      if (adtDef instanceof GenericType && adtDef.typeArguments.length > 0) {
        console.log(`    > ADT definition is generic: ${adtDef.toString()}`);
        // Resolve the ADT's type parameters (e.g., 'T' in Option<T>)
        // using the `callSubstitution` derived from the arguments.
        console.log(
          `    > Resolving concrete type arguments using callSubstitution:`,
          new Map(callSubstitution)
        );
        const concreteArgs = adtDef.typeArguments.map((typeVar, i) => {
          console.log(
            `      > Resolving ADT param ${i}: ${typeVar.toString()}`
          );
          if (typeVar instanceof TypeVariable) {
            // Apply substitution recursively in case a type var maps to another type var etc.
            const resolvedArg = this.applySubstitution(
              typeVar,
              callSubstitution
            );
            console.log(
              `      > Resolved ADT param ${i} ('${
                typeVar.name
              }') to: ${resolvedArg.toString()}`
            );
            return resolvedArg;
          }
          // Should not happen for ADT def params, but return as is if not a TypeVariable
          console.log(
            `      > ADT param ${i} is not a TypeVariable, using as is: ${typeVar.toString()}`
          );
          return typeVar;
        });
        console.log(
          `    > Concrete arguments resolved: [${concreteArgs
            .map((a) => a.toString())
            .join(", ")}]`
        );

        // Check if all type variables were successfully resolved to concrete types
        if (concreteArgs.some((arg) => arg instanceof TypeVariable)) {
          // This indicates incomplete inference or an error.
          console.warn(
            `[visitCallExpr] Could not fully resolve type arguments for generic constructor ${
              funcType.constructorName
            }. Result: ${finalReturnType}, Inferred Args: [${concreteArgs
              .map((a) => a.toString())
              .join(", ")}]`
          );
          // Report an error? Or return partially resolved type? Let's return the GenericType with unresolved vars for now.
          finalReturnType = new GenericType(adtDef.name, concreteArgs);
          console.log(
            `    > Final return type (partially resolved): ${finalReturnType.toString()}`
          );
          // Optionally report an error:
          // this.reportError(`Could not infer all type arguments for generic constructor ${funcType.constructorName}`, ctx);
          // finalReturnType = UnknownType;
        } else {
          // Successfully resolved all type arguments. Create the concrete GenericType instance.
          finalReturnType = new GenericType(adtDef.name, concreteArgs);
          console.log(
            `    > Resolved generic constructor call ${funcType.constructorName} to concrete type: ${finalReturnType}`
          );
        }
      } else {
        console.log(
          `    > ADT definition is not generic or has no type arguments. No special handling needed.`
        );
      }
      // If adtDef wasn't GenericType or had no type arguments, finalReturnType remains as calculated before (likely AdtType).
    } else {
      console.log(
        `  > Not a constructor call or return type is not AdtType. No special handling needed.`
      );
    }
    // --- End Special Handling ---

    // Store and add hint for the final, calculated return type
    console.log(
      `  > Storing final return type for expression: ${finalReturnType.toString()}`
    );
    this.setExpressionType(ctx, finalReturnType);
    this.hints.push({ context: ctx, type: finalReturnType.toString() });

    console.log(
      `[visitCallExpr] EXIT: Returning final type: ${finalReturnType.toString()}`
    );
    return finalReturnType; // Keep existing return
  }

  // --- BEGIN REFACTORED visitMatchExpr ---
  visitMatchExpr(ctx: parser.MatchExprContext): ChicoryType {
    const matchedExprCtx = ctx.expr();
    const matchedType = this.visitExpr(matchedExprCtx);
    const appliedMatchedType = this.applySubstitution(
      matchedType,
      this.currentSubstitution
    );

    console.log(
      `[visitMatchExpr] Start. Matched type: ${appliedMatchedType.toString()}`
    );

    // --- Coverage Tracking Setup ---
    const coverage = this.initializeCoverage(appliedMatchedType, ctx);
    let returnTypes: ChicoryType[] = [];
    let firstArmType: ChicoryType | null = null;

    // --- Process Arms ---
    for (let i = 0; i < ctx.matchArm().length; i++) {
      const arm = ctx.matchArm(i)!;
      const armPatternCtx = arm.matchPattern();

      this.environment = this.environment.pushScope();

      // 1. Analyze Pattern and Check Reachability
      const patternInfo = this.analyzePattern(
        armPatternCtx,
        appliedMatchedType
      );
      console.log(
        `[visitMatchExpr] Arm ${i}: Pattern='${armPatternCtx.getText()}', Info=${JSON.stringify(
          patternInfo
        )}`
      );

      const isReachable = this.checkReachabilityAndRecordCoverage(
        patternInfo,
        coverage,
        armPatternCtx
      );

      if (!isReachable) {
        // Error already reported by checkReachabilityAndRecordCoverage
        // We still need to type-check the arm's expression for other errors,
        // but its return type won't affect the overall match type.
        console.log(
          `[visitMatchExpr] Arm ${i} is unreachable. Skipping return type unification.`
        );
        this.visitPattern(armPatternCtx, appliedMatchedType); // Bind variables etc.
        this.visitExpr(arm.expr()); // Type check expression
        this.environment = this.environment.popScope();
        continue; // Skip return type unification for unreachable arms
      }

      // 2. Type Check Pattern (bind variables)
      this.visitPattern(armPatternCtx, appliedMatchedType);

      // 3. Type Check Arm Expression
      const armReturnType = this.visitExpr(arm.expr());
      const appliedArmReturnType = this.applySubstitution(
        armReturnType,
        this.currentSubstitution
      );
      returnTypes.push(appliedArmReturnType); // Store for unification

      // 4. Unify Return Types (Incremental)
      if (firstArmType === null) {
        firstArmType = appliedArmReturnType;
      } else {
        const unificationResult = this.unify(
          firstArmType,
          appliedArmReturnType,
          this.currentSubstitution
        );
        if (unificationResult instanceof Error) {
          this.reportError(
            `Match arms must return compatible types. Expected '${firstArmType}', found '${appliedArmReturnType}'. ${unificationResult.message}`,
            arm.expr()
          );
          firstArmType = UnknownType; // Set to Unknown on mismatch
          // Don't break, continue checking other arms against the original firstArmType or Unknown
        } else {
          // Unification might refine the type
          firstArmType = this.applySubstitution(
            unificationResult,
            this.currentSubstitution
          );
        }
      }

      this.environment = this.environment.popScope();
    } // End loop through arms

    // --- Final Exhaustiveness Check ---
    this.checkExhaustiveness(coverage, appliedMatchedType, ctx);

    // --- Determine Final Type ---
    let finalArmType = firstArmType ?? UnknownType; // Use firstArmType if valid, else Unknown
    if (returnTypes.length === 0) {
      this.reportError("Match expression has no arms.", ctx);
      finalArmType = UnknownType;
    }

    // Apply final substitutions
    finalArmType = this.applySubstitution(
      finalArmType,
      this.currentSubstitution
    );
    this.hints.push({ context: ctx, type: finalArmType.toString() });
    console.log(`[visitMatchExpr] End. Final type: ${finalArmType.toString()}`);
    return finalArmType;
  }
  // --- END REFACTORED visitMatchExpr ---

  // --- BEGIN NEW HELPER METHODS for Match Expression ---

  private initializeCoverage(
    matchedType: ChicoryType,
    ctx: parser.MatchExprContext
  ): MatchCoverage {
    const coverage: MatchCoverage = {
      type: "other",
      wildcardOrParamSeen: false,
      processedPatterns: new Set(),
    };

    if (matchedType instanceof GenericType || matchedType instanceof AdtType) {
      const adtName = matchedType.name;
      let variants: string[] | null = null;

      if (adtName === "Option") variants = ["Some", "None"];
      else if (adtName === "Result") variants = ["Ok", "Err"];
      else {
        const constructors = this.constructors.filter(
          (c) => c.adtName === adtName
        );
        if (constructors.length > 0) {
          variants = constructors.map((c) => c.name);
        }
      }

      if (variants) {
        coverage.type = "adt";
        coverage.adtName = adtName;
        coverage.remainingVariants = new Set(variants);
        coverage.partiallyCoveredVariants = new Set();
      } else {
        console.warn(
          `[initializeCoverage] Type '${adtName}' looks like an ADT but no constructors found.`
        );
        // Treat as 'other' for coverage purposes if constructors aren't found
      }
    } else if (matchedType === StringType) {
      coverage.type = "string";
    } else if (matchedType === NumberType) {
      coverage.type = "number";
    } else if (matchedType === BooleanType) {
      coverage.type = "boolean";
      coverage.trueCovered = false;
      coverage.falseCovered = false;
    }

    console.log(`[initializeCoverage] Initialized coverage:`, coverage);
    return coverage;
  }

  private analyzePattern(
    ctx: parser.MatchPatternContext,
    matchedType: ChicoryType // Pass matched type for context if needed
  ): PatternInfo {
    const patternString = ctx.getText(); // Basic unique representation

    if (ctx instanceof parser.AdtWithParamMatchPatternContext) {
      // Pattern like Some(x)
      return {
        type: "adt_param",
        variantName: ctx.IDENTIFIER()[0].getText(),
        patternString: `${ctx.IDENTIFIER()[0].getText()}(param)`, // Canonical string
      };
    } else if (ctx instanceof parser.AdtWithWildcardMatchPatternContext) {
      // Pattern like Some(_)
      return {
        type: "adt_wildcard",
        variantName: ctx.IDENTIFIER().getText(),
        patternString: `${ctx.IDENTIFIER().getText()}(_)`, // Canonical string
      };
    } else if (ctx instanceof parser.AdtWithLiteralMatchPatternContext) {
      // Pattern like Some(1) or Some("hi")
      const literalCtx = ctx.literal();
      let literalValue: string | number | boolean = literalCtx.getText();
      if (literalCtx instanceof parser.NumberLiteralContext)
        literalValue = parseFloat(literalValue);
      if (literalCtx instanceof parser.BooleanLiteralContext)
        literalValue = literalValue === "true";
      return {
        type: "adt_literal",
        variantName: ctx.IDENTIFIER().getText(),
        literalValue: literalValue,
        patternString: `${ctx.IDENTIFIER().getText()}(${literalCtx.getText()})`, // Use literal text
      };
    } else if (ctx instanceof parser.BareAdtOrVariableMatchPatternContext) {
      const idName = ctx.IDENTIFIER().getText();
      let isBareAdt = false;
      if (
        matchedType instanceof AdtType ||
        matchedType instanceof GenericType
      ) {
        const constructor = this.constructors.find(
          (c) => c.adtName === matchedType.name && c.name === idName
        );
        // Check if it's a *nullary* constructor
        if (
          constructor &&
          constructor.type instanceof FunctionType &&
          constructor.type.paramTypes.length === 0
        ) {
          // Pattern like None
          return {
            type: "adt_bare",
            variantName: idName,
            patternString: idName, // Bare name is unique string
          };
        }
      }
      if (!isBareAdt) {
        console.log(
          `[analyzePattern] Treating identifier '${idName}' as a variable pattern.`
        );
        return { type: "variable", patternString: "var" }; // Canonical string for variable pattern
      }
    } else if (ctx instanceof parser.LiteralMatchPatternContext) {
      // Pattern like 1 or "hi" or true
      const literalCtx = ctx.literal();
      let literalValue: string | number | boolean = literalCtx.getText();
      if (literalCtx instanceof parser.NumberLiteralContext)
        literalValue = parseFloat(literalValue);
      if (literalCtx instanceof parser.BooleanLiteralContext)
        literalValue = literalValue === "true";
      return {
        type: "literal",
        literalValue: literalValue,
        patternString: literalCtx.getText(), // Literal text is unique string
      };
    } else if (ctx instanceof parser.WildcardMatchPatternContext) {
      // Pattern _
      return { type: "wildcard", patternString: "_" };
    }

    console.warn(`[analyzePattern] Unknown pattern type: ${patternString}`);
    return { type: "unknown", patternString };
  }

  private checkReachabilityAndRecordCoverage(
    patternInfo: PatternInfo,
    coverage: MatchCoverage,
    ctx: parser.MatchPatternContext
  ): boolean {
    let isReachable = true;
    const patternString = patternInfo.patternString; // Use the canonical string

    // --- Simple Duplicate Check ---
    // This catches identical literals, bare ADTs, or canonical wildcards/params
    if (coverage.processedPatterns?.has(patternString)) {
      this.reportError(
        `Unreachable pattern: '${ctx.getText()}' is already covered.`,
        ctx
      );
      return false;
      // Don't return yet, still need to update coverage state potentially
    }
    coverage.processedPatterns?.add(patternString);

    // --- Type-Specific Reachability and Coverage Update ---
    switch (coverage.type) {
      case "adt":
        if (!coverage.remainingVariants) break; // Should not happen

        const variantName = patternInfo.variantName;
        if (!variantName) {
          // This pattern doesn't target a specific variant (e.g., _, variable, literal)
          if (
            patternInfo.type === "wildcard" ||
            patternInfo.type === "variable"
          ) {
            if (coverage.wildcardOrParamSeen) {
              // Already covered by a previous wildcard/param
              this.reportError(
                `Unreachable pattern: '${ctx.getText()}' is covered by a previous wildcard or variable pattern.`,
                ctx
              );
              isReachable = false;
            }
            coverage.remainingVariants.clear(); // Covers everything
            coverage.wildcardOrParamSeen = true;
          } else if (patternInfo.type === "literal") {
            if (coverage.wildcardOrParamSeen) {
              // Already covered by wildcard/param
              this.reportError(
                `Unreachable pattern: Literal '${ctx.getText()}' is covered by a previous wildcard or variable pattern.`,
                ctx
              );
              isReachable = false;
            }
            // Literals don't affect ADT variant coverage directly
          }
          break; // Exit ADT handling for non-variant patterns
        }

        // Pattern targets a specific variant (adt_param, adt_wildcard, adt_literal, adt_bare)
        const isFullyCovered = !coverage.remainingVariants.has(variantName);

        if (
          patternInfo.type === "adt_param" ||
          patternInfo.type === "adt_wildcard" ||
          patternInfo.type === "adt_bare"
        ) {
          // These patterns fully cover the variant
          if (isFullyCovered) {
            this.reportError(
              `Unreachable pattern: Variant '${variantName}' is already fully covered.`,
              ctx
            );
            isReachable = false;
          }
          coverage.remainingVariants.delete(variantName);
          coverage.partiallyCoveredVariants?.delete(variantName); // Remove from partial if now fully covered
          coverage.wildcardOrParamSeen = coverage.remainingVariants.size === 0; // Check if this covers the last variant
        } else if (patternInfo.type === "adt_literal") {
          // Literal pattern only partially covers
          if (isFullyCovered) {
            this.reportError(
              `Unreachable pattern: Variant '${variantName}' is already fully covered, making literal match '${ctx.getText()}' unreachable.`,
              ctx
            );
            isReachable = false;
          }
          coverage.partiallyCoveredVariants?.add(variantName);
          // Does NOT remove from remainingVariants
        }
        break;

      case "string":
      case "number":
      case "other": // Treat 'other' like string/number for wildcard/param coverage
        if (
          patternInfo.type === "wildcard" ||
          patternInfo.type === "variable"
        ) {
          if (coverage.wildcardOrParamSeen) {
            this.reportError(
              `Unreachable pattern: '${ctx.getText()}' is covered by a previous wildcard or variable pattern.`,
              ctx
            );
            isReachable = false;
          }
          coverage.wildcardOrParamSeen = true;
        } else if (
          patternInfo.type === "literal" ||
          patternInfo.type.startsWith("adt_")
        ) {
          // Literals or ADT checks within a string/number match context
          if (coverage.wildcardOrParamSeen) {
            this.reportError(
              `Unreachable pattern: '${ctx.getText()}' is covered by a previous wildcard or variable pattern.`,
              ctx
            );
            isReachable = false;
          }
          // Literals don't mark string/number as fully covered
        }
        break;

      case "boolean":
        if (
          patternInfo.type === "wildcard" ||
          patternInfo.type === "variable"
        ) {
          if (
            coverage.wildcardOrParamSeen ||
            (coverage.trueCovered && coverage.falseCovered)
          ) {
            this.reportError(
              `Unreachable pattern: '${ctx.getText()}' is covered by previous patterns.`,
              ctx
            );
            isReachable = false;
          }
          coverage.wildcardOrParamSeen = true;
          coverage.trueCovered = true;
          coverage.falseCovered = true;
        } else if (patternInfo.type === "literal") {
          if (coverage.wildcardOrParamSeen) {
            this.reportError(
              `Unreachable pattern: Literal '${ctx.getText()}' is covered by a previous wildcard or variable pattern.`,
              ctx
            );
            isReachable = false;
          }
          if (patternInfo.literalValue === true) {
            if (coverage.trueCovered) {
              this.reportError(
                `Unreachable pattern: 'true' is already covered.`,
                ctx
              );
              isReachable = false;
            }
            coverage.trueCovered = true;
          } else if (patternInfo.literalValue === false) {
            if (coverage.falseCovered) {
              this.reportError(
                `Unreachable pattern: 'false' is already covered.`,
                ctx
              );
              isReachable = false;
            }
            coverage.falseCovered = true;
          }
          // Check if both are now covered
          if (coverage.trueCovered && coverage.falseCovered) {
            coverage.wildcardOrParamSeen = true;
          }
        } else if (patternInfo.type.startsWith("adt_")) {
          // ADT checks within a boolean match context
          if (coverage.wildcardOrParamSeen) {
            this.reportError(
              `Unreachable pattern: '${ctx.getText()}' is covered by previous patterns.`,
              ctx
            );
            isReachable = false;
          }
          // ADT patterns don't mark boolean as covered
        }
        break;
    }

    console.log(
      `[checkReachability] Reachable=${isReachable}, Updated Coverage=`,
      coverage
    );
    return isReachable;
  }

  private checkExhaustiveness(
    coverage: MatchCoverage,
    matchedType: ChicoryType,
    ctx: parser.MatchExprContext // For reporting error context
  ): void {
    let isExhaustive = true;
    let errorMessage = "";

    switch (coverage.type) {
      case "adt":
        if (coverage.remainingVariants && coverage.remainingVariants.size > 0) {
          isExhaustive = false;
          errorMessage = `Match expression on type '${
            coverage.adtName
          }' is not exhaustive. Missing cases: ${Array.from(
            coverage.remainingVariants
          ).join(", ")}`;
        }
        break;
      case "string":
      case "number":
      case "other":
        if (!coverage.wildcardOrParamSeen) {
          isExhaustive = false;
          errorMessage = `Match expression on type '${matchedType.toString()}' must be exhaustive. Add a wildcard pattern '_' or a variable pattern to handle all possible values.`;
        }
        break;
      case "boolean":
        if (
          !coverage.wildcardOrParamSeen &&
          (!coverage.trueCovered || !coverage.falseCovered)
        ) {
          isExhaustive = false;
          const missing: string[] = [];
          if (!coverage.trueCovered) missing.push("'true'");
          if (!coverage.falseCovered) missing.push("'false'");
          errorMessage = `Match expression on type 'boolean' is not exhaustive. Missing cases: ${missing.join(
            " and "
          )}.`;
        }
        break;
    }

    if (!isExhaustive) {
      console.log(`[checkExhaustiveness] Non-exhaustive match detected.`);
      this.reportError(errorMessage, ctx);
    } else {
      console.log(`[checkExhaustiveness] Match is exhaustive.`);
    }
  }

  // --- END NEW HELPER METHODS ---

  visitMatchArm(
    ctx: parser.MatchArmContext,
    matchedType: ChicoryType,
    addCase: (str: string) => void
  ): ChicoryType {
    this.environment = this.environment.pushScope();
    this.visitPattern(ctx.matchPattern(), matchedType); // Check pattern and declare any variables
    const armExprType = this.visitExpr(ctx.expr());
    this.environment = this.environment.popScope();
    return armExprType;
  }

  visitPattern(
    ctx: parser.MatchPatternContext,
    matchedType: ChicoryType
    // Removed addCase parameter
  ): void {
    // Apply substitution to matchedType *before* checking its instance type
    matchedType = this.applySubstitution(matchedType, this.currentSubstitution); // Use main substitution

    if (matchedType === UnknownType) {
      console.warn(
        `[visitPattern] Checking pattern '${ctx.getText()}' against 'unknown' type. Type checking may be incomplete.`
      );
      // Allow pattern matching to proceed, but don't perform type unification checks.
      // Just declare variables (if any) as UnknownType.
      if (ctx.ruleContext instanceof parser.AdtWithParamMatchPatternContext) {
        const paramName = (ctx as parser.AdtWithParamMatchPatternContext)
          .IDENTIFIER()[1]
          .getText();
        this.environment.declare(paramName, UnknownType, ctx, (str) =>
          this.reportError(str, ctx)
        );
        this.hints.push({ context: ctx, type: UnknownType.toString() });
      }
      // Add similar handling for other patterns that bind variables.
      // addCase(ctx.getText()); // Removed call
      return; // Skip further type checks for this pattern
    }

    console.log(
      `[visitPattern] Checking pattern '${ctx.getText()}' against matched type '${matchedType}'`
    ); // Debug

    // --- AdtWithParamMatchPatternContext ---
    if (ctx.ruleContext instanceof parser.AdtWithParamMatchPatternContext) {
      const [adtName, paramName] = (
        ctx as parser.AdtWithParamMatchPatternContext
      )
        .IDENTIFIER()
        .map((id) => id.getText());
      // addCase(`${adtName}(*)`); // Removed call
      console.log(
        `[visitPattern] Checking pattern (ADT with param): ${adtName}(${paramName})`
      );

      let baseTypeName: string | null = null;
      // ... (logic to determine baseTypeName from matchedType) ...
      if (
        matchedType instanceof AdtType ||
        matchedType instanceof GenericType
      ) {
        baseTypeName = matchedType.name;
      } else if (matchedType instanceof TypeVariable) {
        // ... (handle TypeVariable case - declare param as Unknown or fresh var) ...
        this.environment.declare(paramName, UnknownType, ctx, (str) =>
          this.reportError(str, ctx)
        );
        this.hints.push({ context: ctx, type: UnknownType.toString() });
        console.warn(
          `[visitPattern] Cannot fully verify pattern ${adtName}(${paramName}) against unknown type ${matchedType}. Declaring ${paramName} as Unknown.`
        );
        return;
      } else {
        this.reportError(
          `Cannot match type '${matchedType}' against ADT pattern '${adtName}(${paramName})'`,
          ctx
        );
        return;
      }

      // ... (find constructor) ...
      const constructor = this.constructors.find(
        (c) => c.name === adtName && c.adtName === baseTypeName
      );
      if (!constructor) {
        /* ... report error ... */ return;
      }
      const constructorType = constructor.type;
      if (
        !(constructorType instanceof FunctionType) ||
        constructorType.paramTypes.length !== 1
      ) {
        /* ... report arity error ... */ return;
      }

      // --- Infer parameter type (using instantiation) ---
      let expectedParamType: ChicoryType = UnknownType;
      const originalParamType = constructorType.paramTypes[0];

      if (
        matchedType instanceof GenericType &&
        matchedType.typeArguments.length > 0 &&
        constructorType.returnType instanceof GenericType && // Constructor returns the generic ADT
        constructorType.returnType.typeArguments.length > 0
      ) {
        const instantiationSubst = new Map<string, ChicoryType>();
        const adtDefinition = this.environment.getType(baseTypeName); // Get Option<T> or Result<T, E> definition

        if (
          adtDefinition instanceof GenericType &&
          adtDefinition.typeArguments.length ===
            matchedType.typeArguments.length
        ) {
          // Build map: T -> concrete type from matchedType (e.g., T -> string for Option<string>)
          adtDefinition.typeArguments.forEach((typeVar, index) => {
            if (typeVar instanceof TypeVariable) {
              instantiationSubst.set(
                typeVar.name,
                matchedType.typeArguments[index]
              );
            }
          });
          // Apply this map to the constructor's parameter type (e.g., apply T->string to T in Some(T))
          expectedParamType = this.applySubstitution(
            originalParamType,
            instantiationSubst
          );
          console.log(
            `[visitPattern] Instantiated expected param type for ${adtName}(${paramName}) to ${expectedParamType}`
          );
        } else {
          console.warn(
            `[visitPattern] Mismatch between generic ADT definition and matched type instance for ${baseTypeName}. Falling back.`
          );
          expectedParamType = originalParamType; // Fallback
        }
      } else {
        // Not a generic instance match, or constructor doesn't use type vars in param
        expectedParamType = originalParamType;
      }

      // **** Crucial Change: Unify with a FRESH type variable representing the pattern's param ****
      // **** This allows the type to be constrained if needed, but doesn't force it immediately ****
      // **** The variable 'paramName' will hold this potentially refined type ****
      // const inferredParamType = this.newTypeVar(); // Create fresh var for the binding
      // const unificationResult = this.unify(expectedParamType, inferredParamType, this.currentSubstitution);

      // **** Alternative & Better: Directly use the expectedParamType, applying current subs ****
      // The type of the variable `paramName` IS the `expectedParamType` after applying substitutions
      // that might have occurred *before* this pattern was visited.
      const finalParamType = this.applySubstitution(
        expectedParamType,
        this.currentSubstitution
      );

      // **** This unification wasn't quite right. We don't unify expectedParamType with a new var.
      // **** We *declare* the pattern variable `paramName` with the calculated `finalParamType`.
      // **** Constraints happen when `paramName` is *used* in the arm's expression.

      // Declare the parameter variable in the arm's scope
      this.environment.declare(
        paramName,
        finalParamType,
        ctx,
        (
          str // Use finalParamType
        ) => this.reportError(str, ctx)
      );
      this.hints.push({ context: ctx, type: finalParamType.toString() });

      // --- AdtWithLiteralMatchPatternContext ---
    } else if (
      ctx.ruleContext instanceof parser.AdtWithLiteralMatchPatternContext
    ) {
      const adtName = (ctx as parser.AdtWithLiteralMatchPatternContext)
        .IDENTIFIER()
        .getText();
      const literalCtx = (
        ctx as parser.AdtWithLiteralMatchPatternContext
      ).literal();
      const literalType = this.visitLiteral(literalCtx);
      const literalValueStr = literalCtx.getText();
      // addCase(`${adtName}(*)`); // Removed call
      console.log(
        `[visitPattern] Checking pattern (ADT with literal): ${adtName}(${literalValueStr})`
      );

      let baseTypeName: string | null = null;
      // ... (logic to determine baseTypeName from matchedType) ...
      if (
        matchedType instanceof AdtType ||
        matchedType instanceof GenericType
      ) {
        baseTypeName = matchedType.name;
      } else if (matchedType instanceof TypeVariable) {
        console.warn(
          `[visitPattern] Cannot fully verify pattern ${adtName}(${literalValueStr}) against unknown type ${matchedType}.`
        );
        return; // Allow pattern but cannot fully check
      } else {
        this.reportError(
          `Cannot match type '${matchedType}' against ADT pattern '${adtName}(${literalValueStr})'`,
          ctx
        );
        return;
      }

      // ... (find constructor, check arity) ...
      const constructor = this.constructors.find(
        (c) => c.name === adtName && c.adtName === baseTypeName
      );
      if (!constructor) {
        /* report error */ return;
      }
      const constructorType = constructor.type;
      if (
        !(constructorType instanceof FunctionType) ||
        constructorType.paramTypes.length !== 1
      ) {
        /* report arity error */ return;
      }

      // --- Check literal type against expected parameter type (with instantiation) ---
      let expectedParamType: ChicoryType = UnknownType;
      const originalParamType = constructorType.paramTypes[0];

      if (
        matchedType instanceof GenericType &&
        matchedType.typeArguments.length > 0 &&
        constructorType.returnType instanceof GenericType &&
        constructorType.returnType.typeArguments.length > 0
      ) {
        const instantiationSubst = new Map<string, ChicoryType>();
        const adtDefinition = this.environment.getType(baseTypeName);
        if (
          adtDefinition instanceof GenericType &&
          adtDefinition.typeArguments.length ===
            matchedType.typeArguments.length
        ) {
          adtDefinition.typeArguments.forEach((typeVar, index) => {
            if (typeVar instanceof TypeVariable) {
              instantiationSubst.set(
                typeVar.name,
                matchedType.typeArguments[index]
              );
            }
          });
          expectedParamType = this.applySubstitution(
            originalParamType,
            instantiationSubst
          );
          console.log(
            `[visitPattern] Instantiated expected param type for ${adtName}(${literalValueStr}) to ${expectedParamType}`
          );
        } else {
          console.warn(
            `[visitPattern] Mismatch between generic ADT definition and matched type instance for ${baseTypeName}. Falling back.`
          );
          expectedParamType = originalParamType;
        }
      } else {
        expectedParamType = originalParamType;
      }

      // **** Crucial Change: Unify expectedParamType with literalType USING this.currentSubstitution ****
      const unificationResult = this.unify(
        expectedParamType,
        literalType,
        this.currentSubstitution // <<< Use the main substitution map
      );

      if (unificationResult instanceof Error) {
        // Apply substitution to expectedParamType *before* reporting error for clarity
        const finalExpected = this.applySubstitution(
          expectedParamType,
          this.currentSubstitution
        );
        this.reportError(
          `Literal ${literalValueStr} of type '${literalType}' is not compatible with expected parameter type '${finalExpected}' for constructor '${adtName}'. ${unificationResult.message}`,
          literalCtx
        );
      } else {
        // Unification succeeded, potentially refining types in this.currentSubstitution
        console.log(
          `[visitPattern] Literal ${literalValueStr} successfully unified with expected type ${this.applySubstitution(
            expectedParamType,
            this.currentSubstitution
          )}`
        );
      }

      // --- LiteralMatchPatternContext ---
    } else if (ctx.ruleContext instanceof parser.LiteralMatchPatternContext) {
      const literalCtx = (ctx as parser.LiteralMatchPatternContext).literal();
      const literalType = this.visitLiteral(literalCtx);
      const literalValueStr = literalCtx.getText();
      // addCase(literalValueStr); // Removed call
      console.log(
        `[visitPattern] Checking pattern (literal): ${literalValueStr}`
      );

      // Unify matchedType with literalType USING this.currentSubstitution
      const result = this.unify(
        matchedType, // The type of the value being matched
        literalType, // The type of the literal in the pattern
        this.currentSubstitution // <<< Use the main substitution map
      );
      if (result instanceof Error) {
        // Apply substitution before reporting error
        const finalMatchedType = this.applySubstitution(
          matchedType,
          this.currentSubstitution
        );
        this.reportError(
          `Cannot match literal ${literalValueStr} of type '${literalType}' against incompatible value of type '${finalMatchedType}'. ${result.message}`,
          ctx
        );
      } else {
        console.log(
          `[visitPattern] Literal pattern ${literalValueStr} successfully unified with matched type ${this.applySubstitution(
            matchedType,
            this.currentSubstitution
          )}`
        );
      }

      // --- Other pattern types (BareAdt, Wildcard, etc.) ---
    } else if (ctx.ruleContext instanceof parser.BareAdtOrVariableMatchPatternContext) {
      const varName = (ctx as parser.BareAdtOrVariableMatchPatternContext)
        .IDENTIFIER()!
        .getText();

      let isBareAdt = false;
      if (
        matchedType instanceof AdtType ||
        matchedType instanceof GenericType
      ) {
        const constructor = this.constructors.find(
          (c) => c.adtName === matchedType.name && c.name === varName
        );
        if (
          constructor &&
          constructor.type instanceof FunctionType &&
          constructor.type.paramTypes.length === 0
        ) {
          isBareAdt = true; // Handled by BareAdtOrVariableMatchPatternContext
        }
      }

      if (!isBareAdt) {
        console.log(
          `[visitPattern] Binding variable pattern '${varName}' with type '${matchedType}'`
        );
        // Bind the variable in the current scope with the matched type
        this.environment.declare(varName, matchedType, ctx, (str) =>
          this.reportError(str, ctx)
        );
        this.hints.push({ context: ctx, type: matchedType.toString() });
      } else {
        const adtName = (ctx as parser.BareAdtOrVariableMatchPatternContext)
          .IDENTIFIER()
          .getText();
        // addCase(adtName); // Removed call
        console.log(`[visitPattern] Checking pattern (bare ADT): ${adtName}`);

        let baseTypeName: string | null = null;
        if (
          matchedType instanceof AdtType ||
          matchedType instanceof GenericType
        ) {
          baseTypeName = matchedType.name;
        } else if (matchedType instanceof TypeVariable) {
          console.warn(
            `[visitPattern] Cannot fully verify bare ADT pattern ${adtName} against unknown type ${matchedType}.`
          );
          return;
        } else {
          this.reportError(
            `Cannot match type '${matchedType}' against ADT pattern '${adtName}'`,
            ctx
          );
          return;
        }

        const constructor = this.constructors.find(
          (c) => c.name === adtName && c.adtName === baseTypeName
        );
        if (!constructor) {
          this.reportError(
            `Constructor '${adtName}' does not exist on type '${baseTypeName}'`,
            ctx
          );
        } else {
          if (
            constructor.type instanceof FunctionType &&
            constructor.type.paramTypes.length > 0
          ) {
            this.reportError(
              `Constructor '${adtName}' expects arguments, but none were provided.`,
              ctx
            );
          }
          // **** Check type compatibility using unification ****
          // We need the expected type (e.g., Result<T,E>) and the actual type (e.g., Result<string, number>)
          // Unify the matchedType with the constructor's return type *instantiated* if generic
          let constructorReturnType =
            constructor.type instanceof FunctionType
              ? constructor.type.returnType
              : UnknownType; // Adjust if constructor type isn't always FunctionType
          // Instantiate if needed (similar to param logic but for return type)
          // ... (instantiation logic - potentially complex, maybe skip detailed check here if pattern shape is main goal)
          // For now, mainly rely on name and arity check for bare ADT.
          // A stricter check could unify matchedType with potentially instantiated constructorReturnType.
        }
      }
    } else if (
      ctx.ruleContext instanceof parser.AdtWithWildcardMatchPatternContext
    ) {
      const adtName = (ctx as parser.AdtWithWildcardMatchPatternContext)
        .IDENTIFIER()
        .getText();
      // addCase(`${adtName}(*)`); // Removed call
      console.log(
        `[visitPattern] Checking pattern (ADT with wildcard): ${adtName}(_)`
      );

      let baseTypeName: string | null = null;
      if (
        matchedType instanceof AdtType ||
        matchedType instanceof GenericType
      ) {
        baseTypeName = matchedType.name;
      } else if (matchedType instanceof TypeVariable) {
        console.warn(
          `[visitPattern] Cannot fully verify ADT wildcard pattern ${adtName}(_) against unknown type ${matchedType}.`
        );
        return;
      } else {
        this.reportError(
          `Cannot match type '${matchedType}' against ADT pattern '${adtName}(_)'`,
          ctx
        );
        return;
      }

      const constructor = this.constructors.find(
        (c) => c.name === adtName && c.adtName === baseTypeName
      );
      if (!constructor) {
        this.reportError(
          `Constructor '${adtName}' does not exist on type '${baseTypeName}'`,
          ctx
        );
        return;
      }
      const constructorType = constructor.type;
      if (
        !(constructorType instanceof FunctionType) ||
        constructorType.paramTypes.length !== 1
      ) {
        this.reportError(
          `Constructor '${adtName}' does not take exactly one parameter as expected by wildcard pattern '${adtName}(_)'.`,
          ctx
        );
        return;
      }
    } else if (ctx.ruleContext instanceof parser.WildcardMatchPatternContext) {
      // Always matches, no specific type check needed here
      console.log(`[visitPattern] Checking pattern (wildcard): _`);
    }
    else {
      console.error(
        `[visitPattern] Unhandled pattern context type: ${ctx.constructor.name}`
      );
      this.reportError(`Unsupported pattern type: ${ctx.getText()}`, ctx);
    }
  }

  visitJsxExpr(ctx: parser.JsxExprContext): ChicoryType {
    // For now we will treat all JSX as untyped
    return UnknownType;
  }

  private instantiateGenericType(
    genericType: GenericType,
    providedArgs: ChicoryType[] = [] // Renamed from typeArgs to avoid confusion
  ): ChicoryType {
    console.log(`[instantiateGenericType] ENTER`);
    console.log(`  genericType: ${genericType.toString()}`);
    console.log(
      `  providedArgs: [${providedArgs.map((t) => t.toString()).join(", ")}]`
    );

    // If specific type arguments are provided, use them directly.
    if (providedArgs.length > 0) {
      console.log(`  > Provided arguments detected.`);
      if (providedArgs.length !== genericType.typeArguments.length) {
        console.warn(
          `[instantiateGenericType] Warning: Mismatched number of type arguments provided for ${genericType.name}. Expected ${genericType.typeArguments.length}, got ${providedArgs.length}. Using provided arguments anyway.`
        );
        // Potentially report an error here instead of just warning, depending on desired strictness.
      }
      const result = new GenericType(genericType.name, providedArgs);
      console.log(
        `[instantiateGenericType] EXIT (using provided args): ${result.toString()}`
      );
      return result;
    }

    console.log(`  > No provided arguments. Creating fresh type variables.`);
    // If no specific arguments provided, create fresh type variables.
    const substitution = new Map<string, ChicoryType>();
    const freshTypeArgs = genericType.typeArguments.map((param, i) => {
      console.log(`    > Instantiating param ${i}: ${param.toString()}`);
      if (param instanceof TypeVariable) {
        const freshVar = this.newTypeVar();
        console.log(
          `      > Param is TypeVariable ('${param.name}'). Creating fresh var: '${freshVar.name}'`
        );
        substitution.set(param.name, freshVar);
        return freshVar;
      }
      // If the parameter isn't a variable itself, apply any substitutions created *so far*
      // (e.g., for nested generics like Foo<A, B<A>> - unlikely but possible)
      console.log(
        `      > Param is not TypeVariable. Applying current instantiation substitution.`
      );
      return this.applySubstitution(param, substitution);
    });

    console.log(
      `  > Fresh type arguments created: [${freshTypeArgs
        .map((t) => t.toString())
        .join(", ")}]`
    );
    // Return the generic type with fresh variables.
    // We don't need to manipulate constructors here; that should happen
    // when the constructor *itself* is referenced or called.
    const result = new GenericType(genericType.name, freshTypeArgs);
    console.log(
      `[instantiateGenericType] EXIT (with fresh vars): ${result.toString()}`
    );
    return result;
  }

  // Helper method to check if a variable appears in a type
  private variableAppearsIn(typeVar: TypeVariable, type: ChicoryType): boolean {
    return this.occursIn(typeVar, type);
  }

  // You *could* override visit methods you don't need, but it's not strictly necessary.
  // The base visitor will provide default (empty) implementations.

  // Example:  If you didn't need to handle jsxAttributes, you could leave it out entirely.
  // visitJsxAttributes(ctx: parser.JsxAttributesContext): ChicoryType { ... }
}

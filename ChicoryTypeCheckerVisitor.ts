import { CharStream, CommonTokenStream, ParserRuleContext } from "antlr4ng";
import { ChicoryLexer } from "./generated/ChicoryLexer";
import { ChicoryParser } from "./generated/ChicoryParser";
import declareJsxTypes from "./generated/internalChicoryJsxTypes.js"
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
  RecordField,
  JsxElementType,
  DisplayTypeAdt,
  StringLiteralType,
  LiteralUnionType,
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

const JSX_INTRINSIC_PREFIX = "__jsx_";

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
  public prelude: Prelude; // Make public or provide getter if needed by visitor
  private currentFilePath: string = "";
  private readFile: (filePath: string) => string;
  private compilationCache: CompilationCache = new Map();
  private processingFiles: ProcessingFiles = new Set();
  private exportedBindings: Map<string, ChicoryType> = new Map();
  // Map to store the definition of type aliases (generic or simple)
  // Key: Alias name (e.g., "Box"), Value: { params: TypeVariable[], definition: ChicoryType }
  private typeAliasDefinitions: Map<
    string,
    { params: TypeVariable[]; definition: ChicoryType }
  > = new Map();

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
    const optionTypeVarT = new TypeVariable(this.nextTypeVarId++, "T"); // Assuming TypeVariable exists or use a placeholder name
    const optionGenericType = new GenericType(this.nextTypeVarId++, optionTypeName, [optionTypeVarT]);

    // Define Some(T) -> Option<T>
    const someName = "Some";
    // The return type MUST be the generic Option<T> for instantiation/unification
    const someType = new FunctionType([optionTypeVarT], optionGenericType, someName);
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
      console.error("Prelude Error:", err),
      [optionTypeVarT]
    );
    // Add Constructors as functions in the environment
    this.environment.declare(someName, someType, null, (err) =>
      console.error("Prelude Error:", err),
      [optionTypeVarT]
    );
    this.environment.declare(noneName, noneType, null, (err) =>
      console.error("Prelude Error:", err),
      [optionTypeVarT]
    );

    // Add constructor definitions for the type checker's ADT logic
    this.constructors.push(someConstructorDef, noneConstructorDef);

    // --- Result<T, E> = Ok(T) | Err(E) ---
    const resultTypeName = "Result";
    // Create distinct TypeVariable instances for T and E within Result's definition context
    const typeVarResT = new TypeVariable(this.nextTypeVarId++,"T");
    const typeVarResE = new TypeVariable(this.nextTypeVarId++, "E");
    const resultGenericType = new GenericType(this.nextTypeVarId++, resultTypeName, [
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
      console.error("Prelude Error (Result Type):", err),
      [typeVarResT, typeVarResE]
    );
    // Add Constructors as functions in the environment
    this.environment.declare(okName, okType, null, (err) =>
      console.error("Prelude Error (Ok Constructor):", err),
      [typeVarResT]
    );
    this.environment.declare(errName, errType, null, (err) =>
      console.error("Prelude Error (Err Constructor):", err),
      [typeVarResE]
    );

    // Add constructor definitions for the type checker's ADT logic
    this.constructors.push(okConstructorDef, errConstructorDef);
  }

  // --- START: JSX Intrinsic Initialization ---
  private initializeJsxIntrinsics(): void {
      console.log("[initializeJsxIntrinsics] Initializing...");
      const originalDeclare = this.environment.declare.bind(this.environment);
      // Wrap the declare function to add a prefix to JSX intrinsic names (when type checking jsx expressions, we check for builtins using this prefix)
      const jsxDeclare = (
        identifier: string,
        type: ChicoryType,
        context: ParserRuleContext | null,
        errorMessage
      ) => {
        // Prefix the tag name
        const jsxIntrinsicName = JSX_INTRINSIC_PREFIX + identifier;
        originalDeclare(jsxIntrinsicName, type, context, (err) => console.error(errorMessage,err), []);
      };

      declareJsxTypes(jsxDeclare, {
        StringType,
        NumberType,
        BooleanType,
        UnitType,
        FunctionType,
        RecordType,
        JsxElementType,
        LiteralUnionType,
      })
      console.log("[initializeJsxIntrinsics] Initialization complete.");
  }

  private newTypeVar(name: string = `t${this.nextTypeVarId}`): TypeVariable {
    const id = this.nextTypeVarId++;
    return new TypeVariable(id, name);
  }

  unify(
    type1: ChicoryType,
    type2: ChicoryType,
    substitution: SubstitutionMap
  ): ChicoryType | Error {
    console.log(`[unify] ENTER`);
    console.log(`  type1: ${type1.toString()} (${type1.constructor.name})`);
    console.log(`  type2: ${type2.toString()} (${type2.constructor.name})`);
    console.log(`  substitution (in):`, JSON.stringify(new Map(substitution)).slice(0,80)); // Log a copy

    // Pass empty visited set as unify starts a new substitution context
    type1 = this.applySubstitution(type1, substitution, new Set());
    type2 = this.applySubstitution(type2, substitution, new Set());
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

    // --- Alias Expansion ---
    // Expand aliases *before* handling TypeVariables or other checks
    // Expand repeatedly until no more aliases can be expanded.
    let expandedType1 = type1;
    let expandedType2 = type2;
    let expansionOccurred = false;
    let expansionCount = 0; // Limit recursion depth
    const MAX_EXPANSION_DEPTH = 10; // Prevent infinite loops in case of recursive aliases

    while (expansionCount < MAX_EXPANSION_DEPTH) {
      const nextExpanded1 = this.expandAliasOnce(expandedType1, substitution);
      const nextExpanded2 = this.expandAliasOnce(expandedType2, substitution);

      if (nextExpanded1 === expandedType1 && nextExpanded2 === expandedType2) {
        break; // No more expansions possible
      }
      if (nextExpanded1 !== expandedType1) {
        console.log(
          `[unify] Expanded type1: ${expandedType1.toString()} -> ${nextExpanded1.toString()}`
        );
        expansionOccurred = true;
      }
      if (nextExpanded2 !== expandedType2) {
        console.log(
          `[unify] Expanded type2: ${expandedType2.toString()} -> ${nextExpanded2.toString()}`
        );
        expansionOccurred = true;
      }
      expandedType1 = nextExpanded1;
      expandedType2 = nextExpanded2;
      expansionCount++;
    }

    if (expansionCount >= MAX_EXPANSION_DEPTH) {
      console.error(
        `[unify] ERROR: Maximum alias expansion depth (${MAX_EXPANSION_DEPTH}) reached. Possible recursive type alias?`
      );
      // Report error?
      // this.reportError(...)
      // Fallback to original types to avoid infinite loop in unify call
      expandedType1 = type1;
      expandedType2 = type2;
      expansionOccurred = false; // Treat as if no expansion happened to avoid recursive unify call
    }

    // If expansion occurred, *replace* the original types and continue unification logic
    if (expansionOccurred) {
      console.log(`[unify] Continuing unification with expanded types:`);
      console.log(`  Expanded type1: ${expandedType1.toString()}`);
      console.log(`  Expanded type2: ${expandedType2.toString()}`);
      type1 = expandedType1;
      type2 = expandedType2;
      // Re-check equality after expansion
      if (typesAreEqual(type1, type2)) {
        console.log(`[unify] SUCCESS: Expanded types are equal.`);
        console.log(`[unify] EXIT`);
        return type1;
      }
    }
    // --- End Alias Expansion ---

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
      // Pass empty visited set
      const unifiedType = this.applySubstitution(type1, substitution, new Set());
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
      const occurs = this.occursIn(new TypeVariable(this.nextTypeVarId++,type1.name), type2);
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
      substitution.set(type1.id, type2);
      console.log(`  substitution (out):`, JSON.stringify(new Map(substitution)).slice(0,80)); // Log a copy
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

      if (type1.name !== type2.name) {
        return new Error(
          `Cannot unify ADTs with different names: ${type1.name} and ${type2.name}`
        );
      }
      if (type1.typeParameters.length !== type2.typeParameters.length) {
        return new Error(`ADT ${type1.name} arity mismatch`);
      }

      for (let i = 0; i < type1.typeParameters.length; i++) {
        const result = this.unify(
          type1.typeParameters[i],
          type2.typeParameters[i],
          substitution
        );
        if (result instanceof Error) return result;
      }
      return type1;
    }

    if (type1 instanceof TypeVariable) {
      console.log(`[unify] BRANCH: type1 is TypeVariable ('${type1.name}')`);
      if (substitution.has(type1.id)) {
        console.log(
          `  > Recursing due to existing substitution for '${type1.name}'`
        );
        console.log(`[unify] EXIT (recursive)`);
        return this.unify(substitution.get(type1.id)!, type2, substitution);
      }
      if (type2 instanceof TypeVariable && type1.id === type2.id) {
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
      substitution.set(type1.id, type2);
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
      // Pass empty visited set
      const unifiedType = new ArrayType(
        this.applySubstitution(elementResult, substitution, new Set())
      );
      console.log(`[unify] SUCCESS: Unified ArrayType ${unifiedType}`);
      console.log(`[unify] EXIT`);
      return unifiedType;
    }

    // --- RecordType Unification ---
    if (type1 instanceof RecordType && type2 instanceof RecordType) {
      console.log(`[unify] BRANCH: RecordType vs RecordType`);
      // Check fields of type1 against type2
      for (const [key1, fieldInfo1] of type1.fields) {
        const fieldInfo2 = type2.fields.get(key1);

        if (!fieldInfo2) {
          // Field from type1 is missing in type2.
          // For unification, this is generally an error unless the field in type1 is optional.
          // However, the logic below for checking extra/missing fields handles this more robustly.
          // We can simply proceed to the next field in type1 for now.
          continue; // Skip to the next field in type1
        }

        // Field exists in both, check optional flag and unify inner types
        if (fieldInfo1.optional !== fieldInfo2.optional) {
          const error = new Error(
            `Field '${key1}' optional mismatch: Optional=${fieldInfo1.optional} in '${type1}', Optional=${fieldInfo2.optional} in '${type2}'`
          );
          console.error(`[unify] ERROR: ${error.message}`);
          console.log(`[unify] EXIT (error)`);
          return error;
        }

        console.log(`  > Recursively unifying field '${key1}'`);
        const result = this.unify(fieldInfo1.type, fieldInfo2.type, substitution); // Unify inner types
        if (result instanceof Error) {
          const error = new Error(
            `Cannot unify type for field '${key1}': ${result.message}`
          );
          console.error(`[unify] ERROR: ${error.message}`);
          console.log(`[unify] EXIT (error)`);
          return error;
        }
      }

      // Check for extra fields in type2 not present in type1
      for (const key2 of type2.fields.keys()) {
        if (!type1.fields.has(key2)) {
           // Allow unification if the extra field in type2 is optional?
           // ReScript allows { name: string } to be passed where { name: string, age?: int } is expected.
           // Let's allow this for now - type2 can have *extra optional* fields.
           const fieldInfo2 = type2.fields.get(key2)!;
           if (!fieldInfo2.optional) {
               const error = new Error(
                   `Record type '${type2}' has extra required field '${key2}' not present in type '${type1}'`
               );
               console.error(`[unify] ERROR: ${error.message}`);
               console.log(`[unify] EXIT (error)`);
               return error;
           }
           console.log(`  > Allowing extra optional field '${key2}' from type2.`);
        }
      }

      // Check for required fields in type1 missing in type2
      for (const [key1, fieldInfo1] of type1.fields) {
          if (!type2.fields.has(key1) && !fieldInfo1.optional) {
              const error = new Error(
                  `Record type '${type2}' is missing required field '${key1}' from type '${type1}'`
              );
              console.error(`[unify] ERROR: ${error.message}`);
              console.log(`[unify] EXIT (error)`);
              return error;
          }
      }


      // If all checks pass, unification succeeds.
      // Return the potentially more specific type (type1, after substitutions)
      // Pass empty visited set
      const unifiedType = this.applySubstitution(type1, substitution, new Set());
      console.log(`[unify] SUCCESS: Unified RecordType ${unifiedType}`);
      console.log(`[unify] EXIT`);
      return unifiedType;
    }
    // --- End RecordType Unification ---

    if (type1 instanceof FunctionType && type2 instanceof FunctionType) {
      console.log(`[unify] BRANCH: FunctionType vs FunctionType`);

      // type1 is EXPECTED function type, type2 is PROVIDED function type.
      // If the provided function (type2) has MORE parameters than expected (type1), it's an error.
      if (type1.paramTypes.length < type2.paramTypes.length) {
        const error = new Error(
          `Function type mismatch: Expected ${type1.paramTypes.length} parameters, but provided function has ${type2.paramTypes.length}.`
        );
        console.error(`[unify] ERROR: ${error.message}`);
        console.log(`[unify] EXIT (error)`);
        return error;
      }

      // Unify parameters up to the arity of the *provided* function (type2).
      // If type1 (expected) has more parameters, those extra parameters are considered
      // implicitly ignored by the provided function type2.
      console.log(`  > Recursively unifying parameter types (up to arity of provided function type2: ${type2.paramTypes.length}).`);
      for (let i = 0; i < type2.paramTypes.length; i++) { // Loop up to type2's (provided) arity
        const result = this.unify(
          type1.paramTypes[i], // Expected param type
          type2.paramTypes[i], // Provided param type
          substitution
        );
        if (result instanceof Error) {
          console.error(
            `[unify] ERROR: Failed unifying function param ${i + 1}: ${result.message}`
          );
          console.log(`[unify] EXIT (error)`);
          // Add more context to the error message if returning it
          return new Error(`Parameter ${i + 1} type mismatch: Expected '${type1.paramTypes[i].toString()}' but got '${type2.paramTypes[i].toString()}'. ${result.message}`);
        }
      }

      console.log(`  > Recursively unifying return types`);
      let returnResult: ChicoryType | Error;
      if (type1.returnType === UnitType) {
        // If the expected return type is UnitType (void), any actual return type is acceptable.
        console.log(`  > Expected return is UnitType. Allowing actual return type '${type2.returnType.toString()}'. Compatibility success.`);
        returnResult = type1.returnType;
      } else {
        // Standard unification for non-void expected return types.
        returnResult = this.unify(
          type1.returnType,
          type2.returnType,
          substitution
        );
      }

      if (returnResult instanceof Error) {
        console.error(
          `[unify] ERROR: Failed unifying function return type: ${returnResult.message}`
        );
        console.log(`[unify] EXIT (error)`);
        return returnResult;
      }
      // Pass empty visited set
      const unifiedType = this.applySubstitution(type1, substitution, new Set());
      console.log(`[unify] SUCCESS: Unified FunctionType ${unifiedType.toString()}`);
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
      // Pass empty visited set
      const unifiedType = this.applySubstitution(type1, substitution, new Set()); // Re-apply subs
      console.log(`[unify] SUCCESS: Unified TupleType ${unifiedType}`);
      console.log(`[unify] EXIT`);
      return unifiedType;
    }

    // --- JsxElementType Unification ---
    if (type1 instanceof JsxElementType && type2 instanceof JsxElementType) {
        console.log(`[unify] BRANCH: JsxElementType vs JsxElementType`);
        // Unify their props types recursively
        console.log(`  > Recursively unifying props types`);
        const propsResult = this.unify(type1.propsType, type2.propsType, substitution);
        if (propsResult instanceof Error) {
            const error = new Error(`Cannot unify JsxElement types: ${propsResult.message}`);
            console.error(`[unify] ERROR: ${error.message}`);
            console.log(`[unify] EXIT (error)`);
            return error;
        }
        // Return one of the JsxElement types (e.g., type1) as they are now considered equivalent
        // No need to apply substitution again, as propsResult is the unified props type
        const unifiedType = new JsxElementType(propsResult as RecordType); // Create new instance with unified props
        console.log(`[unify] SUCCESS: Unified JsxElementType ${unifiedType}`);
        console.log(`[unify] EXIT`);
        return unifiedType;
    }
    // --- End JsxElementType Unification ---

    // --- StringLiteralType and LiteralUnionType Unification ---
    // Case 1: StringLiteral vs StringLiteral
    if (type1 instanceof StringLiteralType && type2 instanceof StringLiteralType) {
      if (type1.value === type2.value) {
        console.log(`[unify] SUCCESS: StringLiteralTypes are equal ("${type1.value}")`);
        console.log(`[unify] EXIT`);
        return type1;
      } else {
        const error = new Error(`Cannot unify string literal "${type1.value}" with "${type2.value}"`);
        console.error(`[unify] ERROR: ${error.message}`);
        console.log(`[unify] EXIT (error)`);
        return error;
      }
    }

    // Case 2: LiteralUnion vs LiteralUnion
    if (type1 instanceof LiteralUnionType && type2 instanceof LiteralUnionType) {
      // For unification, we find the intersection. If intersection is empty, it's an error.
      const intersection = new Set<string>();
      for (const val of type1.values) {
        if (type2.values.has(val)) {
          intersection.add(val);
        }
      }
      if (intersection.size === 0) {
        const error = new Error(`Cannot unify literal unions ${type1} and ${type2} as they are disjoint.`);
        console.error(`[unify] ERROR: ${error.message}`);
        console.log(`[unify] EXIT (error)`);
        return error;
      }
      const resultType = intersection.size === 1 
        ? new StringLiteralType(Array.from(intersection)[0]) 
        : new LiteralUnionType(intersection);
      console.log(`[unify] SUCCESS: Unified LiteralUnionTypes to ${resultType}`);
      console.log(`[unify] EXIT`);
      return resultType;
    }

    // Case 3: StringLiteral vs LiteralUnion
    if (type1 instanceof StringLiteralType && type2 instanceof LiteralUnionType) {
      if (type2.values.has(type1.value)) {
        console.log(`[unify] SUCCESS: StringLiteral "${type1.value}" is part of LiteralUnion ${type2}. Result: ${type1}`);
        console.log(`[unify] EXIT`);
        return type1; // The specific literal is the result
      } else {
        const error = new Error(`String literal "${type1.value}" is not a member of literal union ${type2}`);
        console.error(`[unify] ERROR: ${error.message}`);
        console.log(`[unify] EXIT (error)`);
        return error;
      }
    }
    if (type1 instanceof LiteralUnionType && type2 instanceof StringLiteralType) {
      // Symmetric to above
      console.log(`[unify] BRANCH: Swapping LiteralUnionType and StringLiteralType and recursing.`);
      console.log(`[unify] EXIT (recursive swap)`);
      return this.unify(type2, type1, substitution);
    }

    // Case 4: StringLiteral vs StringType
    if (type1 instanceof StringLiteralType && type2 === StringType) {
      console.log(`[unify] SUCCESS: StringLiteral "${type1.value}" unifies with StringType. Result: ${type1}`);
      console.log(`[unify] EXIT`);
      return type1; // String literal is more specific
    }
    if (type1 === StringType && type2 instanceof StringLiteralType) {
      console.log(`[unify] BRANCH: Swapping StringType and StringLiteralType and recursing.`);
      console.log(`[unify] EXIT (recursive swap)`);
      return this.unify(type2, type1, substitution);
    }

    // Case 5: LiteralUnion vs StringType
    if (type1 instanceof LiteralUnionType && type2 === StringType) {
      console.log(`[unify] SUCCESS: LiteralUnion ${type1} unifies with StringType. Result: ${type1}`);
      console.log(`[unify] EXIT`);
      return type1; // Literal union is more specific
    }
    if (type1 === StringType && type2 instanceof LiteralUnionType) {
      console.log(`[unify] BRANCH: Swapping StringType and LiteralUnionType and recursing.`);
      console.log(`[unify] EXIT (recursive swap)`);
      return this.unify(type2, type1, substitution);
    }
    // --- End StringLiteralType and LiteralUnionType Unification ---

    // Add other type-specific unification rules (RecordType etc.) as needed
    const finalError = new Error(`Cannot unify ${type1} with ${type2}`);
    console.error(`[unify] ERROR: Fallthrough - ${finalError.message}`);
    console.log(`[unify] EXIT (error)`);
    return finalError;
  }

  // Helper to expand a type alias one level if possible
  private expandAliasOnce(
    type: ChicoryType,
    substitution: SubstitutionMap
  ): ChicoryType {
    if (type instanceof GenericType && this.typeAliasDefinitions.has(type.name)) {
      const aliasInfo = this.typeAliasDefinitions.get(type.name)!;
      const aliasSubstitution = new Map<number, ChicoryType>();
      aliasInfo.params.forEach((param, index) => {
        const instanceArg = type.typeArguments[index];
        console.log(`[expandAliasOnce] Creating local alias substitution: ${param.toString()}(id=${param.id}) -> ${instanceArg.toString()}`);
        aliasSubstitution.set(param.id, instanceArg);
      });
      console.log(`[expandAliasOnce] Local aliasSubstitution: ${JSON.stringify(Array.from(aliasSubstitution.entries()))}`);
      const expandedDef = this.applySubstitution(aliasInfo.definition, aliasSubstitution, new Set());
      console.log(`[expandAliasOnce] Expanded definition: ${expandedDef.toString()}`);
      return expandedDef;
    }
    return type;
  }

  applySubstitution(
    type: ChicoryType,
    substitution: SubstitutionMap,
    visited: Set<number> = new Set() // Add visited set for cycle detection
  ): ChicoryType {
    if (type instanceof TypeVariable) {
      // --- Cycle Detection ---
      if (visited.has(type.id)) {
        console.warn(`[applySubstitution] Cycle detected involving TypeVariable ${type.id}. Returning original type.`);
        return type; // Avoid infinite recursion
      }
      // --- End Cycle Detection ---

      // <<< Log TypeVariable Substitution Attempt >>>
      const varId = type.id; // Use varId consistently
      const varName = type.name;
      console.log(`[applySubst TV] Trying to substitute ${varName}(id=${varId}).`);

      if (substitution.has(varId)) { // Use varId
        const mappedType = substitution.get(varId)!; // Use varId
        console.log(`  > Found mapping in provided map: ${varId} -> ${mappedType.toString()}`);

        // Add current var ID to visited set for the recursive call
        const newVisited = new Set(visited);
        newVisited.add(varId); // Use varId

        const substituted = this.applySubstitution(
          mappedType,
          substitution,
          newVisited // Pass updated visited set
        );
        console.log(`  > Recursive applySubst result for mapped type: ${substituted.toString()}`);
        return substituted;
      } else {
        console.log(`  > No mapping found in provided map for ${varName}(id=${varId}). Returning original.`); // Use varId
      }
      // <<< End Log >>>
      return type; // Return original if not found in the provided map
    }

    // Add ArrayType substitution
    if (type instanceof ArrayType) {
      const substitutedElementType = this.applySubstitution(
        type.elementType,
        substitution,
        visited // Pass visited set
      );
      if (substitutedElementType === type.elementType) {
        return type; // Optimization: return original if element didn't change
      }
      const result = new ArrayType(substitutedElementType);

      return result;
    }

    // Add case for GenericType
    if (type instanceof GenericType) {
      let changed = false;
      const newArgs = type.typeArguments.map((t) => {
        const newT = this.applySubstitution(t, substitution, visited); // Pass visited set
        if (newT !== t) changed = true;
        return newT;
      });
      if (!changed) {
        return type; // Optimization
      }
      // Creates a new GenericType instance.
      const result = new GenericType(this.nextTypeVarId++, type.name, newArgs);
      console.log(`[applySubst Generic] Input: ${type.toString()}, Subst: ${JSON.stringify(Array.from(substitution.entries()))}, Output: ${result.toString()}`); // Optional log
      return result;
    }

    if (type instanceof FunctionType) {
      let paramsChanged = false;
      const newParamTypes = type.paramTypes.map((p) => {
        const newP = this.applySubstitution(p, substitution, visited); // Pass visited set
        if (newP !== p) paramsChanged = true;
        return newP;
      });
      const newReturnType = this.applySubstitution(
        type.returnType,
        substitution,
        visited // Pass visited set
      );
      const returnChanged = newReturnType !== type.returnType;

      if (!paramsChanged && !returnChanged) {
        return type; // Optimization
      }
      const result = new FunctionType(
        newParamTypes,
        newReturnType,
        type.constructorName
      );
      return result;
    }

    if (type instanceof TupleType) {
      let changed = false;
      const newElementTypes = type.elementTypes.map((e) => {
        const newE = this.applySubstitution(e, substitution, visited); // Pass visited set
        if (newE !== e) changed = true;
        return newE;
      });
      if (!changed) {
        return type; // Optimization
      }
      const result = new TupleType(newElementTypes);
      return result;
    }

    // Add AdtType substitution
    if (type instanceof AdtType) {
        let changed = false;
        // Substitute within the type parameters defined for the ADT itself
        const newParams = type.typeParameters.map(t => {
            const newT = this.applySubstitution(t, substitution, visited); // Pass visited set
            if (newT !== t) changed = true;
            return newT;
        });
        if (!changed) {
            return type; // Optimization
        }
        // Return a new AdtType with substituted parameters.
        // This represents the ADT definition itself, potentially with resolved parameters
        // if the substitution came from an outer scope unifying a generic parameter.
        const result = new AdtType(type.name, newParams);
        return result;
    }

    // Add RecordType substitution
   if (type instanceof RecordType) {
       let changed = false;
       const newFields = new Map<string, RecordField>();
       for (const [key, fieldInfo] of type.fields) {
           // Recursively apply substitution to the field's inner type
           const newFieldType = this.applySubstitution(fieldInfo.type, substitution, visited);
           if (newFieldType !== fieldInfo.type) {
               changed = true;
               newFields.set(key, { type: newFieldType, optional: fieldInfo.optional });
           } else {
               newFields.set(key, fieldInfo); // No change, reuse original field info
           }
       }
       if (!changed) {
           return type; // Optimization: return original if no fields changed
       }
       // Return a new RecordType with the potentially updated field types
       const result = new RecordType(newFields);
       return result;
   }


    // Substitute within JsxElement's propsType
    if (type instanceof JsxElementType) {
        const substitutedPropsType = this.applySubstitution(type.propsType, substitution, visited) as RecordType; // Assuming propsType is always RecordType
        if (substitutedPropsType === type.propsType) {
            return type; // Optimization: return original if props didn't change
        }
        // Return a new JsxElementType with the substituted props type
        const result = new JsxElementType(substitutedPropsType);
        return result;
    }

    return type; // Return original type if no specific handling matched
  }

  occursIn(typeVar: TypeVariable, type: ChicoryType): boolean {
    // Basic occurs check logging can be added here if needed
    if (type instanceof TypeVariable) {
      return typeVar.id === type.id;
    }

    // Add ArrayType check
    if (type instanceof ArrayType) {
      return this.occursIn(typeVar, type.elementType);
    }

    // Add case for GenericType
    if (type instanceof GenericType) {
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
      // Check the inner type of each field
      return Array.from(type.fields.values()).some((fieldInfo) =>
        this.occursIn(typeVar, fieldInfo.type)
      );
    }

    if (type instanceof AdtType) {
      // An ADT doesn't contain type variables itself (in our simplified representation)
      // Type vars might appear within the types of its *constructors*, but we handle that
      // when unifying function types (constructor types). So an ADT doesn't "contain"
      // the type var in the sense of the `occursIn` check.
      return type.typeParameters.some(p => this.occursIn(typeVar, p)); // Check type parameters of ADT definition
    }

    // Check within JsxElement's propsType
    if (type instanceof JsxElementType) {
        return this.occursIn(typeVar, type.propsType);
    }

    // StringLiteralType and LiteralUnionType do not contain type variables
    if (type instanceof StringLiteralType || type instanceof LiteralUnionType) {
      return false;
    }

    // Primitives and UnknownType don't contain type vars
    return false;
  }

  // Helper to resolve a type (potentially a generic alias) to its underlying RecordType
  resolveToRecordType(type: ChicoryType): RecordType | null {
      // The type passed in should already be substituted by the calling context (checker or compiler).
      // We only need to handle alias expansion here.
      console.log(`[resolveToRecordType] Resolving type: ${type?.toString()}`); // Added null check for logging

      if (!type) return null; // Handle null input gracefully

      if (type instanceof RecordType) {
          console.log(`  > Is already RecordType.`);
          return type;
      }

      // --- Non-Generic Alias Expansion ---
      // Check if 'type' is an AdtType or GenericType with 0 args that matches a non-generic alias definition
      // Use type.name which exists on AdtType and GenericType
      if ((type instanceof AdtType || (type instanceof GenericType && type.typeArguments.length === 0)) && this.typeAliasDefinitions.has(type.name)) {
          const aliasInfo = this.typeAliasDefinitions.get(type.name)!;
          // Ensure it's a non-generic alias (no params defined)
          if (aliasInfo.params.length === 0) {
              console.log(`  > Is non-generic alias: ${type.name}. Expanding.`);
              const aliasDef = aliasInfo.definition;
              console.log(`    > Alias definition: ${aliasDef.toString()}`);
              // Recursively resolve the definition in case it points to another alias
              return this.resolveToRecordType(aliasDef);
          } else {
              console.log(`  > Alias ${type.name} is generic, but used without type arguments here. Cannot resolve to RecordType without arguments.`);
              // This case might indicate an error elsewhere if a generic alias was expected to be instantiated.
              return null;
          }
      }
      // --- End Non-Generic Alias Expansion ---


      // --- Generic Alias Expansion ---
      if (type instanceof GenericType && this.typeAliasDefinitions.has(type.name)) {
          console.log(`  > Is GenericType alias: ${type.name}`);
          const aliasInfo = this.typeAliasDefinitions.get(type.name)!;
          const aliasDef = aliasInfo.definition;
          console.log(`    > Alias definition: ${aliasDef.toString()}`);

          // Check for arity mismatch
          if (aliasInfo.params.length !== type.typeArguments.length) {
              console.warn(`[resolveToRecordType] Arity mismatch for generic alias ${type.name}. Expected ${aliasInfo.params.length}, got ${type.typeArguments.length}`);
              return null;
          }

          // Create substitution map from alias params (T) to provided generic args (e.g., number/string)
          const aliasSubstitution = new Map<number, ChicoryType>();
          aliasInfo.params.forEach((param, index) => {
              // The type arguments provided in 'type' (e.g., number in Box<number>) are already substituted by the outer context.
              const instanceArg = type.typeArguments[index];
              console.log(`      > Mapping alias param ${param.name}(id=${param.id}) to instance arg ${instanceArg.toString()}`);
              aliasSubstitution.set(param.id, instanceArg);
          });

          // Apply the alias-specific substitution to the alias definition's type
          // Use an empty visited set for this self-contained substitution application.
          const substitutedAliasDef = this.applySubstitution(aliasDef, aliasSubstitution, new Set());
          console.log(`    > Substituted alias definition: ${substitutedAliasDef.toString()}`);

          // Recursively resolve the substituted definition in case the alias points to another alias
          return this.resolveToRecordType(substitutedAliasDef);
      }
      // --- End Generic Alias Expansion ---


      console.log(`  > Type is not RecordType or known RecordType alias.`);
      return null; // Not a record type or a known record alias
  }


  // Helper function to instantiate a function type with fresh type variables
  private instantiateFunctionType(funcType: FunctionType, genericParams: TypeVariable[]): FunctionType {
    console.log(`[instantiateFunctionType] ENTER`);
    console.log(`  funcType: ${funcType.toString()}`);

    // Create a substitution map from old var names to fresh vars
    const substitution: SubstitutionMap = new Map();
    genericParams.forEach((param) => {
      const varId = param.id;
      const freshVar = this.newTypeVar();
      console.log(
        `  > Mapping type var '${param.name}(id=${varId})' to fresh var '${freshVar.name}'`
      );
      substitution.set(varId, freshVar);
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
    // Pass empty visited set as this starts a new substitution context
    const instantiatedType = this.applySubstitution(
      funcType,
      substitution,
      new Set()
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
    this.environment = new TypeEnvironment(null); // Create the root environment for this check
    this.prelude = new Prelude();
    this.initializePrelude(); // Add prelude types (Option, Result) to the root env
    this.initializeJsxIntrinsics(); // <<< ADD THIS CALL HERE to add JSX intrinsics to the root env
    this.errors = [];
    this.hints = [];
    this.constructors = this.constructors.filter(
      (c) => c.adtName === "Option" || c.adtName === "Result"
    ); // Keep built-ins
    this.currentSubstitution = new Map();
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
    } else if (ctx.mutateStmt()) {
      return this.visitMutateStmt(ctx.mutateStmt()!);
    } else if (ctx.typeDefinition()) {
      return this.visitTypeDefinition(ctx.typeDefinition()!);
    } else if (ctx.importStmt()) {
      return this.visitImportStmt(ctx.importStmt()!);
    } else if (ctx.globalStmt()) {
      return this.visitGlobalStmt(ctx.globalStmt()!);
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

    let annotatedType: ChicoryType | null = null;
    if (annotationCtx) {
      annotatedType = this.visitTypeExpr(annotationCtx);
      // Apply main substitution - start with empty visited set
      annotatedType = this.applySubstitution(
        annotatedType,
        this.currentSubstitution,
        new Set()
      ); // Apply subs to annotation too
    }

    // Pass annotatedType as expectedType if it's a function, otherwise undefined
    const expectedExprType = (annotatedType instanceof FunctionType) ? annotatedType : undefined;
    let expressionType = this.visitExpr(expressionCtx, expectedExprType);

    // Apply main substitution - start with empty visited set
    expressionType = this.applySubstitution(
      expressionType,
      this.currentSubstitution,
      new Set()
    ); // Apply subs before unification

    let rhsFinalType: ChicoryType = expressionType; // The type of the RHS after potential annotation unification

    if (annotatedType) { // Check if annotatedType was derived
      // --- Resolve Annotated Type if Alias ---
      let resolvedAnnotatedType = annotatedType; // Already substituted
      if (annotatedType instanceof GenericType && this.typeAliasDefinitions.has(annotatedType.name)) {
          console.log(`[visitAssignStmt] Annotated type is alias ${annotatedType}. Expanding.`);
          // Pass empty visited set for self-contained expansion
          resolvedAnnotatedType = this.expandAliasOnce(annotatedType, this.currentSubstitution); // Expand using current context
          console.log(`[visitAssignStmt] Expanded annotated type to: ${resolvedAnnotatedType?.toString()}`);
      } else if (annotatedType instanceof AdtType && this.typeAliasDefinitions.has(annotatedType.name)) {
          // Handle non-generic aliases as well
          console.log(`[visitAssignStmt] Annotated type is non-generic alias ${annotatedType}. Expanding.`);
          resolvedAnnotatedType = this.expandAliasOnce(annotatedType, this.currentSubstitution);
          console.log(`[visitAssignStmt] Expanded annotated type to: ${resolvedAnnotatedType?.toString()}`);
      }
      // --- End Resolve ---


      // --- Custom Assignment Check for Records ---
      let assignmentError: Error | null = null;
      const unificationSubstitution = new Map<number, ChicoryType>(); // Still need for unifying inner types

      // Check if the *resolved* annotated type is a RecordType and the expression is a RecordType
      if (resolvedAnnotatedType instanceof RecordType && expressionType instanceof RecordType) {
          console.log(`[visitAssignStmt] Performing custom record assignment check (Resolved Annotation vs Expression).`);
          const expectedRecordType = resolvedAnnotatedType; // Use the resolved type
          // Check compatibility field by field
          const expectedFields = expectedRecordType.fields; // Use fields from resolved type
          const providedFields = expressionType.fields;
          const providedKeys = new Set(providedFields.keys());

          // 1. Check fields expected by the annotation
          for (const [key, expectedField] of expectedFields) {
              const providedField = providedFields.get(key);

              if (providedField) {
                  // Field provided in literal

                  // --- NEW: Check Optional Flag Compatibility ---
                  // Allow assigning a non-optional field from the expression (providedField.optional === false)
                  // to an optional field in the annotation (expectedField.optional === true).
                  // Disallow assigning an optional field from expr to a required field in annotation.
                  if (!expectedField.optional && providedField.optional) {
                      // This case should ideally not happen if inference is correct, but check anyway
                      assignmentError = new Error(`Internal Error? Cannot assign optional field '${key}' from expression to required field '${key}' in annotation.`);
                      break;
                  }
                  // The case where expectedField.optional is true and providedField.optional is false IS ALLOWED.
                  // --- END NEW Check ---


                  // --- Refined Unification Logic for Assignment ---
                  let fieldUnificationResult: ChicoryType | Error;
                  if (expectedField.optional && providedField.type instanceof GenericType && providedField.type.name === "Option") {
                      // Case: Assigning an explicit Option<U> (e.g., Some(1)) to an optional field (e.g., key?: T)
                      // Unify the expected inner type (T) with the provided Option's inner type (U)
                      console.log(`  > Assigning Option to optional field '${key}'. Unifying inner types: '${expectedField.type}' vs '${providedField.type.typeArguments[0]}'`);
                      fieldUnificationResult = this.unify(
                          expectedField.type, // T
                          providedField.type.typeArguments[0], // U
                          unificationSubstitution
                      );
                  } else if (expectedField.optional && !(providedField.type instanceof GenericType && providedField.type.name === "Option")) {
                      // Case: Assigning a non-Option value (e.g., 1) to an optional field (e.g., key?: T)
                      // Unify the expected inner type (T) with the provided type (e.g., number)
                       console.log(`  > Assigning non-Option to optional field '${key}'. Unifying inner type '${expectedField.type}' vs provided '${providedField.type}'`);
                      fieldUnificationResult = this.unify(
                          expectedField.type, // T
                          providedField.type, // e.g., number
                          unificationSubstitution
                      );
                  } else {
                      // Case: Assigning to a required field, or assigning Option to required (which should fail)
                      // Unify the expected type directly with the provided type.
                      console.log(`  > Assigning to required field '${key}'. Unifying expected '${expectedField.type}' vs provided '${providedField.type}'`);
                      fieldUnificationResult = this.unify(
                          expectedField.type,
                          providedField.type,
                          unificationSubstitution
                      );
                  }
                  // --- End Refined Unification ---

                  if (fieldUnificationResult instanceof Error) {
                      assignmentError = new Error(`Type mismatch for field '${key}'. Expected '${expectedField.type}' but got '${providedField.type}'. ${fieldUnificationResult.message}`);
                      break;
                  }
              } else {
                  // Field not provided in literal
                  if (!expectedField.optional) {
                      assignmentError = new Error(`Missing required field '${key}' in expression assigned to type '${annotatedType}'.`);
                      break;
                  }
                  // Missing optional field is allowed
              }
          }

          // 2. Check for extra fields in the expression (if no error yet)
          if (!assignmentError) {
              for (const key of providedKeys) {
                  if (!expectedFields.has(key)) {
                      assignmentError = new Error(`Expression provides extra field '${key}' not expected by annotated type '${annotatedType}'.`);
                      break;
                  }
              }
          }
          console.log(`[visitAssignStmt] Custom record check result: ${assignmentError ? `Error (${assignmentError.message})` : 'Success'}`);

      } else {
          // --- Default Unification ---
          // Use the original annotatedType for default unification if custom check doesn't apply
          // This handles cases like `let x: number = 1` or `let f: (number) => string = (x) => ...`
          console.log(`[visitAssignStmt] Using default unification (Annotation vs Expression).`);
          const unificationResult = this.unify(
              annotatedType, // Use original annotated type here
              expressionType,
              unificationSubstitution
          );
          if (unificationResult instanceof Error) {
              assignmentError = unificationResult; // Store the error
          }
      }
      // --- End Custom/Default Check ---


      if (assignmentError) {
        this.reportError(
          `Type mismatch: Cannot assign expression of type '${expressionType}' to target annotated with type '${annotatedType}'. ${assignmentError.message}`, // Correctly use assignmentError.message
          ctx
        );
        // Use annotated type to proceed, respecting user intent partially
        rhsFinalType = annotatedType;
      } else {
        // Assignment compatible, use the unified type (which might be more specific)
        // Merge the successful unification's substitutions back into the main context
        console.log(`[visitAssignStmt] Assignment compatible. Merging unification substitutions:`, new Map(unificationSubstitution));
        for (const [key, value] of unificationSubstitution.entries()) {
            // Apply the outer substitution to the value *before* merging,
            // to handle cases where unification bound T -> T' and outer context binds T' -> number.
            // Pass empty visited set
            const finalValue = this.applySubstitution(value, this.currentSubstitution, new Set());
            console.log(`  Merging: ${key} -> ${finalValue.toString()}`);
            this.currentSubstitution.set(key, finalValue);
        }
        console.log(`[visitAssignStmt] Main substitution after merge:`, new Map(this.currentSubstitution));

        // Apply the *updated* main substitution to get the final RHS type
        // Pass empty visited set
        rhsFinalType = this.applySubstitution(
          annotatedType, // Start from annotated type again
          this.currentSubstitution, // Use the merged substitution map
          new Set()
        );
      }
    }

    // Handle different assignment targets
    if (targetCtx.IDENTIFIER()) {
      // Simple assignment: let x = ...
      const identifierName = targetCtx.IDENTIFIER()!.getText();

      // Check if assigning a 'void' type value to a variable
      if (rhsFinalType === UnitType) {
        this.reportError(
          `Cannot assign a value of type 'void' to variable '${identifierName}'.`,
          expressionCtx // Report error on the expression producing 'void'
        );
      }

      this.environment.declare(identifierName, rhsFinalType, ctx, (str) =>
        this.reportError(str, ctx),
        []
      );
      this.hints.push({ context: targetCtx, type: rhsFinalType.toString() });
      // Store the final type for the target context
      this.setExpressionType(targetCtx, rhsFinalType);
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
            this.reportError(str, patternCtx),
            []
          );
          this.hints.push({
            context: ctx, // Hint context is the specific identifier
            type: UnknownType.toString(),
          });
        });
      } else {
        // Store the final type for the target context
        this.setExpressionType(targetCtx, rhsFinalType);
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
            // Pass empty visited set
            const fieldType = this.applySubstitution(
              rhsFinalType.fields.get(idName)!,
              this.currentSubstitution,
              new Set()
            );
            this.environment.declare(idName, fieldType, null, (str) =>
              this.reportError(str, patternCtx),
              []
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
        // Pass empty visited set
        const elementType = this.applySubstitution(
          rhsFinalType.elementType,
          this.currentSubstitution,
          new Set()
        );
        identifiers.forEach((idNode) => {
          const idName = idNode.getText();
          this.environment.declare(idName, elementType, null, (str) =>
            this.reportError(str, patternCtx),
            []
          );
          this.hints.push({
            context: ctx, // Hint context is the specific identifier
            type: elementType.toString(),
          });
        });
      } else if (rhsFinalType instanceof TupleType) {
        // Store the final type for the target context
        this.setExpressionType(targetCtx, rhsFinalType);
        if (identifiers.length > rhsFinalType.elementTypes.length) {
          this.reportError(
            `Destructuring pattern has ${identifiers.length} elements, but tuple type '${rhsFinalType}' only has ${rhsFinalType.elementTypes.length}.`,
            patternCtx
          );
        }
        identifiers.forEach((idNode, index) => {
          const idName = idNode.getText();
          if (index < rhsFinalType.elementTypes.length) {
            // Pass empty visited set
            const elementType = this.applySubstitution(
              rhsFinalType.elementTypes[index],
              this.currentSubstitution,
              new Set()
            );
            this.environment.declare(idName, elementType, null, (str) =>
              this.reportError(str, patternCtx)
            );
            this.hints.push({
              context: ctx, // Hint context is the specific identifier
              type: elementType.toString(),
            });
          } else {
            // Error already reported about length mismatch, declare as Unknown
            this.environment.declare(idName, UnknownType, null, (str) =>
              this.reportError(str, patternCtx),
              []
            );
            this.hints.push({
              context: ctx, // Hint context is the specific identifier
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
            this.reportError(str, patternCtx),
            []
          );
          this.hints.push({
            context: ctx, // Hint context is the specific identifier
            type: UnknownType.toString(),
          });
        });
      }
    } else {
      // Store the final type for the target context even if unknown target type
      this.setExpressionType(targetCtx, rhsFinalType);
      this.reportError("Unknown assignment target type.", targetCtx);
    }

    return rhsFinalType; // Return the type of the right-hand side
  }

  visitMutateStmt(ctx: parser.MutateStmtContext): ChicoryType {
    const baseIdentifierName = ctx.IDENTIFIER().getText();
    let currentLhsType = this.environment.getType(baseIdentifierName);
    // currentLhsFinalPartCtx is the context of the specific part of the LHS being typed or assigned to.
    // It starts as the base identifier and updates as we traverse member/index accesses.
    let currentLhsFinalPartCtx: ParserRuleContext = ctx;

    if (!currentLhsType) {
      this.reportError(`Variable '${baseIdentifierName}' not found.`, ctx);
      this.visitExpr(ctx.expr()); // Still visit RHS to find errors there
      return UnitType; // Mutation statements are of type Unit
    }

    // Apply current substitutions to the initial LHS type
    currentLhsType = this.applySubstitution(currentLhsType, this.currentSubstitution, new Set());

    const tailExprs = ctx.identifierTailExpr();

    for (const tail of tailExprs) {
      if (currentLhsType === UnknownType) {
        // If a previous step in resolving the LHS failed, stop.
        break;
      }
      currentLhsFinalPartCtx = tail; // The current tail expression is the new final part of the LHS

      if (tail instanceof parser.IdentifierTailMemberExpressionContext) {
      const memberName = tail.IDENTIFIER().getText();
      // Attempt to resolve currentLhsType to a RecordType, expanding aliases if necessary
      const resolvedLhsType = this.resolveToRecordType(currentLhsType);

      if (!(resolvedLhsType instanceof RecordType)) {
        this.reportError(`Cannot access property '${memberName}' on non-record type '${currentLhsType}'.`, tail);
        currentLhsType = UnknownType;
        continue; // Skip to next tail or exit loop if currentLhsType is Unknown
      }

      const fieldInfo = resolvedLhsType.fields.get(memberName);
      if (!fieldInfo) {
        this.reportError(`Property '${memberName}' does not exist on type '${resolvedLhsType}'.`, tail);
        currentLhsType = UnknownType;
        continue;
      }
      // The type of the location is T, not Option<T>, even if optional.
      // Optionality affects read (becomes Option<T>) and construction (can be omitted).
      // For mutation, we're assigning a T.
      currentLhsType = fieldInfo.type;

      } else if (tail instanceof parser.IdentifierTailIndexExpressionContext) {
      const indexExprCtx = tail.expr();
      const indexType = this.visitExpr(indexExprCtx); // Type check the index expression
      const substitutedIndexType = this.applySubstitution(indexType, this.currentSubstitution, new Set());

      // Index must be a number
      if (substitutedIndexType !== NumberType) {
        const unificationResult = this.unify(substitutedIndexType, NumberType, this.currentSubstitution);
        if (unificationResult instanceof Error) {
        this.reportError(`Index expression must be of type 'number', but got '${substitutedIndexType}'.`, indexExprCtx);
        currentLhsType = UnknownType;
        continue;
        }
        // If unification succeeded, substitutions make it effectively NumberType
      }

      if (currentLhsType instanceof ArrayType) {
        currentLhsType = currentLhsType.elementType;
      } else if (currentLhsType instanceof TupleType) {
        // Tuple indices must be literal numbers for type checking mutation
        const primaryExpr = indexExprCtx.primaryExpr()
        if (primaryExpr instanceof parser.LiteralExpressionContext && primaryExpr.literal() instanceof parser.NumberLiteralContext) {
          const indexValue = parseInt(primaryExpr.literal().getText());
          if (indexValue >= 0 && indexValue < currentLhsType.elementTypes.length) {
            currentLhsType = currentLhsType.elementTypes[indexValue];
          } else {
            this.reportError(`Tuple index ${indexValue} out of bounds for type '${currentLhsType}'.`, indexExprCtx);
            currentLhsType = UnknownType;
            continue;
          }
        } else {
        this.reportError(`Tuple index for mutation must be a literal number to determine its type.`, indexExprCtx);
        currentLhsType = UnknownType;
        continue;
        }
      } else {
        this.reportError(`Cannot index into non-array/non-tuple type '${currentLhsType}'.`, tail);
        currentLhsType = UnknownType;
        continue;
      }
      }
      // Apply substitutions that might have occurred from type-checking index expressions, etc.
      currentLhsType = this.applySubstitution(currentLhsType, this.currentSubstitution, new Set());
    }

    // If an error occurred while resolving the LHS path, currentLhsType will be UnknownType
    if (currentLhsType === UnknownType) {
      this.visitExpr(ctx.expr()); // Still visit RHS to find errors there
      return UnitType;
    }

    // currentLhsType is now the type of the location being assigned to.
    // Type check the RHS expression, providing currentLhsType as the expected type for better inference.
    const valueExprCtx = ctx.expr();
    const providedValueType = this.visitExpr(valueExprCtx, currentLhsType);
    const substitutedValueType = this.applySubstitution(providedValueType, this.currentSubstitution, new Set());

    // Unify the type of the location (expected, currentLhsType)
    // with the type of the value being assigned (provided, substitutedValueType).
    const unificationResult = this.unify(currentLhsType, substitutedValueType, this.currentSubstitution);

    if (unificationResult instanceof Error) {
      this.reportError(
      `Type mismatch: Cannot assign value of type '${substitutedValueType}' to a location of type '${currentLhsType}'. ${unificationResult.message}`,
      valueExprCtx // Report error on the RHS expression
      );
    } else {
      // Unification successful. `this.currentSubstitution` has been updated.
      // The final type of the location, after unification, can be found by re-applying substitutions.
      const finalTargetType = this.applySubstitution(unificationResult, this.currentSubstitution, new Set());
      this.hints.push({ context: currentLhsFinalPartCtx, type: finalTargetType.toString() });
      // Also add hint for the expression being assigned, it should now conform to finalTargetType
      this.hints.push({ context: valueExprCtx, type: finalTargetType.toString() });
      this.setExpressionType(valueExprCtx, finalTargetType); // Update RHS expression type
    }

    return UnitType; // Mutation statements are of type Unit
  }

  private visitTypeDefinition(ctx: parser.TypeDefinitionContext): ChicoryType {
    const typeName = ctx.IDENTIFIER().getText();
    this.environment = this.environment.pushScope();

    // Process type parameters
    const typeParams: TypeVariable[] = [];
    if (ctx.typeParams()) {
      ctx
        .typeParams()!
        .IDENTIFIER()
        .forEach((param) => {
          const paramName = param.getText();
          const typeVar = new TypeVariable(this.nextTypeVarId++, paramName);
          this.environment.declare(paramName, typeVar, ctx, (str) =>
            this.reportError(str, ctx),
            []
          );
          typeParams.push(typeVar);
        });
    }

    // Get the actual type definition, passing the typeName being defined
    const baseType = this.visitTypeExpr(ctx.typeExpr()!, typeName, undefined, typeParams); // <<< Pass typeName and typeParams

    // Store as proper type alias
    this.typeAliasDefinitions.set(typeName, {
      params: typeParams,
      definition: baseType,
    });

    // Determine the type to declare in the environment
    let finalType: ChicoryType;
    if (typeParams.length > 0) {
      // For generic aliases, declare the GenericType representation (e.g., Box<T>)
      finalType = new GenericType(this.nextTypeVarId++, typeName, typeParams);
      // TODO: Attach constructors if it's also a generic ADT?
      // const adtConstructors = this.constructors.filter(c => c.adtName === typeName);
      // if (adtConstructors.length > 0) { (finalType as any).constructors = adtConstructors; }
    } else {
      // For non-generic aliases, declare the base type itself (e.g., the RecordType for User)
      finalType = baseType;
    }

    // Declare the type alias name in the environment using the determined finalType
    this.environment.declare(typeName, finalType, ctx, (str) =>
      this.reportError(str, ctx),
      typeParams
    );

    // Pop the scope *before* declaring in the outer scope
    this.environment = this.environment.popScope();

    // Declare the type alias name in the *outer* environment
    this.environment.declare(typeName, finalType, ctx, (str) =>
        this.reportError(str, ctx),
        typeParams
    );

    // Return the finalType declared in the environment
    return finalType;
  }

  private visitTypeExpr(
    ctx: parser.TypeExprContext,
    typeName?: string, // Name of the type being defined (e.g., "MyOpt")
    typeVarsInSig?: Map<string, TypeVariable>, // For function signatures
    typeParams?: TypeVariable[] // For type definitions (e.g., [T] for MyOpt<T>)
  ): ChicoryType {
    // Pass map and typeParams down to primary type visit
    let baseType = this.visitPrimaryTypeExpr(
      ctx.primaryTypeExpr(),
      typeName,
      typeVarsInSig,
      typeParams // Pass typeParams
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
    typeName?: string, // Name of the type being defined
    typeVarsInSig?: Map<string, TypeVariable>, // For function signatures
    typeParams?: TypeVariable[] // For type definitions
  ): ChicoryType {
    // --- Check for simple IDENTIFIER first ---
    if (ctx.IDENTIFIER()) {
      const name = ctx.IDENTIFIER()!.getText();
      console.log(`[visitPrimaryTypeExpr] IDENTIFIER: '${name}', typeName: '${typeName}', typeParams: ${typeParams?.map(tp => tp.name)}, typeVarsInSig: ${typeVarsInSig ? Array.from(typeVarsInSig.keys()) : 'null'}`);

      // Order of checks:
      // 1. Is it a generic parameter of the current ADT/TypeAlias being defined? (typeParams)
      //    (e.g., `T` in `type MyList<T> = ...`)
      if (typeParams) {
        const param = typeParams.find(p => p.name === name);
        if (param) {
          console.log(`  > Matched typeParam: ${param.toString()}`);
          return param;
        }
      }

      // 2. Is it a generic parameter of the current function signature being parsed? (typeVarsInSig)
      //    (e.g., `T` in `(x: T) => T`)
      if (typeVarsInSig?.has(name)) {
        const sigVar = typeVarsInSig.get(name)!;
        console.log(`  > Matched typeVarsInSig: ${sigVar.toString()}`);
        return sigVar;
      }

      // 3. Is it a defined type in the environment?
      //    (e.g., `string`, `number`, `MyList` after `type MyList<T> = ...`)
      const envType = this.environment.getType(name);
      if (envType) {
        console.log(`  > Matched environment type: ${envType.toString()}`);
        return envType;
      }

      // 4. If none of the above, it's an undefined type identifier.
      this.reportError(`Type identifier '${name}' not found.`, ctx);
      console.log(`  > Not found. Reporting error.`);
      return UnknownType;
    }
    // --- Now check other complex types ---
    else if (ctx.adtType()) {
      const adtCtx = ctx.adtType()!;
      // --- Check for simple IDENTIFIER parsed as ADT ---
      // This happens when a type name like 'User' or 'Option' is used in an annotation
      // or as a type expression. The grammar parses single identifiers as AdtOptionNoArg.
      const adtOptions = adtCtx.adtOption();
      if (adtOptions.length === 1 && adtOptions[0] instanceof parser.AdtOptionNoArgContext) {
          const identifierName = adtOptions[0].IDENTIFIER().getText();
          console.log(`[visitPrimaryTypeExpr] Detected simple identifier '${identifierName}' parsed as adtType. Resolving as IDENTIFIER.`);
          // Resolve it as if it were a direct IDENTIFIER node.
              // This re-uses the logic from the `if (ctx.IDENTIFIER())` block above.
              // We need to be careful not to cause infinite recursion if IDENTIFIER() itself calls this.
              // Instead, explicitly apply the same resolution logic here:

              // 1. Check ADT/TypeAlias generic parameters (typeParams)
              if (typeParams && typeParams.find(p => p.name === identifierName)) {
                return typeParams.find(p => p.name === identifierName)!;
              }
              // 2. Check function signature generic parameters (typeVarsInSig)
              if (typeVarsInSig?.has(identifierName)) {
                return typeVarsInSig.get(identifierName)!;
              }
              // 3. Check environment
              const envType = this.environment.getType(identifierName);
              if (envType) {
                return envType;
              }
              // 4. Error
              this.reportError(`Type identifier '${identifierName}' (parsed as ADT) not found.`, ctx);
              return UnknownType;
      }
      // --- End Check for Simple Identifier ---

      // If it's a more complex ADT structure (e.g., with '|' or parameters),
      // it must be part of a type *definition*. Pass context down.
      console.log(`[visitPrimaryTypeExpr] Processing complex adtType definition: ${adtCtx.getText()}`);
      return this.visitAdtType(
        adtCtx,
        typeName, // Pass the potential outer type name being defined
        typeParams, // Pass the outer type parameters
        typeVarsInSig // Pass signature variables if any
      );
    } else if (ctx.literalUnionType()) { // Added before functionType
        return this.visitLiteralUnionType(ctx.literalUnionType()!, typeName, typeVarsInSig, typeParams);
    } else if (ctx.functionType()) {
      return this.visitFunctionType(ctx.functionType()!, typeVarsInSig);
    } else if (ctx.genericTypeExpr()) {
      return this.visitGenericTypeExpr(ctx.genericTypeExpr()!, typeVarsInSig);
    } else if (ctx.recordType()) {
      // Pass typeParams down to visitRecordType
      return this.visitRecordType(ctx.recordType()!, typeVarsInSig, typeParams);
    } else if (ctx.tupleType()) {
      return this.visitTupleType(ctx.tupleType()!, typeVarsInSig);
    } else if (ctx.primitiveType()) {
      return this.getPrimitiveType(ctx.primitiveType()!);
    } else if (ctx.typeExpr()) {
      // For '(' typeExpr ')'
      // Pass typeParams when visiting nested types
      return this.visitTypeExpr(
        ctx.typeExpr()!,
        typeName,
        typeVarsInSig,
        typeParams
      ); // Recursively call visitTypeExpr
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
    return new GenericType(this.nextTypeVarId++, typeName, typeArguments);
  }

  private visitFunctionType(
    ctx: parser.FunctionTypeContext,
    outerTypeVarsInSig?: Map<string, TypeVariable>
  ): ChicoryType {
    this.environment = this.environment.pushScope();
    const typeVarsInSig = outerTypeVarsInSig
      ? new Map(outerTypeVarsInSig)
      : new Map<string, TypeVariable>();
    
    const paramTypes = ctx.typeParam()
      ? ctx.typeParam().map((p) => this.visitParameterType(p, typeVarsInSig)) // Pass map
      : [];
    // Pass map to return type visit
    const returnType = this.visitTypeExpr(
      ctx.typeExpr(),
      undefined,
      typeVarsInSig
    );

    this.environment = this.environment.popScope();
    
    // Propagate discovered type variables back to the outer map
    if (outerTypeVarsInSig) {
      typeVarsInSig.forEach((typeVar, name) => {
        if (!outerTypeVarsInSig.has(name)) {
          outerTypeVarsInSig.set(name, typeVar);
        }
      });
    }
    
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
        const typeVar = new TypeVariable(this.nextTypeVarId++, name);
        typeVarsInSig.set(name, typeVar);
        // Declare in the temporary environment scope too
        this.environment.declare(name, typeVar, ctx, (str) =>
          this.reportError(str, ctx),
          []
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

  private visitStringLiteralType(ctx: parser.StringLiteralTypeContext): StringLiteralType {
    const literalValueWithQuotes = ctx.STRING().getText();
    const literalValue = literalValueWithQuotes.substring(1, literalValueWithQuotes.length - 1);
    return new StringLiteralType(literalValue);
  }

  private visitLiteralUnionType(
    ctx: parser.LiteralUnionTypeContext,
    typeName?: string,
    typeVarsInSig?: Map<string, TypeVariable>,
    typeParams?: TypeVariable[]
  ): ChicoryType {
    const literalValues = new Set<string>();
    ctx.stringLiteralType().forEach(sltCtx => {
      const strLiteralType = this.visitStringLiteralType(sltCtx);
      literalValues.add(strLiteralType.value);
    });

    if (literalValues.size === 1) {
      // If only one literal, it's just a StringLiteralType
      return new StringLiteralType(Array.from(literalValues)[0]);
    }
    return new LiteralUnionType(literalValues);
  }

  private visitRecordType(
    ctx: parser.RecordTypeContext,
    typeVarsInSig?: Map<string, TypeVariable>, // For function signatures
    typeParams?: TypeVariable[] // For type definitions (e.g., T in MyList<T>)
  ): ChicoryType {
    const recordType = new RecordType(new Map());
    ctx.recordTypeAnnotation().forEach((kv) => {
      const id = kv.IDENTIFIER()[0].getText(); // Field name
      const isOptional = kv.QUESTION() !== null; // Check if '?' is present

      let fieldType: ChicoryType;
      // Resolve the field's type by visiting its TypeExprContext.
      // This leverages visitPrimaryTypeExpr's error reporting for undefined identifiers.
      // Pass both typeVarsInSig (for function contexts) and typeParams (for type definition contexts).
      // Here are the possible kinds of expressions: (primitiveType | recordType | IDENTIFIER | tupleType | functionType | genericTypeExpr)
      // Pass map down when resolving field types
      if (kv.primitiveType()) {
        fieldType = this.getPrimitiveType(kv.primitiveType()!);
      } else if (kv.recordType()) {
        fieldType = this.visitRecordType(kv.recordType()!, typeVarsInSig); // Pass map
      } else if (kv.tupleType()) {
        fieldType = this.visitTupleType(kv.tupleType()!, typeVarsInSig); // Pass map
      } else if (kv.functionType()) {
        // visitFunctionType creates its own scope/map, doesn't need the outer one passed
        fieldType = this.visitFunctionType(kv.functionType()!, typeVarsInSig);
      } else if (kv.genericTypeExpr()) {
        fieldType = this.visitGenericTypeExpr(kv.genericTypeExpr()!, typeVarsInSig); // Pass map
      } else if (kv.IDENTIFIER()?.length > 1) { // Handles simple Identifier like 'User' or 'T'
        // Ensure it's the type identifier case
        const rhs = kv.IDENTIFIER()[1].getText(); // This assumes the second IDENTIFIER is the type
        // Check signature vars first, then environment, then fallback
        fieldType =
          typeVarsInSig?.get(rhs) ||
          this.environment.getType(rhs) ||
          typeParams?.find((p) => p.name === rhs) ||
          UnknownType;
        if (fieldType === UnknownType) {
          this.reportError(`Type '${rhs}' not found.`, kv);
        }
      } else {
        this.reportError(`Unknown record type annotation: ${kv.getText()}`, kv);
        fieldType = UnknownType;
      }

      // Store the field type and the optional flag directly
      recordType.fields.set(id, { type: fieldType, optional: isOptional });
      console.log(`[visitRecordType] Defined field '${id}' with type ${fieldType.toString()} (Optional: ${isOptional})`);
    });
    return recordType;
  }

  private visitAdtType(
    ctx: parser.AdtTypeContext,
    definedTypeName?: string, // Use the name passed from typeDefinition if available
    typeParams: TypeVariable[] = [],
    typeVarsInSig?: Map<string, TypeVariable>
  ): ChicoryType {
    // Use the definedTypeName if provided, otherwise default (should be rare now)
    const adtName = definedTypeName || "AnoymousADT";
    console.log(`[visitAdtType] Defining ADT '${adtName}'. Generic: ${typeParams.length > 0}. Type: ${new AdtType(adtName, typeParams)}`); // Log the actual name being used
    const adtType = new AdtType(adtName, typeParams);

    ctx.adtOption().forEach((option) => {
      let constructorName: string;
      let constructorType: FunctionType;

      if (option instanceof parser.AdtOptionAnonymousRecordContext) {
        constructorName = option.IDENTIFIER().getText();

        const recordType = new RecordType(new Map());
        option.adtTypeAnnotation().forEach((annotation) => {
          const fieldName = annotation.IDENTIFIER()[0].getText();
          let fieldType: ChicoryType = UnknownType;

          if (annotation.primitiveType()) {
            fieldType = this.getPrimitiveType(annotation.primitiveType()!);
          } else if (annotation.IDENTIFIER().length > 1) { // Field name is IDENTIFIER[0], type is IDENTIFIER[1]
            const typeIdentifierNode = annotation.IDENTIFIER()[1];
            const typeName = typeIdentifierNode.getText();
            let resolvedType: ChicoryType | undefined;

            // 1. Check ADT's own generic parameters
            if (typeParams) {
              resolvedType = typeParams.find(p => p.name === typeName);
            }

            // 2. Check function signature generic parameters (if ADT is defined in such a scope)
            if (!resolvedType && typeVarsInSig) {
              resolvedType = typeVarsInSig.get(typeName);
            }

            // 3. Check environment
            if (!resolvedType) {
              resolvedType = this.environment.getType(typeName);
            }

            if (resolvedType) {
              fieldType = resolvedType;
            } else {
              this.reportError(`Type identifier '${typeName}' for ADT field '${annotation.IDENTIFIER()[0].getText()}' not found.`, ctx);
              fieldType = UnknownType;
            }
          } else {
            // This case should ideally not be hit if grammar for AdtTypeAnnotation is correctly parsed
            // or if it's not an IDENTIFIER type. Could be another typeExpr.
            // For now, if it's not primitive and not a clear IDENTIFIER type, report error or handle other typeExprs.
            // Assuming AdtTypeAnnotation's IDENTIFIER rule implies the type is an identifier.
            this.reportError(`Invalid type in ADT constructor field '${fieldName}'. Expected primitive or type identifier.`, annotation);
            fieldType = UnknownType;
          }

          // Wrap the fieldType in a RecordField object (implicitly required)
          recordType.fields.set(fieldName, { type: fieldType, optional: false });
        });

        constructorType = new FunctionType(
          [recordType],
          adtType,
          constructorName
        );
      } else if (option instanceof parser.AdtOptionNamedTypeContext) {
        constructorName = option.IDENTIFIER()[0].getText();
        const paramTypeName = option.IDENTIFIER()[1].getText();

        const paramType =
          typeParams.find((p) => p.name === paramTypeName) ||
          this.environment.getType(paramTypeName) ||
          new TypeVariable(this.nextTypeVarId++, paramTypeName);

        constructorType = new FunctionType(
          [paramType],
          adtType,
          constructorName
        );
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
        throw new Error(`Unknown ADT option type: ${option.getText()}`);
      }

      // Use the resolved adtName when registering constructors
      this.constructors.push({
        adtName: adtName, // <<< Use resolved adtName
        name: constructorName,
        type: constructorType,
      });
      console.log(`[visitAdtType] Registered constructor: ${constructorName}: ${constructorType.toString()}`); // Log registration
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
        const typeExprCtx = ctx.typeExpr()!;
        const typeVarsInSig = new Map<string, TypeVariable>();
        const type = this.visitTypeExpr(typeExprCtx, undefined, typeVarsInSig);
        const genericParams = Array.from(typeVarsInSig.values());
        this.environment.declare(
          ctx.IDENTIFIER()!.getText(),
          type,
          ctx,
          (str) => this.reportError(str, ctx),
          genericParams
        );
      }

      if (ctx.bindingImportIdentifier()) {
        ctx
          .bindingImportIdentifier()!
          .bindingIdentifier()
          .forEach((bindingId) => {
            const id = bindingId.IDENTIFIER().getText();
            const typeExprCtx = bindingId.typeExpr();
            const typeVarsInSig = new Map<string, TypeVariable>();
            const type = this.visitTypeExpr(typeExprCtx, undefined, typeVarsInSig);
            const genericParams = Array.from(typeVarsInSig.values());
            this.environment.declare(id, type, ctx, (str) =>
              this.reportError(str, ctx),
              genericParams
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
                this.reportError(str, ctx),
                []
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
                this.reportError(str, ctx),
                []
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
              this.reportError(str, ctx),
              []
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
        // Pass empty visited set
        const finalExportType = this.applySubstitution(
          exportType,
          this.currentSubstitution,
          new Set()
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

  visitGlobalStmt(ctx: parser.GlobalStmtContext): ChicoryType {
    // Global statements simply define the type of the identifier and compile that identifier 1:1
    const id = ctx.IDENTIFIER()
    const typeExprCtx = ctx.typeExpr()!;
    const typeVarsInSig = new Map<string, TypeVariable>();
    const type = this.visitTypeExpr(typeExprCtx, undefined, typeVarsInSig);
    const genericParams = Array.from(typeVarsInSig.values());
    this.environment.declare(id.getText(), type, ctx, (str) =>
      this.reportError(str, ctx),
      genericParams
    );
    return UnitType;
  }

  visitExpr(ctx: parser.ExprContext, expectedType?: ChicoryType): ChicoryType {
    let primaryType = this.visitPrimaryExpr(ctx.primaryExpr(), expectedType); // Pass expectedType
    for (const tailExpr of ctx.tailExpr()) {
      // Tail expressions modify the primaryType; expectedType applies to the primary part.
      primaryType = this.visitTailExpr(tailExpr, primaryType);
    }
    return primaryType;
  }

  visitTailExpr(
    ctx: parser.TailExprContext,
    baseType: ChicoryType
  ): ChicoryType {
    // Apply substitution accumulated so far to the base type BEFORE checking it
    // Pass empty visited set
    baseType = this.applySubstitution(baseType, this.currentSubstitution, new Set());
    let resultType: ChicoryType = UnknownType; // Default result

    if (ctx.ruleContext instanceof parser.MemberExpressionContext) {
      const memberName = (ctx as parser.MemberExpressionContext)
        .IDENTIFIER()
        .getText();

      // --- Expand GenericType Alias Before Member Access ---
      let accessTargetType = baseType; // Start with the original base type (already substituted by outer context)
      if (accessTargetType instanceof GenericType && this.typeAliasDefinitions.has(accessTargetType.name)) {
          console.log(`[visitTailExpr] Member access on GenericType alias '${accessTargetType}'. Expanding.`);
          console.log(`  > Current substitution BEFORE expandAliasOnce:`, new Map(this.currentSubstitution)); // <<< Log before call

          // Use the expandAliasOnce which applies the instance-specific substitution correctly.
          const expandedTypeRaw = this.expandAliasOnce(accessTargetType, this.currentSubstitution);

          console.log(`  > Current substitution AFTER expandAliasOnce:`, new Map(this.currentSubstitution)); // <<< Log after call
          console.log(`  > Raw expanded type from expandAliasOnce: ${expandedTypeRaw.toString()}`); // <<< Log raw result toString

          // <<< Detailed inspection of the result >>>
          if (expandedTypeRaw instanceof RecordType && expandedTypeRaw.fields.has('value')) {
              const valueFieldType = expandedTypeRaw.fields.get('value')!;
              console.log(`    > Raw 'value' field type: ${valueFieldType.toString()} (${valueFieldType.constructor.name})`);
              if (valueFieldType instanceof GenericType) {
                  console.log(`      > Raw 'value' field args: [${valueFieldType.typeArguments.map(t => `${t.toString()}(id=${(t as any).id ?? 'N/A'})`).join(', ')}]`);
              }
          }
          // <<< End detailed inspection >>>


          if (expandedTypeRaw !== accessTargetType) {
              accessTargetType = expandedTypeRaw; // Use the raw type returned by expandAliasOnce

              // expandAliasOnce should return the final, correctly substituted type for this instance.
              // Any necessary application of the outer `this.currentSubstitution` should happen
              // naturally when accessing members or unifying later, not by forcing it here.

              // The expansion already applied the instance-specific substitution (e.g., T -> number).
              // We should NOT re-apply the outer substitution here, as it might contain conflicting
              // bindings from later code (e.g., T -> string from b3). The expanded type is now concrete
              // for the members we are about to access.
          } else {
               console.log(`  > Alias expansion did not change the type (or wasn't an alias).`);
          }
      } else if (accessTargetType instanceof GenericType) {
           console.log(`[visitTailExpr] Member access on GenericType '${accessTargetType}' (not a known alias, e.g., Option<number>).`);
           // It's a generic type like Option<number> but not an alias we can expand further.
           // We still need to apply outer substitution in case its arguments were type variables.
           // This is already done at the start of visitTailExpr, so accessTargetType is up-to-date.
      } else {
           console.log(`[visitTailExpr] Member access on non-GenericType '${accessTargetType}'.`);
      }
      // --- End Alias Expansion ---

      // Now check the potentially expanded type (accessTargetType)
      if (accessTargetType instanceof RecordType) {
        if (!accessTargetType.fields.has(memberName)) {
          this.reportError(
            `Member '${memberName}' not found on record type '${accessTargetType}'`, // Use accessTargetType in error
            ctx
          );
          resultType = UnknownType;
        } else {
          // Get the field type directly from the expanded record type (accessTargetType).
          // expandAliasOnce already produced the correctly substituted type for this instance (e.g., Option<number>).
          // We use this field type directly as the result for the member access.
          const fieldInfo = accessTargetType.fields.get(memberName)!;
          const fieldType = fieldInfo.type;
          console.log(`[visitTailExpr] Retrieved field '${memberName}' type directly from expanded record: ${fieldType.toString()}`);

          if (fieldInfo.optional) {
            // If the field is optional (marked with ?), the access result is Option<FieldType>
            const optionType = this.environment.getType("Option");
            if (optionType instanceof GenericType) {
               resultType = new GenericType(this.nextTypeVarId++, optionType.name, [fieldType]);
               this.prelude.requireOptionType();
               console.log(`[visitTailExpr] Optional field '${memberName}' accessed. Result type: ${resultType.toString()}`);
            } else {
               this.reportError("Option<T> builtin is not correctly defined.", ctx);
               resultType = UnknownType;
            }
          } else {
            // If the field is required, the access result is the field type directly
            resultType = fieldType;
            console.log(`[visitTailExpr] Required field '${memberName}' accessed. Result type: ${resultType.toString()}`);
          }
        }
      } else if (accessTargetType instanceof ArrayType) { // Check expanded type
        // Array methods logic: The element type needs to be derived from the potentially expanded accessTargetType
        // Apply substitution to the element type derived from the *potentially expanded* array type.
        // Pass empty visited set
        const elementType = this.applySubstitution(
          accessTargetType.elementType, // Get elementType from the potentially expanded ArrayType
          this.currentSubstitution,     // Apply current substitution to resolve any type vars within the element type
          new Set()
        ); // Substituted element type

        switch (memberName) {
          case "length":
            resultType = NumberType;
            break;
          case "map": {
            // Type: ( (T) => U ) => U[]
            const callbackReturnTypeVar = this.newTypeVar();
            const callbackType = new FunctionType(
              [elementType, NumberType],
              callbackReturnTypeVar
            );
            resultType = new FunctionType(
              [callbackType],
              new ArrayType(callbackReturnTypeVar)
            );
            break;
          }
          case "filter": {
            // Type: ( (T, number) => boolean ) => T[]
            const callbackType = new FunctionType([
              elementType,
              NumberType
            ], BooleanType);
            resultType = new FunctionType(
              [callbackType],
              new ArrayType(elementType) // Returns array of the *original* element type
            );
            break;
          }
          case "reduce": {
            // Type: ( (Acc, T, number) => Acc, Acc ) => Acc
            const accumulatorTypeVar = this.newTypeVar();
            const callbackType = new FunctionType(
              [accumulatorTypeVar, elementType, NumberType],
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
                new GenericType(this.nextTypeVarId++, optionType.name, [elementType]) // Option<T>
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
                new GenericType(this.nextTypeVarId++, "Option", [elementType])
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
                new GenericType(this.nextTypeVarId++, optionType.name, [NumberType]) // Option<number>
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
                new GenericType(this.nextTypeVarId++, "Option", [NumberType])
              );
            }
            break;
          }
          case "includes": {
            // Type: (T) => boolean (Ignoring optional fromIndex for now)
            resultType = new FunctionType([elementType], BooleanType);
            break;
          }
          case "concat": {
            // Type: (T | T[]) => T[] (Concatenates another array of the same element type, or a single element)
            // This is a simplification. A full implementation would use union types or overloads.
            // For now, we'll make it accept a single element, which is the common case for `addTodo`.
            resultType = new FunctionType([elementType], new ArrayType(elementType));
            break;
          }
          default:
            this.reportError(
              `Member '${memberName}' not found on array type '${accessTargetType}'`, // Use accessTargetType
              ctx
            );
            resultType = UnknownType;
        }
      } else if (accessTargetType instanceof TypeVariable) { // Check expanded type
        this.reportError(
          `Cannot access member '${memberName}' on value of unknown type '${accessTargetType}'. Add type annotation.`, // Use accessTargetType
          ctx
        );
        resultType = UnknownType;
      } else if (accessTargetType === StringType) { // Check expanded type
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
        // Error if the potentially expanded type is still not accessible
        this.reportError(
          `Cannot access member '${memberName}' on type '${accessTargetType}' (expected Record, Array, or String).`, // Use accessTargetType
          ctx
        );
        resultType = UnknownType;
      }
      // Add hint for the resulting type of the member access
      this.hints.push({ context: ctx, type: resultType.toString() });
    } else if (ctx.ruleContext instanceof parser.IndexExpressionContext) {
      const indexExprCtx = (ctx as parser.IndexExpressionContext).expr();
      // Pass empty visited set
      const indexType = this.applySubstitution(
        this.visitExpr(indexExprCtx),
        this.currentSubstitution,
        new Set()
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
            // Pass empty visited set
            resultType = this.applySubstitution(
              elementType,
              this.currentSubstitution,
              new Set()
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
          // Pass empty visited set
          const elementType = this.applySubstitution(
            baseType.elementType,
            this.currentSubstitution,
            new Set()
          );
          const optionType = this.environment.getType("Option"); // Look up the generic Option type

          if (optionType instanceof GenericType) {
            // Ensure the Option type definition has at least one type parameter
            if (
              optionType.typeArguments.length > 0 &&
              optionType.typeArguments[0] instanceof TypeVariable
            ) {
              // Directly create the instantiated GenericType: Option<ElementType>
              resultType = new GenericType(this.nextTypeVarId++, optionType.name, [elementType]);
              this.prelude.requireOptionType(); // Mark Option as used
            } else {
              this.reportError(
                `The 'Option' type definition found is not correctly defined as a generic type with a type parameter (e.g., Option<T>). Found: ${optionType}`,
                ctx
              );
              resultType = new GenericType(this.nextTypeVarId++, "Option", [elementType]); // Fallback placeholder
            }
          } else {
            this.reportError(
              "The 'Option' type is required for array indexing but is not defined or is not a generic type.",
              ctx
            );
            // Fallback: return placeholder Option<T>
            resultType = new GenericType(this.nextTypeVarId++, "Option", [elementType]);
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
    // Pass empty visited set
    baseType = this.applySubstitution(baseType, this.currentSubstitution, new Set());
    const rhsTypeSubstituted = this.applySubstitution(
      rhsType,
      this.currentSubstitution,
      new Set()
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
          // One is a variable, unify it with the other type.
          const result = this.unify(
            baseType,
            rhsTypeSubstituted,
            this.currentSubstitution
          );
          if (result instanceof Error) {
            this.reportError(
              `Operator '${operator}' cannot be applied to types '${baseType}' and '${rhsTypeSubstituted}': ${result.message}`,
              ctx
            );
            return UnknownType;
          }
          return BooleanType;
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

  visitPrimaryExpr(ctx: parser.PrimaryExprContext, expectedType?: ChicoryType): ChicoryType {
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
      return this.visitIfExpr(ctx.ifExpr(), expectedType); // Pass expectedType
    } else if (ctx instanceof parser.FunctionExpressionContext) {
      return this.visitFuncExpr(ctx.funcExpr(), expectedType); // Pass expectedType
    } else if (ctx instanceof parser.MatchExpressionContext) {
      return this.visitMatchExpr(ctx.matchExpr());
    } else if (ctx instanceof parser.JsxExpressionContext) {
       return this.visitJsxExpr(ctx.jsxExpr()); // <<< UNCOMMENT THIS
    }

    this.reportError(`Unknown primary expression type: ${ctx.getText()}`, ctx);
    return UnknownType;
  }

  visitIdentifier(ctx: parser.IdentifierExpressionContext): ChicoryType {
    const identifierName = ctx.IDENTIFIER().getText();
    console.log(`[visitIdentifier] ENTER: '${identifierName}'`);

    // 1. Check environment (variables, functions declared with let/const, etc.)
    const entry = this.environment.getEntry(identifierName);
    console.log(
      `  > Found in environment: ${entry ? entry.type.toString() : "null"}`
    );
    if (entry) {
      const { type: envType, genericParams } = entry;
      // Apply substitutions to the type found in the environment
      console.log(
        `  > Applying current substitution to env type:`,
        JSON.stringify(new Map(this.currentSubstitution)).slice(0, 80)
      );
      // Pass empty visited set
      let substitutedType = this.applySubstitution(
        envType,
        this.currentSubstitution,
        new Set()
      );
      console.log(`  > Substituted env type: ${substitutedType.toString()}`);

      // --- Check if it's a Nullary Constructor VALUE (Moved UP) ---
      const nullaryConstructor = this.constructors.find(c =>
          c.name === identifierName &&
          c.type instanceof FunctionType &&
          c.type.paramTypes.length === 0
      );

      if (nullaryConstructor) {
          console.log(`  > Identifier '${identifierName}' is a nullary constructor used as value.`);
          const returnType = (nullaryConstructor.type as FunctionType).returnType;
          console.log(`    > Nullary constructor return type (pre-instantiation): ${returnType.toString()}`);
          let finalReturnType = returnType;
          // Instantiate if the return type is generic (e.g., Option<T>)
          if (returnType instanceof GenericType && returnType.typeArguments.some(arg => arg instanceof TypeVariable || (arg instanceof GenericType && arg.typeArguments.length === 0))) {
              console.log(`    > Return type is generic and needs instantiation.`);
              finalReturnType = this.instantiateGenericType(returnType);
              console.log(`    > Instantiated nullary generic constructor return type ${identifierName}: ${returnType} -> ${finalReturnType}`);
          } else {
              console.log(`    > Return type is not generic or doesn't need instantiation.`);
          }
          // Store and return the INSTANCE type
          console.log(`[visitIdentifier] Setting type for Nullary Constructor Value '${identifierName}' (Ctx: ${ctx.start?.start}-${ctx.stop?.stop}): ${finalReturnType.toString()}`); // LOGGING ADDED
          this.setExpressionType(ctx, finalReturnType);
          this.hints.push({ context: ctx, type: finalReturnType.toString() });
          console.log(`[visitIdentifier] EXIT: Returning nullary constructor instance type: ${finalReturnType.toString()}`);
          return finalReturnType;
      }
      // --- End Nullary Constructor Check (Moved UP) ---

      // If it wasn't handled as a nullary constructor value, proceed with regular env type handling:
      // If it's a function type from the env that might be generic, instantiate it.
      else if (substitutedType instanceof FunctionType) { // <<< Added 'else' here
        // <<< ADDED: Store the resolved type in the map for the compiler >>>
        console.log(`[visitIdentifier] Setting type for Env Function '${identifierName}' (Ctx: ${ctx.start?.start}-${ctx.stop?.stop}): ${substitutedType.toString()}`); // LOGGING ADDED
        this.setExpressionType(ctx, substitutedType);
        // <<< END ADDED >>>
        console.log(
          `  > Substituted type is FunctionType. Checking if instantiation needed.`
        );
        // Check if it contains type variables that might need instantiation
        console.log(`  > Contains generic params? ${genericParams.length > 0}`);

        if (genericParams.length > 0) {
          // Potentially generic function found in env, instantiate it
          console.log(`  > Instantiating function type from environment.`);
          substitutedType = this.instantiateFunctionType(substitutedType, genericParams);
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

          const adtDefinitionEntry = this.environment.getEntry(constructor.adtName);
          const adtDefinition = adtDefinitionEntry?.type;
          const adtGenericParams = adtDefinitionEntry?.genericParams ?? [];

          console.log(
            `  > ADT definition for '${constructor.adtName}': ${
              adtDefinition ? adtDefinition.toString() : "null"
            }`
          );
          let typeToReturn: ChicoryType = originalConstructorType; // Start with the original function type

          // Check if the ADT itself is generic. If so, instantiate the constructor's FUNCTION type.
          if (
            adtDefinition instanceof GenericType &&
            adtGenericParams.length > 0
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
                originalConstructorType as FunctionType,
                adtGenericParams
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

          // Store the resolved type in the map for the compiler
          console.log(`[visitIdentifier] Setting type for Non-Nullary Constructor Function '${identifierName}' (Ctx: ${ctx.start?.start}-${ctx.stop?.stop}): ${typeToReturn.toString()}`); // LOGGING ADDED
          this.setExpressionType(ctx, typeToReturn);

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
  }

  visitRecordExpr(ctx: parser.RecordExprContext): ChicoryType {
    const fields = new Map<string, RecordField>();
    ctx.recordKvExpr().forEach((kv) => {
      const key = kv.IDENTIFIER().getText();
      const valueType = this.visitExpr(kv.expr());
      fields.set(key, { type: valueType, optional: false });
    });

    const literalRecordType = new RecordType(fields);

    // --- Type Check Against Expected Type (if provided) ---
    // This logic is primarily for assignment/function args where an expected type exists.
    // We need to get the expected type from the context (e.g., assignment annotation).
    // This requires modifying how visitExpr/visitAssignStmt pass down expected types.
    // For now, we'll focus on the structure; integration needs refinement.

    // Example placeholder for expected type logic:
    // const expectedType = this.getExpectedTypeForContext(ctx); // Hypothetical function
    // if (expectedType instanceof RecordType) {
    //    this.checkRecordLiteralAgainstExpected(literalRecordType, expectedType, ctx);
    // }

    // Store the inferred type of the literal itself
    this.setExpressionType(ctx, literalRecordType);
    this.hints.push({ context: ctx, type: literalRecordType.toString() });

    return literalRecordType;
  }

  // Helper (potentially moved or integrated into unify/visitAssignStmt)
  private checkRecordLiteralAgainstExpected(
      literalType: RecordType,
      expectedType: RecordType,
      ctx: parser.RecordExprContext
  ): void {
      const providedKeys = new Set(literalType.fields.keys());

      // Check provided fields against expected fields
      for (const [key, literalField] of literalType.fields) {
          const expectedField = expectedType.fields.get(key);
          if (!expectedField) {
              this.reportError(`Field '${key}' is not expected in type '${expectedType}'`, ctx);
              continue;
          }

          let typeToUnify = literalField.type; // Type provided in the literal

          // Unify the provided type with the *inner* type of the expected field
          const unificationResult = this.unify(
              expectedField.type, // The T in expected type { key: T } or { key?: T }
              typeToUnify,
              this.currentSubstitution
          );

          if (unificationResult instanceof Error) {
              this.reportError(
                  `Type mismatch for field '${key}'. Expected '${expectedField.type}', but got '${typeToUnify}'. ${unificationResult.message}`,
                  ctx // TODO: Pinpoint error to specific kv pair context
              );
          }
      }

      // Check for missing fields
      for (const [key, expectedField] of expectedType.fields) {
          if (!providedKeys.has(key)) {
              // Field is missing in the literal
              if (!expectedField.optional) {
                  // It's missing AND required
                  this.reportError(`Missing required field '${key}' in record literal of type '${expectedType}'`, ctx);
              }
              // If it's missing and optional, it's allowed.
          }
      }
  }

  visitArrayLikeExpr(ctx: parser.ArrayLikeExprContext): ChicoryType {
    const elementExprs = ctx.expr(); // Get all expression contexts
    if (elementExprs.length === 0) {
      // It doesn't make sense to assume an empty tuple, since they have a fixed number of elements.
      // So, defaulting to ArrayType<Unknown>.
      // Unification might resolve Unknown later if assigned or used.
      const freshElementType = this.newTypeVar("t_array_element");
      const emptyArrayType = new ArrayType(freshElementType); // Default empty array to Array<unknown>
      this.hints.push({
        context: ctx,
        type: emptyArrayType.toString(),
      });
      return emptyArrayType;
      // Alternative, default to:
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
    const stmts = ctx.stmt()
    stmts.forEach((stmt) => this.visitStmt(stmt));

    let blockType: ChicoryType;
    if (stmts.at(-1)?.expr()) { // Check if the final expression exists and is an expr
      blockType = this.visitExpr(stmts.at(-1)?.expr()!);
    } else {
      // Block is empty or ends with one or more statements, but no final expression.
      blockType = UnitType;
    }

    this.environment = this.environment.popScope()!; // Pop the scope
    return blockType;
  }

  visitIfExpr(ctx: parser.IfExprContext, expectedType?: ChicoryType): ChicoryType {
    const conditionType = this.visitExpr(ctx.justIfExpr()[0].expr()[0]); // Condition doesn't use expectedType

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

    // Pass expectedType to branches
    const thenType = this.visitExpr(ctx.justIfExpr()[0].expr()[1], expectedType);

    for (let i = 1; i < ctx.justIfExpr().length; i++) {
      const elseIfConditionType = this.visitExpr(ctx.justIfExpr()[i].expr()[0]); // Condition doesn't use expectedType

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
      this.visitExpr(ctx.justIfExpr()[i].expr()[1], expectedType); // Pass expectedType
    }

    if (ctx.expr()) {
      // Note: We are not requiring same types
      return this.visitExpr(ctx.expr()!, expectedType); // Pass expectedType
    }

    return thenType;
  }

  visitFuncExpr(ctx: parser.FuncExprContext, expectedType?: ChicoryType): ChicoryType {
    this.environment = this.environment.pushScope(); // Push a new scope for function parameters

    const actualParamTypes: ChicoryType[] = [];
    let expectedParamTypesFromContext: ChicoryType[] | null = null;
    let expectedReturnTypeFromContext: ChicoryType | null = null;
    let funcArity = 0;

    if (ctx instanceof parser.ParenFunctionExpressionContext && ctx.parameterList()) {
        funcArity = ctx.parameterList()!.idOrWild().length;
    } else if (ctx instanceof parser.ParenlessFunctionExpressionContext) {
        funcArity = 1;
    }

    if (expectedType instanceof FunctionType) {
      if (funcArity <= expectedType.paramTypes.length) {
          expectedParamTypesFromContext = expectedType.paramTypes;
          expectedReturnTypeFromContext = expectedType.returnType;
          console.log(`[visitFuncExpr] Using expected types for params (up to arity ${funcArity}): [${expectedParamTypesFromContext.slice(0, funcArity).map(p => p.toString()).join(', ')}], expected return: ${expectedReturnTypeFromContext.toString()}`);
      } else {
          this.reportError(
              `Function expression provides ${funcArity} parameters, but context expects a function with only ${expectedType.paramTypes.length} parameters.`,
              ctx
          );
      }
    }


    if (ctx instanceof parser.ParenFunctionExpressionContext && ctx.parameterList()) {
        ctx.parameterList()!.idOrWild().forEach((paramNode, index) => {
            const paramName = paramNode.getText();
            const paramType = (expectedParamTypesFromContext && expectedParamTypesFromContext[index])
                ? expectedParamTypesFromContext[index]
                : this.newTypeVar(paramName === "_" ? `t_ignored_${index}` : `t_param_${paramName}`);

            if (paramName !== "_") {
                this.environment.declare(paramName, paramType, ctx, (str) => this.reportError(str, ctx), []);
            } else {
                // For '_', we still need to track its type for the function signature,
                // but we don't declare it in the environment.
                // This allows multiple '_' parameters.
                // Add a hint for '_' to show its inferred type.
                this.hints.push({ context: paramNode, type: paramType.toString() });
            }
            actualParamTypes.push(paramType);
        });
    } else if (ctx instanceof parser.ParenlessFunctionExpressionContext) {
        const paramNode = ctx.IDENTIFIER();
        const paramName = paramNode.getText();
        const paramType = (expectedParamTypesFromContext && expectedParamTypesFromContext[0])
            ? expectedParamTypesFromContext[0]
            : this.newTypeVar(paramName === "_" ? `t_ignored_0` : `t_param_${paramName}`);

        if (paramName !== "_") {
            this.environment.declare(paramName, paramType, ctx, (str) => this.reportError(str, ctx), []);
        } else {
            // For '_', add a hint to show its inferred type.
            this.hints.push({ context: ctx, type: paramType.toString() });
        }
        actualParamTypes.push(paramType);
    } else if (ctx instanceof parser.ParenFunctionExpressionWildcardContext || ctx instanceof parser.ParenlessFunctionExpressionWildcardContext) {
        const paramType = this.newTypeVar(`t_ignored_0`);
        this.hints.push({ context: ctx, type: paramType.toString() });
        actualParamTypes.push(paramType);
    } 

    // Determine the expected type for the body based on the context, if available
    const bodyExpectedType = expectedReturnTypeFromContext ?? undefined;
    const actualBodyReturnType = this.visitExpr((ctx as any).expr(), bodyExpectedType);

    const inferredBodyReturnType = this.applySubstitution(actualBodyReturnType, this.currentSubstitution, new Set());

    // If an expected return type is provided (e.g., from a JSX prop like onClick: () => void),
    // check compatibility.
    if (expectedReturnTypeFromContext) {
        // If the expected return type is 'void' (UnitType), any actual return type from the body is acceptable.
        // The calling context (e.g., JSX attribute unification) will handle the overall function type compatibility.
        if (expectedReturnTypeFromContext === UnitType) {
            console.log(`[visitFuncExpr] Expected return type is void. Inferred body return type '${inferredBodyReturnType}' is acceptable and will be ignored by caller.`);
        } else {
            // For non-void expected return types, unify strictly.
            const unificationResult = this.unify(expectedReturnTypeFromContext, inferredBodyReturnType, this.currentSubstitution);
            if (unificationResult instanceof Error) {
                this.reportError(
                    `Function body's return type '${inferredBodyReturnType}' is not compatible with expected return type '${expectedReturnTypeFromContext}'. ${unificationResult.message}`,
                    (ctx as any).expr()
                );
            }
        }
    }

    // Apply the function's LOCAL substitution to finalize its signature
    const finalParamTypes = actualParamTypes.map(type => this.applySubstitution(type, this.currentSubstitution, new Set()));
    const finalReturnType = this.applySubstitution(inferredBodyReturnType, this.currentSubstitution, new Set());

    this.environment = this.environment.popScope()!;

    const resultFuncType = new FunctionType(finalParamTypes, finalReturnType);
    console.log(`[visitFuncExpr] Resulting function type: ${resultFuncType.toString()}`);
    return resultFuncType;
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
      JSON.stringify(new Map(this.currentSubstitution)).slice(0,80)
    );

    // Apply *outer* substitutions to the function type *before* doing anything else.
    // This resolves any type variables bound *outside* the function call itself.
    // Pass empty visited set
    const substitutedFunctionType = this.applySubstitution(
      functionType,
      this.currentSubstitution, // Use the substitution context from *before* this call
      new Set()
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
             // Get the expected type for this specific argument from the function's signature
             const expectedArgType = funcType.paramTypes.length > i ? funcType.paramTypes[i] : undefined;
             if (expectedArgType) {
              console.log(`    > Expected type for arg ${i + 1}: ${expectedArgType.toString().slice(0, 80)}`);
             } else {
              console.log(`    > No specific expected type for arg ${i + 1} (or arity mismatch).`);
             }
             const argType = this.visitExpr(expr, expectedArgType); // Pass down the expected type
             console.log(`    > Arg ${i + 1} type (raw, after visitExpr): ${argType.toString()}`);
             return argType;
           })
         : [];
    console.log(`  > Finished visiting arguments.`);
    console.log(
        `  currentSubstitution (after visiting args):`,
        JSON.stringify(new Map(this.currentSubstitution)).slice(0,80)
      );

    // Apply current substitutions to argument types as well, as visitExpr might have updated them.
    // Pass empty visited set
    const substitutedArgumentTypes = argumentTypes.map((argType, i) => {
      const substArgType = this.applySubstitution(
        argType,
        this.currentSubstitution,
        new Set()
      );
      console.log(
        `  > Arg ${i + 1} type (substituted): ${substArgType.toString()}`
      );
      return substArgType;
    });

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

    // Unify arguments with parameters using the main substitution map.
    // This will propagate constraints from the call site to the rest of the checker.
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
      // The main substitution map `this.currentSubstitution` is updated by `unify`.
      const result = this.unify(
        paramType, // Parameter type from the (potentially substituted) function signature
        argType, // Argument type resolved in the current context
        this.currentSubstitution // <<< Use the main substitution map
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
        // On error, we don't know the type.
        this.setExpressionType(ctx.expr(i)!, UnknownType);
        this.hints.push({ context: ctx.expr(i)!, type: UnknownType.toString() });
      } else {
        // On success, the argument's type is now constrained.
        // Apply substitutions to get its most up-to-date form and store it.
        const finalArgType = this.applySubstitution(result, this.currentSubstitution, new Set());
        this.setExpressionType(ctx.expr(i)!, finalArgType);
        this.hints.push({ context: ctx.expr(i)!, type: finalArgType.toString() });
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
    
    // Calculate the final return type by applying the main substitution map
    // to the function's declared return type.
    console.log(
      `  > Calculating final return type from '${funcType.returnType.toString()}' using main substitution.`
    );
    let finalReturnType = this.applySubstitution(
      funcType.returnType,
      this.currentSubstitution, // <<< Use the main substitution map
      new Set() // Pass empty visited set for final application
    );
    console.log(
      `  > Final return type (calculated via applySubstitution): ${finalReturnType.toString()}`
    );

    // Store and add hint for the final, calculated return type
    console.log(
      `  > Storing final return type for expression: ${finalReturnType.toString()}`
    );
    this.setExpressionType(ctx, finalReturnType);
    this.hints.push({ context: ctx, type: finalReturnType.toString() });

    console.log(
      `[visitCallExpr] EXIT: Returning final type: ${finalReturnType.toString()}`
    );
    return finalReturnType;
  }

  // --- BEGIN REFACTORED visitMatchExpr ---
  visitMatchExpr(ctx: parser.MatchExprContext): ChicoryType {
    const matchedExprCtx = ctx.expr();
    const matchedType = this.visitExpr(matchedExprCtx);
    // Pass empty visited set
    const appliedMatchedType = this.applySubstitution(
      matchedType,
      this.currentSubstitution,
      new Set()
    );

    console.log(
      `[visitMatchExpr] Start. Matched type: ${appliedMatchedType.toString()}`
    );

    if (ctx.matchArm().length === 0) {
      this.reportError("Match expression must have at least one arm.", ctx);
      return UnknownType;
    }

    // --- Process First Arm (to potentially refine matched type) ---
    const firstArm = ctx.matchArm(0)!;
    const firstArmPatternCtx = firstArm.matchPattern();
    let refinedMatchedType = appliedMatchedType; // Start with the initially inferred type
    let coverage: MatchCoverage | null = null; // Initialize later
    let returnTypes: ChicoryType[] = [];
    let firstArmType: ChicoryType | null = null;

    this.environment = this.environment.pushScope();
    // Analyze the first pattern
    const firstPatternInfo = this.analyzePattern(
      firstArmPatternCtx,
      appliedMatchedType
    );
    // Visit the first pattern - this performs unification and updates currentSubstitution
    this.visitPattern(firstArmPatternCtx, appliedMatchedType);
    // NOW, get the potentially refined type after unification
    // Pass empty visited set
    refinedMatchedType = this.applySubstitution(
      matchedType,
      this.currentSubstitution,
      new Set()
    );
    console.log(
      `[visitMatchExpr] Refined matched type after first pattern: ${refinedMatchedType.toString()}`
    );
    // Initialize coverage based on the REFINED type
    coverage = this.initializeCoverage(refinedMatchedType, ctx);
    // Check reachability and record coverage for the FIRST arm using the NEW coverage object
    const isFirstArmReachable = this.checkReachabilityAndRecordCoverage(
      firstPatternInfo,
      coverage,
      firstArmPatternCtx
    );
    // Type check the first arm's expression
    const firstArmExprType = this.visitExpr(firstArm.expr());
    // Pass empty visited set
    firstArmType = this.applySubstitution(
      firstArmExprType,
      this.currentSubstitution,
      new Set()
    );
    returnTypes.push(firstArmType);
    this.environment = this.environment.popScope();

    // --- Process Remaining Arms ---
    for (let i = 1; i < ctx.matchArm().length; i++) {
      const arm = ctx.matchArm(i)!;
      const armPatternCtx = arm.matchPattern();

      this.environment = this.environment.pushScope();

      // 1. Analyze Pattern (use refined type)
      const patternInfo = this.analyzePattern(
        armPatternCtx,
        refinedMatchedType
      );
      console.log(
        `[visitMatchExpr] Arm ${i}: Pattern='${armPatternCtx.getText()}', Info=${JSON.stringify(
          patternInfo
        )}`
      );

      // 2. Check Reachability (use existing coverage object)
      const isReachable = this.checkReachabilityAndRecordCoverage(
        patternInfo,
        coverage, // Use the coverage object initialized after the first arm
        armPatternCtx
      );

      if (!isReachable) {
        // Error already reported by checkReachabilityAndRecordCoverage
        // Still visit pattern/expr to find other potential errors in unreachable code
        this.visitPattern(armPatternCtx, refinedMatchedType); // Bind vars etc.
        this.visitExpr(arm.expr()); // Type check expression
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
      // Pass empty visited set
      const appliedArmReturnType = this.applySubstitution(
        armReturnType,
        this.currentSubstitution,
        new Set()
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
          // Pass empty visited set
          firstArmType = this.applySubstitution(
            unificationResult,
            this.currentSubstitution,
            new Set()
          );
        }
      }

      this.environment = this.environment.popScope();
    } // End loop through arms

    // --- Final Exhaustiveness Check ---
    // Use the refined type for the check
    // Pass empty visited set
    const finalRefinedMatchedType = this.applySubstitution(
      matchedType,
      this.currentSubstitution,
      new Set()
    );
    
    // Re-initialize coverage with the final refined type to handle cases where
    // the matched type started as a TypeVariable and got unified to an ADT type
    // during pattern matching. Only update the coverage TYPE, keep the existing
    // pattern tracking data.
    const finalCoverage = this.initializeCoverageWithExisting(finalRefinedMatchedType, coverage, ctx);
    
    this.checkExhaustiveness(finalCoverage, finalRefinedMatchedType, ctx);

    // --- Determine Final Type ---
    let finalArmType = firstArmType ?? UnknownType; // Use firstArmType if valid, else Unknown
    if (returnTypes.length === 0) {
      this.reportError("Match expression has no arms.", ctx);
      finalArmType = UnknownType;
    }

    // Apply final substitutions
    // Pass empty visited set
    finalArmType = this.applySubstitution(
      finalArmType,
      this.currentSubstitution,
      new Set()
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
      // Check if this identifier is *any* known nullary constructor globally.
      // The type check happens later in visitPattern.
      const globalConstructor = this.constructors.find(
        (c) =>
          c.name === idName &&
          c.type instanceof FunctionType &&
          c.type.paramTypes.length === 0
      );

      if (globalConstructor) {
        // It looks like a bare ADT constructor.
        console.log(
          `[analyzePattern] Treating identifier '${idName}' as potential adt_bare.`
        );
        return {
          type: "adt_bare",
          variantName: idName,
          patternString: idName, // Bare name is unique string
        };
      }
      // Otherwise, it's treated as a variable binding pattern.
      console.log(
        `[analyzePattern] Treating identifier '${idName}' as a variable pattern.`
      );
      return { type: "variable", patternString: "var" }; // Canonical string for variable pattern
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

  // Helper method to re-initialize coverage with final refined type while preserving pattern data
  private initializeCoverageWithExisting(
    matchedType: ChicoryType,
    existingCoverage: MatchCoverage,
    ctx: parser.MatchExprContext
  ): MatchCoverage {
    // Get the new coverage type classification based on the final refined type
    const newCoverage = this.initializeCoverage(matchedType, ctx);
    
    // If the new coverage is ADT type but the old wasn't, we need to update
    if (newCoverage.type === "adt" && existingCoverage.type !== "adt") {
      console.log(`[initializeCoverageWithExisting] Updating coverage from '${existingCoverage.type}' to 'adt' for refined type: ${matchedType.toString()}`);
      
      // Transfer the pattern tracking data to the new ADT coverage
      newCoverage.processedPatterns = existingCoverage.processedPatterns;
      
      // Analyze the processed patterns to determine ADT coverage
      if (existingCoverage.processedPatterns) {
        for (const patternStr of existingCoverage.processedPatterns) {
          // Check if this pattern corresponds to an ADT variant
          if (patternStr === "None") {
            // Bare ADT pattern - remove from remaining variants
            newCoverage.remainingVariants?.delete("None");
          } else if (patternStr.startsWith("Some(")) {
            // ADT with parameter pattern - remove from remaining variants
            newCoverage.remainingVariants?.delete("Some");
          }
          // Add other pattern types as needed
        }
      }
      
      // If a wildcard/param was seen in the old coverage, mark as such
      if (existingCoverage.wildcardOrParamSeen) {
        newCoverage.remainingVariants?.clear();
        newCoverage.wildcardOrParamSeen = true;
      }
      
      // Update wildcardOrParamSeen if all variants are now covered
      if (newCoverage.remainingVariants?.size === 0) {
        newCoverage.wildcardOrParamSeen = true;
      }
      
      console.log(`[initializeCoverageWithExisting] Updated ADT coverage:`, {
        adtName: newCoverage.adtName,
        remainingVariants: Array.from(newCoverage.remainingVariants || []),
        wildcardOrParamSeen: newCoverage.wildcardOrParamSeen
      });
      
      return newCoverage;
    }
    
    // Otherwise, return the existing coverage unchanged
    return existingCoverage;
  }

  // --- END NEW HELPER METHODS ---

  visitMatchArm(
    ctx: parser.MatchArmContext,
    matchedType: ChicoryType
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
  ): void {
    // Apply substitution to matchedType *before* checking its instance type
    // Pass empty visited set
    matchedType = this.applySubstitution(matchedType, this.currentSubstitution, new Set()); // Use main substitution

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
          this.reportError(str, ctx),
          []
        );
        this.hints.push({ context: ctx, type: UnknownType.toString() });
      }
      // Add similar handling for other patterns that bind variables.
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
        const instantiationSubst = new Map<number, ChicoryType>();
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
                typeVar.id,
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

      // The type of the variable `paramName` IS the `expectedParamType` after applying substitutions
      // that might have occurred *before* this pattern was visited.
      // Pass empty visited set
      const finalParamType = this.applySubstitution(
        expectedParamType,
        this.currentSubstitution,
        new Set()
      );

      // **** We *declare* the pattern variable `paramName` with the calculated `finalParamType`.
      // **** Constraints happen when `paramName` is *used* in the arm's expression.

      // Declare the parameter variable in the arm's scope
      this.environment.declare(
        paramName,
        finalParamType,
        ctx,
        (
          str // Use finalParamType
        ) => this.reportError(str, ctx),
        []
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
        const instantiationSubst = new Map<number, ChicoryType>();
        const adtDefinition = this.environment.getType(baseTypeName);
        if (
          adtDefinition instanceof GenericType &&
          adtDefinition.typeArguments.length ===
            matchedType.typeArguments.length
        ) {
          adtDefinition.typeArguments.forEach((typeVar, index) => {
            if (typeVar instanceof TypeVariable) {
              instantiationSubst.set(
                typeVar.id,
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
        // Pass empty visited set
        const finalExpected = this.applySubstitution(
          expectedParamType,
          this.currentSubstitution,
          new Set()
        );
        this.reportError(
          `Literal ${literalValueStr} of type '${literalType}' is not compatible with expected parameter type '${finalExpected}' for constructor '${adtName}'. ${unificationResult.message}`,
          literalCtx
        );
      } else {
        // Unification succeeded, potentially refining types in this.currentSubstitution
        console.log(
          `[visitPattern] Literal ${literalValueStr} successfully unified with expected type ${this.applySubstitution( // Pass empty visited set
            expectedParamType,
            this.currentSubstitution,
            new Set()
          )}`
        );
      }

      // --- LiteralMatchPatternContext ---
    } else if (ctx.ruleContext instanceof parser.LiteralMatchPatternContext) {
      const literalCtx = (ctx as parser.LiteralMatchPatternContext).literal();
      const literalType = this.visitLiteral(literalCtx);
      const literalValueStr = literalCtx.getText();
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
        // Pass empty visited set
        const finalMatchedType = this.applySubstitution(
          matchedType,
          this.currentSubstitution,
          new Set()
        );
        this.reportError(
          `Cannot match literal ${literalValueStr} of type '${literalType}' against incompatible value of type '${finalMatchedType}'. ${result.message}`,
          ctx
        );
      } else {
        console.log(
          `[visitPattern] Literal pattern ${literalValueStr} successfully unified with matched type ${this.applySubstitution( // Pass empty visited set
            matchedType,
            this.currentSubstitution,
            new Set()
          )}`
        );
      }

      // --- Other pattern types (BareAdt, Wildcard, etc.) ---
    } else if (
      ctx.ruleContext instanceof parser.BareAdtOrVariableMatchPatternContext
    ) {
      const idName = (ctx as parser.BareAdtOrVariableMatchPatternContext)
        .IDENTIFIER()!
        .getText();

      // Re-check if it's a known nullary constructor (matching analyzePattern's logic)
      const constructor = this.constructors.find(
        (c) =>
          c.name === idName &&
          c.type instanceof FunctionType &&
          c.type.paramTypes.length === 0
      );

      if (constructor) {
        // It's an ADT Bare pattern.
        console.log(`[visitPattern] Checking pattern (bare ADT): ${idName}`);

        // Get the constructor's return type (e.g., Friend, Option<T>, Result<T,E>)
        const constructorReturnType = (constructor.type as FunctionType)
          .returnType;

        // *** Crucial Step: Unify the matched type (e.g., T0) with the constructor's return type (e.g., Friend) ***
        console.log(
          `[visitPattern] Unifying matched type '${matchedType}' with bare ADT return type '${constructorReturnType}'`
        );
        const unificationResult = this.unify(
          matchedType,
          constructorReturnType,
          this.currentSubstitution // Use the main substitution map
        );

        if (unificationResult instanceof Error) {
          // Pass empty visited set
          const finalMatchedType = this.applySubstitution(
            matchedType,
            this.currentSubstitution,
            new Set()
          );
          this.reportError(
            `Cannot match ADT constructor '${idName}' (type '${constructorReturnType}') against incompatible value of type '${finalMatchedType}'. ${unificationResult.message}`,
            ctx
          );
        } else {
          console.log(
            `[visitPattern] Bare ADT pattern ${idName} successfully unified matched type with ${this.applySubstitution( // Pass empty visited set
              constructorReturnType,
              this.currentSubstitution,
              new Set()
            )}`
          );
          // Check arity just in case (should be 0, but good practice)
          if ((constructor.type as FunctionType).paramTypes.length > 0) {
            this.reportError(
              `Internal Error: Constructor '${idName}' identified as bare but expects arguments.`,
              ctx
            );
          }
        }
      } else {
        // It's a variable pattern.
        console.log(
          `[visitPattern] Binding variable pattern '${idName}' with type '${matchedType}'`
        );
        // Bind the variable in the current scope with the matched type
        this.environment.declare(idName, matchedType, ctx, (str) => {
          this.reportError(str, ctx);
        }, []);
        this.hints.push({ context: ctx, type: matchedType.toString() });
      }
    } else if (
      ctx.ruleContext instanceof parser.AdtWithWildcardMatchPatternContext
    ) {
      const adtName = (ctx as parser.AdtWithWildcardMatchPatternContext)
        .IDENTIFIER()
        .getText();
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
    } else {
      console.error(
        `[visitPattern] Unhandled pattern context type: ${ctx.constructor.name}`
      );
      this.reportError(`Unsupported pattern type: ${ctx.getText()}`, ctx);
    }
  }

  visitJsxExpr(ctx: parser.JsxExprContext): ChicoryType {
    console.log(`[visitJsxExpr] ENTER: ${ctx.getText().substring(0, 30)}...`);
    let tagName: string;
    let attributesCtx: parser.JsxAttributesContext | null = null;
    let openingElement: parser.JsxOpeningElementContext | null = null;
    let selfClosingElement: parser.JsxSelfClosingElementContext | null = null;

    if (ctx.jsxOpeningElement()) {
      openingElement = ctx.jsxOpeningElement()!;
      tagName = openingElement.IDENTIFIER().getText();
      attributesCtx = openingElement.jsxAttributes() ?? null;

      // Check for matching closing tag
      const closingElement = ctx.jsxClosingElement();
      if (closingElement) {
        const closingTagName = closingElement.IDENTIFIER().getText();
        if (tagName !== closingTagName) {
          this.reportError(
            `Expected corresponding JSX closing tag for '<${tagName}>'. Found '</${closingTagName}>' instead.`,
            closingElement // Report error on the closing tag context
          );
          // Even with mismatched tags, we might try to proceed with type checking based on the opening tag
          // to provide more errors, or we could return UnknownType here.
          // For now, report and continue.
        }
      } else {
        // This case should ideally be caught by the parser if the grammar expects a closing tag.
        // If it can happen, it means an opening tag exists without any closing tag.
        this.reportError(
          `Missing corresponding JSX closing tag for '<${tagName}>'.`,
          openingElement // Report error on the opening tag
        );
      }
      
      // Handle children
      ctx.jsxChild().forEach(child => {
        if (child instanceof parser.JsxChildJsxContext) {
          this.visitJsxExpr(child.jsxExpr());
        } else if (child instanceof parser.JsxChildExpressionContext) {
          // Type check the expression within { ... }
          const childExprType = this.visitExpr(child.expr());
          const substitutedChildExprType = this.applySubstitution(childExprType, this.currentSubstitution, new Set());

          // Check if it's a valid JSX child type
          let isValidJsxChild = false;
          
          // Check for JSX element
          if (substitutedChildExprType instanceof JsxElementType) {
            isValidJsxChild = true;
          }
          // Check for string or number
          else if (substitutedChildExprType === StringType || substitutedChildExprType === NumberType) {
            isValidJsxChild = true;
          }
          // Check for array of JSX elements (this is the key addition)
          else if (substitutedChildExprType instanceof ArrayType && substitutedChildExprType.elementType instanceof JsxElementType) {
            isValidJsxChild = true;
          }
          // Try to unify with valid types as a fallback for type variables
          else if (substitutedChildExprType instanceof TypeVariable) {
            // Try string first
            const stringUnification = this.unify(substitutedChildExprType, StringType, this.currentSubstitution);
            if (!(stringUnification instanceof Error)) {
              isValidJsxChild = true;
            } else {
              // Try number
              const numberUnification = this.unify(substitutedChildExprType, NumberType, this.currentSubstitution);
              if (!(numberUnification instanceof Error)) {
                isValidJsxChild = true;
              } else {
                // Try JSX element
                const jsxElementVar = this.newTypeVar("JSXElement");
                const jsxElementUnification = this.unify(substitutedChildExprType, jsxElementVar, this.currentSubstitution);
                if (!(jsxElementUnification instanceof Error)) {
                  isValidJsxChild = true;
                }
              }
            }
          }
          
          if (!isValidJsxChild) {
            this.reportError(
              `JSX child expressions must evaluate to a JSX element, a string, a number, or an array of JSX elements. Found type: '${substitutedChildExprType.toString()}'.`,
              child.expr()
            );
          }
        }
        else {
          // jsxText nodes are typically not type-checked in this manner unless specific rules apply.
        }
      });

    } else if (ctx.jsxSelfClosingElement()) {
      selfClosingElement = ctx.jsxSelfClosingElement()!;
      tagName = selfClosingElement.IDENTIFIER().getText();
      attributesCtx = selfClosingElement.jsxAttributes() ?? null;
    } else {
      this.reportError("Unknown JSX structure", ctx);
      return UnknownType;
    }

    console.log(`  > Tag name: ${tagName}`);

    // Look up the tag name in the environment using the prefix
    const jsxIntrinsicName = JSX_INTRINSIC_PREFIX + tagName;
    const elementType = this.environment.getType(jsxIntrinsicName) ?? this.environment.getType(tagName);

    if (!elementType) {
      this.reportError(`Unknown JSX element type: '<${tagName}>'.`, openingElement ?? selfClosingElement ?? ctx);
      return UnknownType; // Return UnknownType if tag is not defined
    }

    // Check if the found type is the expected JsxElementType
    if (!(elementType instanceof JsxElementType)) {
        this.reportError(`Expected JSX element type for '<${tagName}>', but found type '${elementType.toString()}'. Intrinsic elements should be declared as JsxElementType.`, openingElement ?? selfClosingElement ?? ctx);
        return UnknownType; // Return UnknownType if the base tag type is wrong
    }

    // Extract the expected props RecordType from the JsxElementType
    const expectedPropsType = elementType.propsType;

    // Validate the attributes against the expected RecordType
    this.visitAndCheckJsxAttributes(attributesCtx, expectedPropsType, tagName, ctx);

    // The type of the JSX expression is the specific JsxElementType found for the tag.
    this.hints.push({ context: ctx, type: elementType.toString() });
    this.setExpressionType(ctx, elementType); // Store the specific JsxElementType (e.g., JsxElement<DivProps>)
    console.log(`[visitJsxExpr] EXIT: Returning type ${elementType.toString()}`);
    return elementType; // Return the specific JsxElementType found
  }
  // --- END: visitJsxExpr ---


  // --- START: visitAndCheckJsxAttributes ---
  private visitAndCheckJsxAttributes(
    attributesCtx: parser.JsxAttributesContext | null,
    expectedPropsType: RecordType, // The RecordType defining expected props { key?: T, ... }
    tagName: string,
    jsxExprCtx: parser.JsxExprContext // For error reporting context
  ): void {
    const shortType = expectedPropsType.toString().length > 60
      ? expectedPropsType.toString().slice(0, 57) + "..."
      : expectedPropsType.toString();
    console.log(`[visitAndCheckJsxAttributes] Checking attributes for <${tagName}> against expected type: ${shortType}`);
    const providedAttributeNames = new Set<string>();

    if (!attributesCtx) {
      console.log(`  > No attributes provided.`);
      // No attributes provided, just check for missing required ones later.
    } else {
      // Iterate through provided attributes
      for (const attrCtx of attributesCtx.jsxAttribute()) {
        const attrName = attrCtx.IDENTIFIER()?.getText() || "type"
        providedAttributeNames.add(attrName);
        console.log(`  > Checking provided attribute: '${attrName}'`);

        const expectedFieldInfo = expectedPropsType.fields.get(attrName);

        // Check if attribute is expected
        if (!expectedFieldInfo) {
          this.reportError(
            `Unexpected attribute '${attrName}' for JSX element <${tagName}>. Expected props: ${expectedPropsType.toString()}`,
            attrCtx
          );
          continue; // Skip type checking for unexpected attributes
        }

        // Attribute is expected, now check its value type
        const expectedInnerType = expectedFieldInfo.type; // The 'T' in 'key: T' or 'key?: T'
        const isOptional = expectedFieldInfo.optional;
        let providedValueType: ChicoryType = UnknownType;

        const valueCtx = attrCtx.jsxAttributeValue();
        if (!valueCtx) {
          // Boolean shorthand attribute (e.g., <input disabled />)
          if (expectedInnerType === BooleanType && isOptional) {
             providedValueType = BooleanType; // Implicitly true
             console.log(`    > Boolean shorthand attribute '${attrName}' detected. Type: boolean (true)`);
          } else if (expectedInnerType instanceof LiteralUnionType && expectedInnerType.values.has(attrName) && isOptional) {
            // E.g. <button type="button" disabled /> where disabled is `disabled?: "disabled" | "true" | "false"`
            // This is a bit of a stretch, typically boolean shorthand implies boolean true.
            // For now, let's stick to boolean shorthand for boolean types.
            // If we want to support `disabled` as `disabled="disabled"`, it needs a value.
            this.reportError(`Attribute '${attrName}' is missing a value. Boolean shorthand is primarily for boolean attributes. Expected type: ${expectedInnerType}`, attrCtx);
            providedValueType = UnknownType;
          }
          else {
             this.reportError(`Attribute '${attrName}' is missing a value. Boolean shorthand is only allowed for optional boolean attributes (e.g., 'prop?: boolean'). Expected type: ${expectedInnerType}`, attrCtx);
             providedValueType = UnknownType;
          }
        } else {
          // Attribute has a value (e.g., class="hi", count={1}, type="button")
          if (valueCtx.expr()) {
            // Value is an expression { ... }
            // Pass expectedInnerType if it's a function (for event handlers)
            const exprExpectedType = (expectedInnerType instanceof FunctionType) ? expectedInnerType : undefined;
            providedValueType = this.visitExpr(valueCtx.expr()!, exprExpectedType);
          } else if (valueCtx.STRING()) {
            // Direct string literal in JSX attribute, e.g. type="button"
            // For type checking against LiteralUnionType, we need the actual value.
            // The general type is StringType, but we'll do a special check later.
            providedValueType = StringType; 
          } else if (valueCtx.NUMBER()) {
            providedValueType = NumberType;
          } else {
            this.reportError(`Unknown JSX attribute value type for '${attrName}'`, valueCtx);
            providedValueType = UnknownType;
          }
           console.log(`    > Provided value type for '${attrName}': ${providedValueType.toString()}`);
        }

        // Apply substitution to the provided value type
        const substitutedValueType = this.applySubstitution(providedValueType, this.currentSubstitution, new Set());

        // --- Custom Check for Record Attributes (like style) ---
        let attributeCheckError: Error | null = null;

        // --- Special Check for LiteralUnionType expected from JSX String Literal ---
        if (expectedInnerType instanceof LiteralUnionType && valueCtx && valueCtx.STRING()) {
            const jsxStringLiteralValueWithQuotes = valueCtx.STRING()!.getText();
            const jsxStringLiteralValue = jsxStringLiteralValueWithQuotes.substring(1, jsxStringLiteralValueWithQuotes.length - 1);
            console.log(`    > JSX attribute '${attrName}' is string literal "${jsxStringLiteralValue}", expected LiteralUnion ${expectedInnerType}.`);
            if (!expectedInnerType.values.has(jsxStringLiteralValue)) {
                attributeCheckError = new Error(`String literal "${jsxStringLiteralValue}" for attribute '${attrName}' is not a member of the expected literal union: ${expectedInnerType}.`);
            } else {
                console.log(`    > JSX string literal "${jsxStringLiteralValue}" matches expected LiteralUnion.`);
                // Match is good, no further unification needed for this specific case.
            }
        }
        // --- End Special Check ---
        else if (expectedInnerType instanceof RecordType && substitutedValueType instanceof RecordType) {
            console.log(`    > Performing custom record check for attribute '${attrName}'.`);
            const expectedFields = expectedInnerType.fields;
            const providedFields = substitutedValueType.fields;
            const providedKeys = new Set(providedFields.keys());

            // 1. Check provided fields against expected
            for (const [key, providedField] of providedFields) {
                const expectedField = expectedFields.get(key);
                if (!expectedField) {
                    attributeCheckError = new Error(`Provided object for attribute '${attrName}' has unexpected field '${key}'.`);
                    break;
                }
                // Check optional compatibility (allow provided non-optional for expected optional)
                if (!expectedField.optional && providedField.optional) {
                    attributeCheckError = new Error(`Internal Error? Cannot assign optional field '${key}' to required field '${key}' in expected props for '${attrName}'.`);
                    break;
                }

                // --- Get the original AST node for the provided value ---
                // This assumes the structure of the record literal AST
                let providedValueNode: parser.ExprContext | null = null;
                if (substitutedValueType instanceof RecordType && valueCtx?.expr()?.primaryExpr() instanceof parser.RecordExpressionContext) {
                    const recordExprCtx = valueCtx.expr()!.primaryExpr() as parser.RecordExpressionContext;
                    const kvPair = recordExprCtx.recordExpr().recordKvExpr().find(kv => kv.IDENTIFIER().getText() === key);
                    providedValueNode = kvPair?.expr() ?? null;
                }
                // --- End Get Value Node ---


                // --- Special Case for display: string -> DisplayType ---
                let fieldCheckResult: ChicoryType | Error | null = null; // Use null to indicate handled by special case

                if (key === 'display' && expectedField.type === DisplayTypeAdt) {
                    // Check if the provided value node is a string literal
                    if (providedValueNode?.primaryExpr() instanceof parser.LiteralExpressionContext &&
                        (providedValueNode.primaryExpr() as parser.LiteralExpressionContext).literal() instanceof parser.StringLiteralContext)
                    {
                        const literalCtx = (providedValueNode.primaryExpr() as parser.LiteralExpressionContext).literal();
                        const literalValueWithQuotes = literalCtx.getText();
                        const literalValue = literalValueWithQuotes.substring(1, literalValueWithQuotes.length - 1); // Remove quotes

                        // Check against known DisplayType constructors
                        const allowedDisplayValues = ["Block", "Inline", "Flex", "Grid", "None"]; // Match constructor names
                        if (allowedDisplayValues.some(ctor => ctor.toLowerCase() === literalValue.toLowerCase())) {
                            console.log(`[visitAndCheckJsxAttributes] Allowed string literal "${literalValue}" for 'display: DisplayTypeAdt' in attribute '${attrName}'.`);
                            fieldCheckResult = null; // Mark as handled, skip default unification
                        } else {
                            attributeCheckError = new Error(`Invalid string value "${literalValue}" for 'display' property in attribute '${attrName}'. Expected one of: ${allowedDisplayValues.map(v => `"${v.toLowerCase()}"`).join(', ')} (or the corresponding ADT constructor).`);
                            fieldCheckResult = attributeCheckError; // Store error to break loop
                        }
                    } else {
                        // Provided value for display is not a direct string literal, use default unification
                        console.log(`[visitAndCheckJsxAttributes] Value for 'display' in attribute '${attrName}' is not a string literal. Using default unification.`);
                        fieldCheckResult = this.unify(expectedField.type, providedField.type, this.currentSubstitution);
                    }
                } else {
                    // Default: Unify inner types for other fields
                    fieldCheckResult = this.unify(expectedField.type, providedField.type, this.currentSubstitution);
                }
                // --- End Special Case ---

                if (fieldCheckResult instanceof Error) {
                    // Use the specific error from unification or the special case check
                    attributeCheckError = new Error(`Type mismatch for field '${key}' in attribute '${attrName}'. Expected '${expectedField.type}' but got '${providedField.type}'. ${fieldCheckResult.message}`);
                    break;
                }
            }

            // 2. Check for missing required fields (if no error yet)
            if (!attributeCheckError) {
                for (const [key, expectedField] of expectedFields) {
                    if (!providedKeys.has(key) && !expectedField.optional) {
                        attributeCheckError = new Error(`Missing required field '${key}' in object provided for attribute '${attrName}'. Expected type: ${expectedInnerType}`);
                        break;
                    }
                }
            }
             console.log(`    > Custom record check result: ${attributeCheckError ? `Error (${attributeCheckError.message})` : 'Success'}`);
        } else {
            // --- Default Unification for Non-Record Attributes ---
            console.log(`    > Using default unification for attribute '${attrName}'.`);
            const unificationResult = this.unify(
                expectedInnerType,      // T (e.g., string for 'class')
                substitutedValueType, // Type of the value provided (e.g., string)
                this.currentSubstitution // Use main substitution map
            );
            if (unificationResult instanceof Error) {
                attributeCheckError = unificationResult; // Store the error
            }
        }
        // --- End Custom/Default Check ---

        if (attributeCheckError) {
          // Apply substitution to expectedInnerType for the error message
          const finalExpectedInner = this.applySubstitution(expectedInnerType, this.currentSubstitution, new Set());
          this.reportError(
            `Type mismatch for attribute '${attrName}'. Expected type '${finalExpectedInner}' but got '${substitutedValueType}'. ${attributeCheckError.message}`,
            valueCtx ?? attrCtx // Report on value if present, else on attribute name
          );
        } else {
           console.log(`    > Attribute '${attrName}' type check successful.`);
        }
      }
    }

    // Check for missing required attributes
    for (const [expectedAttrName, expectedFieldInfo] of expectedPropsType.fields) {
      if (!expectedFieldInfo.optional && !providedAttributeNames.has(expectedAttrName)) {
        this.reportError(
          `Missing required attribute '${expectedAttrName}' for JSX element <${tagName}>. Expected type: ${expectedFieldInfo.type.toString()}`,
          jsxExprCtx // Report error on the JSX element itself
        );
      }
    }
    console.log(`[visitAndCheckJsxAttributes] Finished checking attributes for <${tagName}>.`);
  }
  // --- END: visitAndCheckJsxAttributes ---


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
      const result = new GenericType(this.nextTypeVarId++, genericType.name, providedArgs);
      console.log(
        `[instantiateGenericType] EXIT (using provided args): ${result.toString()}`
      );
      return result;
    }

    console.log(`  > No provided arguments. Creating fresh type variables.`);
    // If no specific arguments provided, create fresh type variables.
    const substitution = new Map<number, ChicoryType>();
    const freshTypeArgs = genericType.typeArguments.map((param, i) => {
      console.log(`    > Instantiating param ${i}: ${param.toString()}`);
      if (param instanceof TypeVariable) {
        const freshVar = this.newTypeVar();
        console.log(
          `      > Param is TypeVariable ('${param.name}'). Creating fresh var: '${freshVar.name}'`
        );
        substitution.set(param.id, freshVar);
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
    const result = new GenericType(this.nextTypeVarId++, genericType.name, freshTypeArgs);
    console.log(
      `[instantiateGenericType] EXIT (with fresh vars): ${result.toString()}`
    );
    return result;
  }
}

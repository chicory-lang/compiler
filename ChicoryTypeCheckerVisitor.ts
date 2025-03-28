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

    // Add other prelude items here (e.g., Result, print function type)
  }

  private newTypeVar(): TypeVariable {
    return new TypeVariable(`T${this.nextTypeVarId++}`);
  }

  unify(
    type1: ChicoryType,
    type2: ChicoryType,
    substitution: SubstitutionMap
  ): ChicoryType | Error {
    type1 = this.applySubstitution(type1, substitution);
    type2 = this.applySubstitution(type2, substitution);

    if (typesAreEqual(type1, type2)) {
      return type1;
    }

    // Handle UnknownType: It can unify with any type, becoming that type.
    if (type1 === UnknownType) {
      // If type2 is also Unknown, returning either is fine.
      // If type2 is known, the result of unification is the known type.
      return type2;
    }
    if (type2 === UnknownType) {
      // type1 cannot be Unknown here due to the previous check.
      return type1; // Unification succeeds, result is the known type
    }

    if (type1 instanceof GenericType && type1.typeArguments.length === 0) {
      // A generic type with no arguments can be unified with any type
      // This is similar to a type variable
      if (this.occursIn(new TypeVariable(type1.name), type2)) {
        return new Error(
          `Cannot unify ${type1} with ${type2} (fails occurs check)`
        );
      }
      substitution.set(type1.name, type2);
      return type2;
    }

    // Also handle the reverse case
    if (type2 instanceof GenericType && type2.typeArguments.length === 0) {
      return this.unify(type2, type1, substitution);
    }

    if (type1 instanceof AdtType && type2 instanceof AdtType) {
      if (type1.name === type2.name) {
        return type1;
      }
      return new Error(
        `Cannot unify ADT types with different names: ${type1.name} and ${type2.name}`
      );
    }

    if (type1 instanceof TypeVariable) {
      if (substitution.has(type1.name)) {
        return this.unify(substitution.get(type1.name)!, type2, substitution);
      }
      if (type2 instanceof TypeVariable && type1.name === type2.name) {
        return type1;
      }
      if (this.occursIn(type1, type2)) {
        return new Error(
          `Cannot unify ${type1} with ${type2} (fails occurs check)`
        );
      }
      substitution.set(type1.name, type2);
      return type2;
    }

    if (type2 instanceof TypeVariable) {
      return this.unify(type2, type1, substitution);
    }

    if (type1 instanceof ArrayType && type2 instanceof ArrayType) {
      // Unify element types
      const elementResult = this.unify(
        type1.elementType,
        type2.elementType,
        substitution
      );
      if (elementResult instanceof Error) {
        return new Error(`Cannot unify array types: ${elementResult.message}`);
      }
      // Return an array type with the potentially updated element type
      // applySubstitution is crucial here as elementResult might just be a TypeVar that got bound
      return new ArrayType(this.applySubstitution(elementResult, substitution));
    }

    if (type1 instanceof FunctionType && type2 instanceof FunctionType) {
      if (type1.paramTypes.length !== type2.paramTypes.length) {
        return new Error(
          "Cannot unify function types with different number of parameters"
        );
      }
      for (let i = 0; i < type1.paramTypes.length; i++) {
        const result = this.unify(
          type1.paramTypes[i],
          type2.paramTypes[i],
          substitution
        );
        if (result instanceof Error) {
          return result;
        }
      }
      return this.unify(type1.returnType, type2.returnType, substitution);
    }

    if (type1 instanceof TupleType && type2 instanceof TupleType) {
      if (type1.elementTypes.length !== type2.elementTypes.length) {
        return new Error("Cannot unify tuples with different lengths");
      }

      for (let i = 0; i < type1.elementTypes.length; i++) {
        const result = this.unify(
          type1.elementTypes[i],
          type2.elementTypes[i],
          substitution
        );
        if (result instanceof Error) {
          return result;
        }
      }

      return type1;
    }

    // Add other type-specific unification rules (RecordType etc.) as needed
    return new Error(`Cannot unify ${type1} with ${type2}`);
  }

  applySubstitution(
    type: ChicoryType,
    substitution: SubstitutionMap
  ): ChicoryType {
    if (type instanceof TypeVariable) {
      if (substitution.has(type.name)) {
        return this.applySubstitution(
          substitution.get(type.name)!,
          substitution
        );
      }
      return type;
    }

    // Add ArrayType substitution
    if (type instanceof ArrayType) {
      return new ArrayType(
        this.applySubstitution(type.elementType, substitution)
      );
    }

    // Add case for GenericType
    if (type instanceof GenericType) {
      if (type.typeArguments.length === 0 && substitution.has(type.name)) {
        return this.applySubstitution(
          substitution.get(type.name)!,
          substitution
        );
      }
      return new GenericType(
        type.name,
        type.typeArguments.map((t) => this.applySubstitution(t, substitution))
      );
    }

    if (type instanceof FunctionType) {
      const newParamTypes = type.paramTypes.map((p) =>
        this.applySubstitution(p, substitution)
      );
      const newReturnType = this.applySubstitution(
        type.returnType,
        substitution
      );
      return new FunctionType(
        newParamTypes,
        newReturnType,
        type.constructorName
      );
    }

    if (type instanceof TupleType) {
      return new TupleType(
        type.elementTypes.map((e) => this.applySubstitution(e, substitution))
      );
    }

    return type;
  }

  occursIn(typeVar: TypeVariable, type: ChicoryType): boolean {
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
    // Find all unique type variables within the function type signature
    const typeVars = new Set<string>();
    const findVars = (type: ChicoryType) => {
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
      substitution.set(varName, this.newTypeVar());
    });

    // If no variables were found, return the original type
    if (substitution.size === 0) {
      return funcType;
    }

    // Apply the substitution to create the new, instantiated function type
    // We need to ensure applySubstitution correctly handles FunctionType (which it should)
    return this.applySubstitution(funcType, substitution) as FunctionType;
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
    filePath: string | null, // Absolute path of the file to check
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
    this.currentFilePath = filePath || "__entrypoint__";
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
    typeName?: string
  ): ChicoryType {
    // Visit the base type first
    let baseType = this.visitPrimaryTypeExpr(ctx.primaryTypeExpr(), typeName);

    // Count the number of '[]' suffixes
    // ANTLR generates methods based on the grammar structure.
    // If '[]' is a single token or specific rule element, access it directly.
    // Assuming '[]' might be parsed as separate '[' and ']' tokens:
    const arraySuffixCount =
      ctx.children?.filter((c) => c.getText() === "[]").length ?? 0;
    // If parsed as '[' and ']', count '[' or ']' instead:
    // const arraySuffixCount = ctx.getTokens(parser.ChicoryLexer.LBRACK)?.length ?? 0; // Adjust token name

    // Wrap the base type in ArrayType for each suffix
    for (let i = 0; i < arraySuffixCount; i++) {
      baseType = new ArrayType(baseType);
    }

    return baseType;
  }

  // Add the new visitPrimaryTypeExpr method
  private visitPrimaryTypeExpr(
    ctx: parser.PrimaryTypeExprContext,
    typeName?: string
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
      return this.visitGenericTypeExpr(ctx.genericTypeExpr()!);
    } else if (ctx.recordType()) {
      return this.visitRecordType(ctx.recordType()!);
    } else if (ctx.tupleType()) {
      return this.visitTupleType(ctx.tupleType()!);
    } else if (ctx.primitiveType()) {
      return this.getPrimitiveType(ctx.primitiveType()!);
    } else if (ctx.IDENTIFIER()) {
      const name = ctx.IDENTIFIER()!.getText();
      const type = this.environment.getType(name);
      if (!type) {
        // Check if it's a known type variable in the current scope (e.g., from type definition params)
        if (this.environment.getType(name) instanceof TypeVariable) {
          return new TypeVariable(name);
        }
        // Otherwise, it's likely an undefined type name.
        this.reportError(`Type identifier '${name}' not found.`, ctx);
        // Return Unknown or a placeholder Generic type? Placeholder is often better for inference.
        return new GenericType(name, []);
        // return UnknownType;
      }
      return type;
    } else if (ctx.typeExpr()) {
      // For '(' typeExpr ')'
      return this.visitTypeExpr(ctx.typeExpr()!); // Recursively call visitTypeExpr
    }

    this.reportError(
      `Unsupported primary type expression: ${ctx.getText()}`,
      ctx
    );
    return UnknownType;
  }

  private visitGenericTypeExpr(
    ctx: parser.GenericTypeExprContext
  ): ChicoryType {
    const typeName = ctx.IDENTIFIER().getText();
    const typeArguments = ctx.typeExpr().map((e) => this.visitTypeExpr(e));
    return new GenericType(typeName, typeArguments); // Assuming GenericType is similar to AdtType for now
  }

  private visitFunctionType(ctx: parser.FunctionTypeContext): ChicoryType {
    const paramTypes = ctx.typeParam()
      ? ctx.typeParam().map((p) => this.visitParameterType(p))
      : [];
    const returnType = this.visitTypeExpr(ctx.typeExpr());

    return new FunctionType(paramTypes, returnType);
  }

  private visitParameterType(ctx: parser.TypeParamContext): ChicoryType {
    if (ctx instanceof parser.NamedTypeParamContext) {
      const existingType = this.environment.getType(ctx.IDENTIFIER().getText());
      if (existingType) {
        return existingType;
      }
      const typeVar = this.newTypeVar();
      this.environment.declare(typeVar.name, typeVar, ctx, (str) =>
        this.reportError(str, ctx)
      );
      return typeVar;
    } else if (ctx instanceof parser.UnnamedTypeParamContext) {
      return this.visitTypeExpr(ctx.typeExpr());
    }

    throw new Error(`Unknown parameter type: ${ctx.getText()}`);
  }

  private visitRecordType(ctx: parser.RecordTypeContext): ChicoryType {
    const recordType = new RecordType(new Map());
    ctx.recordTypeAnontation().forEach((kv) => {
      const id = kv.IDENTIFIER()[0].getText();

      let val: ChicoryType;
      if (kv.primitiveType()) {
        val = this.getPrimitiveType(kv.primitiveType()!);
      } else if (kv.recordType()) {
        val = this.visitRecordType(kv.recordType()!);
      } else if (kv.tupleType()) {
        val = this.visitTupleType(kv.tupleType()!);
      } else if (kv.functionType()) {
        val = this.visitFunctionType(kv.functionType()!);
      } else if (kv.IDENTIFIER()) {
        const rhs = kv.IDENTIFIER()[1].getText();

        val = this.environment.getType(rhs) || new GenericType(rhs, []);
      } else {
        throw new Error(`Unknown record type annotation: ${kv.getText()}`);
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

  private visitTupleType(ctx: parser.TupleTypeContext): ChicoryType {
    return new TupleType(ctx.typeExpr().map((e) => this.visitTypeExpr(e)));
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
    this.expressionTypes.set(ctx, resultType); // Assuming expressionTypes map exists

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
    } else if (ctx instanceof parser.JsxExpressionContext) {
      return this.visitJsxExpr(ctx.jsxExpr());
    }

    this.reportError(`Unknown primary expression type: ${ctx.getText()}`, ctx);
    return UnknownType;
  }

  visitIdentifier(ctx: parser.IdentifierExpressionContext): ChicoryType {
    const identifierName = ctx.IDENTIFIER().getText();

    // 1. Check environment first (variables, non-generic functions, etc.)
    const envType = this.environment.getType(identifierName);
    if (envType) {
      // Apply substitutions to the type found in the environment
      let substitutedType = this.applySubstitution(
        envType,
        this.currentSubstitution
      );

      // If it's a function type from the env that might be generic, instantiate it.
      // This part might need refinement depending on how generic functions are defined/stored.
      // For now, let's assume functions directly from env might need instantiation if they contain unbound vars.
      if (substitutedType instanceof FunctionType) {
        // Check if it contains type variables that might need instantiation
        // A simple check: does it contain any TypeVariable instances?
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

        if (containsTypeVars) {
          // Potentially generic function found in env, instantiate it
          substitutedType = this.instantiateFunctionType(substitutedType);
          console.log(
            `[visitIdentifier] Instantiated function from env ${identifierName}: ${substitutedType}`
          );
        }
      }
      // Note: We are NOT instantiating GenericType references found directly in the environment here.
      // Example: If `let x: Option<T> = ...`, looking up `x` should return the instantiated type.
      // If looking up the type name `Option` itself, it should return the generic definition.
      // The current logic applies substitution, which might be sufficient if `T` gets bound.

      this.hints.push({ context: ctx, type: substitutedType.toString() });
      return substitutedType; // Return type from env (potentially substituted and/or instantiated)
    }

    // 2. Check if it's an ADT constructor
    const constructor = this.getConstructors().find(
      (c) => c.name === identifierName
    );
    if (constructor) {
      const originalConstructorType = constructor.type; // e.g., (T) => Option<T>

      // Check if the ADT itself is generic by looking up its definition
      const adtDefinition = this.environment.getType(constructor.adtName); // e.g., Option<T>

      let typeToReturn: ChicoryType;

      // Check if the ADT definition is generic AND the constructor type actually uses type variables
      if (
        adtDefinition instanceof GenericType &&
        adtDefinition.typeArguments.length > 0 &&
        originalConstructorType instanceof FunctionType
      ) {
        // It's a constructor of a generic ADT. Instantiate its type with fresh variables.
        typeToReturn = this.instantiateFunctionType(originalConstructorType); // Use helper
        console.log(
          `[visitIdentifier] Instantiated generic constructor ${identifierName}: ${originalConstructorType} -> ${typeToReturn}`
        );
      } else {
        // It's a constructor of a non-generic ADT, or a generic ADT with no params used in this constructor.
        // Use its type directly. Do NOT apply currentSubstitution here.
        typeToReturn = originalConstructorType;
      }

      // Handle the case where the constructor takes no arguments (e.g., None)
      // The type checker should return the function type `() => Option<T1>`
      // The compiler (`ChicoryVisitor.ts`) handles generating the direct object `{ type: "None" }` when it sees the identifier `None`.
      // So, no special handling needed here for the type checker return value.

      this.hints.push({ context: ctx, type: typeToReturn.toString() });
      return typeToReturn;
    }

    // 3. Not found
    this.reportError(`Identifier '${identifierName}' is not defined.`, ctx);
    return UnknownType;
  }

  visitLiteral(ctx: parser.LiteralContext): ChicoryType {
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
    // Apply *outer* substitutions to the function type *before* doing anything else.
    // This resolves any type variables bound *outside* the function call itself.
    const substitutedFunctionType = this.applySubstitution(
      functionType,
      this.currentSubstitution // Use the substitution context from *before* this call
    );

    // Check if it's actually a function type after substitution
    if (!(substitutedFunctionType instanceof FunctionType)) {
      this.reportError(
        `Cannot call a non-function type: '${substitutedFunctionType}'`,
        ctx
      );
      // Store UnknownType for this expression node before returning
      this.expressionTypes.set(ctx, UnknownType);
      this.hints.push({ context: ctx, type: UnknownType.toString() });
      return UnknownType;
    }

    // It IS a FunctionType, proceed.
    const funcType = substitutedFunctionType as FunctionType;

    // Type check arguments in the current context.
    // visitExpr uses/updates this.currentSubstitution internally for argument inference.
    const argumentTypes = ctx.expr()
      ? ctx.expr().map((expr) => this.visitExpr(expr))
      : [];

    // Apply current substitutions to argument types as well, as visitExpr might have updated them.
    const substitutedArgumentTypes = argumentTypes.map((argType) =>
      this.applySubstitution(argType, this.currentSubstitution)
    );

    // Create a FRESH substitution map specific to *this function call*.
    // This map will capture how type variables *within* the function signature
    // are unified with the provided arguments.
    const callSubstitution: SubstitutionMap = new Map();

    // Check arity (number of arguments)
    if (substitutedArgumentTypes.length !== funcType.paramTypes.length) {
      this.reportError(
        `Expected ${funcType.paramTypes.length} arguments, but got ${substitutedArgumentTypes.length}`,
        ctx
      );
      // Store UnknownType and return early on arity mismatch
      this.expressionTypes.set(ctx, UnknownType);
      this.hints.push({ context: ctx, type: UnknownType.toString() });
      return UnknownType;
    }

    // Unify arguments with parameters using the call-specific substitution map (`callSubstitution`).
    let unificationOk = true;
    for (let i = 0; i < substitutedArgumentTypes.length; i++) {
      // Unify the function's parameter type with the (substituted) argument type.
      // The substitution map `callSubstitution` is updated by `unify`.
      const result = this.unify(
        funcType.paramTypes[i], // Parameter type from the (potentially substituted) function signature
        substitutedArgumentTypes[i], // Argument type resolved in the current context
        callSubstitution // Update this map with bindings for type vars in funcType.paramTypes
      );
      if (result instanceof Error) {
        unificationOk = false;
        this.reportError(
          `Argument ${i + 1} type mismatch: Cannot unify parameter type '${
            funcType.paramTypes[i]
          }' with argument type '${substitutedArgumentTypes[i]}'. ${
            result.message
          }`,
          ctx.expr(i)! // Report error on the specific argument
        );
        // Continue checking other args even if one fails, to report all mismatches
      }
    }

    // If any argument unification failed, the result type is Unknown
    if (!unificationOk) {
      this.expressionTypes.set(ctx, UnknownType);
      this.hints.push({ context: ctx, type: UnknownType.toString() });
      return UnknownType;
    }

    // Calculate the final return type by applying the call-specific substitution (`callSubstitution`)
    // to the function's declared return type.
    let finalReturnType = this.applySubstitution(
      funcType.returnType,
      callSubstitution
    );

    // --- Special Handling for Generic Constructors ---
    // If this was a call to a generic ADT constructor (like Some<T>),
    // ensure the resulting type is correctly represented as GenericType<ConcreteArg(s)>.
    if (funcType.constructorName && finalReturnType instanceof AdtType) {
      const constructorDef = this.constructors.find(
        (c) => c.name === funcType.constructorName
      );
      const adtDef = constructorDef
        ? this.environment.getType(constructorDef.adtName)
        : null;

      // Check if the ADT definition is indeed generic
      if (adtDef instanceof GenericType && adtDef.typeArguments.length > 0) {
        // Resolve the ADT's type parameters (e.g., 'T' in Option<T>)
        // using the `callSubstitution` derived from the arguments.
        const concreteArgs = adtDef.typeArguments.map((typeVar) => {
          if (typeVar instanceof TypeVariable) {
            // Apply substitution recursively in case a type var maps to another type var etc.
            return this.applySubstitution(typeVar, callSubstitution);
          }
          // Should not happen for ADT def params, but return as is if not a TypeVariable
          return typeVar;
        });

        // Check if all type variables were successfully resolved to concrete types
        if (concreteArgs.some((arg) => arg instanceof TypeVariable)) {
          // This indicates incomplete inference or an error.
          console.warn(
            `[visitCallExpr] Could not fully resolve type arguments for generic constructor ${funcType.constructorName}. Result: ${finalReturnType}, Inferred Args: ${concreteArgs}`
          );
          // Report an error? Or return partially resolved type? Let's return the GenericType with unresolved vars for now.
          finalReturnType = new GenericType(adtDef.name, concreteArgs);
          // Optionally report an error:
          // this.reportError(`Could not infer all type arguments for generic constructor ${funcType.constructorName}`, ctx);
          // finalReturnType = UnknownType;
        } else {
          // Successfully resolved all type arguments. Create the concrete GenericType instance.
          finalReturnType = new GenericType(adtDef.name, concreteArgs);
          console.log(
            `[visitCallExpr] Resolved generic constructor call ${funcType.constructorName} to ${finalReturnType}`
          );
        }
      }
      // If adtDef wasn't GenericType or had no type arguments, finalReturnType remains as calculated before (likely AdtType).
    }
    // --- End Special Handling ---

    // Store and add hint for the final, calculated return type
    this.expressionTypes.set(ctx, finalReturnType);
    this.hints.push({ context: ctx, type: finalReturnType.toString() });

    return finalReturnType;
  }

  visitMatchExpr(ctx: parser.MatchExprContext): ChicoryType {
    // Type check the expression being matched
    const matchedType = this.visitExpr(ctx.expr());
    const appliedMatchedType = this.applySubstitution(
      matchedType,
      this.currentSubstitution
    ); // Apply substitutions early

    // --- Setup for Exhaustiveness Check ---
    let adtVariants: readonly string[] | null = null;
    let isAdtMatch = false; // Flag to know if we need the check
    let adtTypeNameForCheck: string | null = null; // Store the base name (e.g., "Option")

    // Check for built-in generic ADTs (Option, Result) or user-defined ADTs
    if (
      appliedMatchedType instanceof GenericType ||
      appliedMatchedType instanceof AdtType
    ) {
      adtTypeNameForCheck = appliedMatchedType.name;

      // Handle known built-ins specifically
      if (adtTypeNameForCheck === "Option") {
        adtVariants = ["Some", "None"];
        isAdtMatch = true;
        this.prelude.requireOptionType();
      } else if (adtTypeNameForCheck === "Result") {
        // Assuming Result variants are 'Ok', 'Err'
        adtVariants = ["Ok", "Err"];
        isAdtMatch = true;
        // this.prelude.requireResultType(); // Assuming this exists
      } else {
        // Check if it's a user-defined ADT by looking up its constructors
        const constructorsForType = this.constructors.filter(
          (c) => c.adtName === adtTypeNameForCheck
        );
        if (constructorsForType.length > 0) {
          adtVariants = constructorsForType.map((c) => c.name);
          isAdtMatch = true;
        } else {
          // It has a name like an ADT, but no constructors found. Might be an error elsewhere,
          // or just not an ADT we can check exhaustiveness for.
          console.warn(
            `[visitMatchExpr] Type '${adtTypeNameForCheck}' looks like an ADT but no constructors were found.`
          );
        }
      }
    }
    // Add checks here if you want to enforce exhaustiveness for other types like booleans
    // else if (appliedMatchedType === BooleanType) { ... }

    const fullyCoveredVariants = new Set<string>(); // Stores constructor names that are fully covered
    let hasWildcard = false;
    // --- End of Setup ---

    let returnTypes: ChicoryType[] = [];

    // Process each match arm
    ctx.matchArm().forEach((arm) => {
      // Create a new scope for variables declared in the pattern
      this.environment = this.environment.pushScope();

      // --- Analyze Pattern for Exhaustiveness ---
      const armPatternCtx = arm.matchPattern();

      if (isAdtMatch && !hasWildcard) {
        // Only track full coverage if relevant and no wildcard seen
        if (armPatternCtx instanceof parser.WildcardMatchPatternContext) {
          hasWildcard = true; // Wildcard covers everything
        }
        // Add VariableMatchPatternContext check if you implement it
        // else if (armPatternCtx instanceof parser.VariableMatchPatternContext) {
        //    hasWildcard = true;
        // }
        else if (
          armPatternCtx instanceof parser.AdtWithParamMatchPatternContext
        ) {
          // Pattern like Some(val) - FULLY covers the 'Some' variant
          const constructorName = armPatternCtx.IDENTIFIER()[0].getText();
          if (constructorName) {
            // Optional: Check for redundancy if already covered
            // if (fullyCoveredVariants.has(constructorName)) { ... }
            fullyCoveredVariants.add(constructorName);
          }
        } else if (
          armPatternCtx instanceof parser.AdtWithWildcardMatchPatternContext
        ) {
          // Pattern like Some(_) - FULLY covers the 'Some' variant
          const constructorName = armPatternCtx.IDENTIFIER().getText();
          if (constructorName) {
            fullyCoveredVariants.add(constructorName);
          }
        } else if (armPatternCtx instanceof parser.BareAdtMatchPatternContext) {
          // Pattern like None - FULLY covers the 'None' variant (as it takes no args)
          const constructorName = armPatternCtx.IDENTIFIER().getText();
          if (constructorName) {
            fullyCoveredVariants.add(constructorName);
          }
        } else if (
          armPatternCtx instanceof parser.AdtWithLiteralMatchPatternContext
        ) {
          // Pattern like Some("42") - Does NOT fully cover 'Some'.
          // Do nothing regarding fullyCoveredVariants.
          const constructorName = armPatternCtx.IDENTIFIER().getText();
          // Optional: Check if constructorName is valid for the ADT type (error reporting)
          if (
            isAdtMatch &&
            adtVariants &&
            constructorName &&
            !adtVariants.includes(constructorName)
          ) {
            this.reportError(
              `Constructor '${constructorName}' does not belong to type '${adtTypeNameForCheck}'`,
              armPatternCtx
            );
          }
        } else if (armPatternCtx instanceof parser.LiteralMatchPatternContext) {
          // Pattern like "test" - Does not cover ADT variants.
          // Do nothing regarding fullyCoveredVariants.
        }
      } // End if (isAdtMatch && !hasWildcard)

      // If wildcard found, stop tracking coverage
      if (hasWildcard) {
        // Optional: break; if no other per-arm processing needed after finding wildcard
      }
      // --- End Pattern Analysis ---

      // Type check the pattern itself (binds variables, checks types)
      // Pass the *applied* matched type to visitPattern
      // The addCase callback is now only used internally by visitPattern for debugging/logging if needed
      this.visitPattern(armPatternCtx, appliedMatchedType, (caseStr) => {
        /* No-op or logging */
      });

      // Type check the expression of the arm
      const armReturnType = this.visitExpr(arm.expr());
      returnTypes.push(
        this.applySubstitution(armReturnType, this.currentSubstitution)
      ); // Apply substitution to arm result

      // Pop the scope for the pattern variables
      this.environment = this.environment.popScope();
    }); // End loop through arms

    // --- Final Exhaustiveness Check ---
    if (isAdtMatch && adtVariants && !hasWildcard) {
      // Check which variants were NOT fully covered
      const missingVariants = adtVariants.filter(
        (v) => !fullyCoveredVariants.has(v)
      ); // Use fullyCoveredVariants

      if (missingVariants.length > 0) {
        this.reportError(
          `Match expression on type '${adtTypeNameForCheck}' is not exhaustive. Missing cases: ${missingVariants.join(
            ", "
          )}`,
          ctx // Report error on the whole match expression context
        );
        // If non-exhaustiveness is a type error, return Unknown
        // return UnknownType;
      }
    }
    // Add similar checks here for boolean, etc., if required
    // else if (appliedMatchedType === BooleanType && !hasWildcard) {
    //     const needsTrue = !coveredCases.has('true');
    //     const needsFalse = !coveredCases.has('false');
    //     if (needsTrue || needsFalse) { ... report error ... }
    // }
    // --- End Final Check ---

    // Check that all arms return the same type (Unification)
    let finalArmType: ChicoryType = UnknownType;
    if (returnTypes.length > 0) {
      finalArmType = returnTypes[0]; // Start with the first arm's type
      for (let i = 1; i < returnTypes.length; i++) {
        const unificationResult = this.unify(
          finalArmType,
          returnTypes[i],
          this.currentSubstitution
        );
        if (unificationResult instanceof Error) {
          this.reportError(
            `Match arms must return compatible types. Expected '${finalArmType}', found '${returnTypes[i]}'. ${unificationResult.message}`,
            ctx.matchArm(i)!.expr() // Report error on the expression of the mismatched arm
          );
          finalArmType = UnknownType; // Set to Unknown on mismatch
          break; // Stop checking further arms after first mismatch
        } else {
          // Unification might refine the type (e.g., bind type variables)
          finalArmType = this.applySubstitution(
            unificationResult,
            this.currentSubstitution
          );
        }
      }
    } else {
      // Match expression with no arms? Should be a parser error, but handle defensively.
      this.reportError("Match expression has no arms.", ctx);
      finalArmType = UnknownType;
    }

    // Apply final substitutions to the unified type
    finalArmType = this.applySubstitution(
      finalArmType,
      this.currentSubstitution
    );
    this.hints.push({ context: ctx, type: finalArmType.toString() }); // Add hint for the whole match expression
    return finalArmType;
  }

  visitMatchArm(
    ctx: parser.MatchArmContext,
    matchedType: ChicoryType,
    addCase: (str: string) => void
  ): ChicoryType {
    this.environment = this.environment.pushScope();
    this.visitPattern(ctx.matchPattern(), matchedType, addCase); // Check pattern and declare any variables
    const armExprType = this.visitExpr(ctx.expr());
    this.environment = this.environment.popScope();
    return armExprType;
  }

  visitPattern(
    ctx: parser.MatchPatternContext,
    matchedType: ChicoryType,
    addCase: (str: string) => void // Accepts string - Now primarily for logging/debugging within this method
  ): void {
    // Apply substitution to matchedType *before* checking its instance type
    const substitution: SubstitutionMap = new Map(); // Local substitution for pattern checks if needed
    matchedType = this.applySubstitution(matchedType, this.currentSubstitution); // Use main substitution

    console.log(
      `[visitPattern] Checking pattern '${ctx.getText()}' against matched type '${matchedType}'`
    ); // Debug

    if (ctx.ruleContext instanceof parser.BareAdtMatchPatternContext) {
      const adtName = (ctx as parser.BareAdtMatchPatternContext)
        .IDENTIFIER()
        .getText();
      addCase(adtName); // Simple name for bare constructor
      console.log(`[visitPattern] Adding case (bare ADT): ${adtName}`);

      let baseTypeName: string | null = null;
      if (
        matchedType instanceof AdtType ||
        matchedType instanceof GenericType
      ) {
        baseTypeName = matchedType.name;
      } else if (matchedType instanceof TypeVariable) {
        console.log(
          `[visitPattern] Matching bare ADT '${adtName}' against TypeVariable '${matchedType.name}'. Cannot verify constructor statically.`
        );
        // Assume valid for now, runtime check would be needed. Exhaustiveness might be uncertain.
        return; // Allow pattern but cannot fully check
      } else {
        this.reportError(
          `Cannot match type '${matchedType}' against ADT pattern '${adtName}'`,
          ctx
        );
        return;
      }

      // Check if the constructor exists for this ADT/Generic base type
      const constructor = this.constructors.find(
        (c) => c.name === adtName && c.adtName === baseTypeName
      );
      if (!constructor) {
        this.reportError(
          `Constructor '${adtName}' does not exist on type '${baseTypeName}'`,
          ctx
        );
      } else {
        // Check arity for bare match: constructor should take 0 arguments
        if (
          constructor.type instanceof FunctionType &&
          constructor.type.paramTypes.length > 0
        ) {
          this.reportError(
            `Constructor '${adtName}' expects arguments, but none were provided in the pattern.`,
            ctx
          );
        }
      }
    } else if (
      ctx.ruleContext instanceof parser.AdtWithParamMatchPatternContext
    ) {
      const [adtName, paramName] = (
        ctx as parser.AdtWithParamMatchPatternContext
      )
        .IDENTIFIER()
        .map((id) => id.getText());
      addCase(`${adtName}(*)`); // Standardize parameterized case for exhaustiveness
      console.log(
        `[visitPattern] Adding case (ADT with param): ${adtName}(${paramName})`
      );

      let baseTypeName: string | null = null;
      if (
        matchedType instanceof AdtType ||
        matchedType instanceof GenericType
      ) {
        baseTypeName = matchedType.name;
      } else if (matchedType instanceof TypeVariable) {
        console.log(
          `[visitPattern] Matching ADT pattern '${adtName}(${paramName})' against TypeVariable '${matchedType.name}'. Cannot verify constructor statically.`
        );
        // Declare param as Unknown or a fresh TypeVar? Let's use Unknown for now.
        this.environment.declare(paramName, UnknownType, ctx, (str) =>
          this.reportError(str, ctx)
        );
        this.hints.push({ context: ctx, type: UnknownType.toString() });
        return; // Allow pattern but cannot fully check
      } else {
        this.reportError(
          `Cannot match type '${matchedType}' against ADT pattern '${adtName}(${paramName})'`,
          ctx
        );
        return;
      }

      // Find constructor
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

      // Check arity: constructor should take exactly one argument for this pattern
      if (
        !(constructorType instanceof FunctionType) ||
        constructorType.paramTypes.length !== 1
      ) {
        this.reportError(
          `Constructor '${adtName}' does not take exactly one parameter as expected by pattern '${adtName}(${paramName})'.`,
          ctx
        );
        // Declare param as Unknown to avoid cascading errors
        this.environment.declare(paramName, UnknownType, ctx, (str) =>
          this.reportError(str, ctx)
        );
        this.hints.push({ context: ctx, type: UnknownType.toString() });
        return;
      }

      // --- Infer parameter type ---
      let paramType: ChicoryType = UnknownType;
      const originalParamType = constructorType.paramTypes[0];

      // If the matched type is a specific generic instance (like Option<string>)
      // and the constructor parameter involves type variables from the generic definition (like T in Some(T)),
      // we need to substitute T with the specific type argument (string).
      if (
        matchedType instanceof GenericType &&
        matchedType.typeArguments.length > 0 &&
        constructorType.returnType instanceof GenericType &&
        constructorType.returnType.typeArguments.length > 0
      ) {
        // Create substitution map from the generic ADT's parameters to the matched type's arguments
        const instantiationSubst = new Map<string, ChicoryType>();
        const adtDefinition = this.environment.getType(baseTypeName); // Get the generic definition (e.g., Option<T>)

        if (
          adtDefinition instanceof GenericType &&
          adtDefinition.typeArguments.length ===
            matchedType.typeArguments.length
        ) {
          for (let i = 0; i < adtDefinition.typeArguments.length; i++) {
            const genericVar = adtDefinition.typeArguments[i];
            if (genericVar instanceof TypeVariable) {
              instantiationSubst.set(
                genericVar.name,
                matchedType.typeArguments[i]
              );
            }
          }
          paramType = this.applySubstitution(
            originalParamType,
            instantiationSubst
          );
          console.log(
            `[visitPattern] Instantiated param type for ${adtName}(${paramName}) from ${originalParamType} to ${paramType} using matched type ${matchedType}`
          );
        } else {
          console.warn(
            `[visitPattern] Mismatch between generic definition and matched type arguments for ${baseTypeName}. Using original param type.`
          );
          paramType = originalParamType; // Fallback
        }
      } else {
        // Not a generic match, or no arguments; use the constructor's defined parameter type directly
        paramType = originalParamType;
        console.log(
          `[visitPattern] Using constructor param type for ${adtName}(${paramName}): ${paramType}`
        );
      }

      // Declare the parameter variable in the arm's scope
      this.environment.declare(paramName, paramType, ctx, (str) =>
        this.reportError(str, ctx)
      );
      // Add hint for the bound variable's type
      this.hints.push({ context: ctx, type: paramType.toString() });
    } else if (
      ctx.ruleContext instanceof parser.AdtWithWildcardMatchPatternContext
    ) {
      const adtName = (ctx as parser.AdtWithWildcardMatchPatternContext)
        .IDENTIFIER()
        .getText();
      addCase(`${adtName}(*)`); // Indicate wildcard parameter
      console.log(
        `[visitPattern] Adding case (ADT with wildcard): ${adtName}(_)`
      );

      let baseTypeName: string | null = null;
      if (
        matchedType instanceof AdtType ||
        matchedType instanceof GenericType
      ) {
        baseTypeName = matchedType.name;
      } else if (matchedType instanceof TypeVariable) {
        console.log(
          `[visitPattern] Matching ADT wildcard pattern '${adtName}(_)' against TypeVariable '${matchedType.name}'. Cannot verify constructor statically.`
        );
        return; // Allow pattern but cannot fully check
      } else {
        this.reportError(
          `Cannot match type '${matchedType}' against ADT pattern '${adtName}(_)'`,
          ctx
        );
        return;
      }

      // Find constructor
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

      // Check arity: constructor should take exactly one argument for this pattern
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
      // No variable to declare for wildcard
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
      const literalValueStr = literalCtx.getText(); // For addCase
      addCase(`${adtName}(*)`); // Standardize parameterized case for exhaustiveness
      console.log(
        `[visitPattern] Adding case (ADT with literal): ${adtName}(${literalValueStr})`
      );

      let baseTypeName: string | null = null;
      if (
        matchedType instanceof AdtType ||
        matchedType instanceof GenericType
      ) {
        baseTypeName = matchedType.name;
      } else if (matchedType instanceof TypeVariable) {
        console.log(
          `[visitPattern] Matching ADT literal pattern '${adtName}(${literalValueStr})' against TypeVariable '${matchedType.name}'. Cannot verify constructor or literal type statically.`
        );
        return; // Allow pattern but cannot fully check
      } else {
        this.reportError(
          `Cannot match type '${matchedType}' against ADT pattern '${adtName}(${literalValueStr})'`,
          ctx
        );
        return;
      }

      // Find constructor
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

      // Check arity: constructor should take exactly one argument for this pattern
      if (
        !(constructorType instanceof FunctionType) ||
        constructorType.paramTypes.length !== 1
      ) {
        this.reportError(
          `Constructor '${adtName}' does not take exactly one parameter as expected by literal pattern '${adtName}(${literalValueStr})'.`,
          ctx
        );
        return;
      }

      // --- Check literal type against expected parameter type ---
      let expectedParamType: ChicoryType = UnknownType;
      const originalParamType = constructorType.paramTypes[0];

      // Instantiate expected type if necessary (similar to AdtWithParamMatchPatternContext)
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
          for (let i = 0; i < adtDefinition.typeArguments.length; i++) {
            const genericVar = adtDefinition.typeArguments[i];
            if (genericVar instanceof TypeVariable) {
              instantiationSubst.set(
                genericVar.name,
                matchedType.typeArguments[i]
              );
            }
          }
          expectedParamType = this.applySubstitution(
            originalParamType,
            instantiationSubst
          );
          console.log(
            `[visitPattern] Instantiated expected param type for ${adtName}(${literalValueStr}) from ${originalParamType} to ${expectedParamType} using matched type ${matchedType}`
          );
        } else {
          console.warn(
            `[visitPattern] Mismatch between generic definition and matched type arguments for ${baseTypeName}. Using original param type for literal check.`
          );
          expectedParamType = originalParamType; // Fallback
        }
      } else {
        expectedParamType = originalParamType;
        console.log(
          `[visitPattern] Using constructor param type for ${adtName}(${literalValueStr}): ${expectedParamType}`
        );
      }

      // *** USE UNIFICATION to check if literal type matches expected parameter type ***
      const unificationResult = this.unify(
        expectedParamType,
        literalType,
        new Map() // Use a temporary substitution map for just this check
      );
      if (unificationResult instanceof Error) {
        this.reportError(
          `Literal ${literalValueStr} of type '${literalType}' is not compatible with expected parameter type '${expectedParamType}' for constructor '${adtName}'. ${unificationResult.message}`,
          literalCtx // Report error on the literal itself
        );
      }
    } else if (ctx.ruleContext instanceof parser.WildcardMatchPatternContext) {
      addCase("*"); // Wildcard case
      console.log(`[visitPattern] Adding case (wildcard): _`);
      // Always matches, no type checking needed for the pattern itself
    } else if (ctx.ruleContext instanceof parser.LiteralMatchPatternContext) {
      const literalCtx = (ctx as parser.LiteralMatchPatternContext).literal();
      const literalType = this.visitLiteral(literalCtx);
      const literalValueStr = literalCtx.getText();
      addCase(literalValueStr); // Use literal value for case tracking
      console.log(`[visitPattern] Adding case (literal): ${literalValueStr}`);

      // Check if the matched type is compatible with the literal type using unification
      const result = this.unify(matchedType, literalType, new Map()); // Temp substitution map
      if (result instanceof Error) {
        this.reportError(
          `Cannot match literal ${literalValueStr} of type '${literalType}' against incompatible value of type '${matchedType}'. ${result.message}`,
          ctx
        );
      }
    }
    // Add VariableMatchPatternContext if needed
    // else if (ctx.ruleContext instanceof parser.VariableMatchPatternContext) {
    //    const varName = ctx.IDENTIFIER().getText();
    //    addCase(`variable(${varName})`);
    //    console.log(`[visitPattern] Adding case (variable): ${varName}`);
    //    // Variable pattern always matches, bind the matched type to the variable name
    //    this.environment.declare(varName, matchedType, ctx, (str) => this.reportError(str, ctx));
    //    this.hints.push({ context: ctx.IDENTIFIER().symbol, type: matchedType.toString() });
    // }
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
    console.log(
      `[instantiateGenericType] Instantiating generic type: ${
        genericType.name
      }, providedArgs: ${providedArgs.map((t) => t.toString())}`
    );

    // If specific type arguments are provided, use them directly.
    if (providedArgs.length > 0) {
      if (providedArgs.length !== genericType.typeArguments.length) {
        console.warn(
          `[instantiateGenericType] Warning: Mismatched number of type arguments provided for ${genericType.name}. Expected ${genericType.typeArguments.length}, got ${providedArgs.length}. Using provided arguments anyway.`
        );
        // Potentially report an error here instead of just warning, depending on desired strictness.
        return new GenericType(genericType.name, providedArgs);
      }
      return new GenericType(genericType.name, providedArgs);
    }

    // If no specific arguments provided, create fresh type variables.
    const substitution = new Map<string, ChicoryType>();
    const freshTypeArgs = genericType.typeArguments.map((param) => {
      if (param instanceof TypeVariable) {
        const freshVar = this.newTypeVar();
        substitution.set(param.name, freshVar);
        return freshVar;
      }
      // If the parameter wasn't a TypeVariable (unlikely for generics, but possible), keep it.
      return param;
    });

    // Return the generic type with fresh variables.
    // We don't need to manipulate constructors here; that should happen
    // when the constructor *itself* is referenced or called.
    return new GenericType(genericType.name, freshTypeArgs);
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

import { ParserRuleContext } from "antlr4ng";
import * as parser from "./generated/ChicoryParser";
import { ChicoryVisitor as ChicoryParserBaseVisitor } from "./generated/ChicoryVisitor"; // Assuming a base visitor is generated
import {
  ChicoryType,
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
  StringTypeClass,
  ArrayType,
} from "./ChicoryTypes";
import { TypeEnvironment } from "./TypeEnvironment";
import { CompilationError, TypeHint, TypeHintWithContext } from "./env";
import { Prelude } from "./Prelude";

type SubstitutionMap = Map<string, ChicoryType>;

export class ChicoryTypeChecker {
  private environment: TypeEnvironment;
  private errors: CompilationError[] = [];
  private hints: TypeHintWithContext[] = [];
  private constructors: ConstructorDefinition[] = [];
  private nextTypeVarId: number = 0;
  private currentSubstitution: SubstitutionMap = new Map();
  private expressionTypes: Map<ParserRuleContext, ChicoryType> = new Map();
  private prelude: Prelude;

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

  // Helper method to report errors
  private reportError(message: string, context: ParserRuleContext): void {
    this.errors.push({ message, context });
  }

  getConstructors(): ConstructorDefinition[] {
    return this.constructors;
  }

  // Main entry point for type checking
  check(ctx: parser.ProgramContext): {
    errors: CompilationError[];
    hints: TypeHintWithContext[];
    expressionTypes: Map<ParserRuleContext, ChicoryType>;
    prelude: Prelude;
  } {
    this.environment = new TypeEnvironment(null); // Reset to global scope
    this.prelude = new Prelude(); // Reset prelude tracker
    this.initializePrelude();
    this.errors = []; // Reset errors
    this.hints = []; // Reset hints
    // Reset constructors - but keep prelude ones!
    this.constructors = this.constructors.filter(c => c.adtName === 'Option' || c.adtName === 'Result'); // Keep built-ins
    this.currentSubstitution = new Map(); // Reset substitution
    this.nextTypeVarId = 0; // Reset type variable counter
    this.expressionTypes.clear();

    this.visitProgram(ctx);

    return {
      errors: this.errors,
      hints: this.hints,
      expressionTypes: this.expressionTypes,
      prelude: this.prelude, // Return the prelude object
    };
  }

  visitProgram(ctx: parser.ProgramContext): ChicoryType {
    ctx.stmt().forEach((stmt) => this.visitStmt(stmt));
    // Optionally handle exportStmt if needed
    return UnitType; // Program itself doesn't have a type
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
    const identifierName = ctx.identifierWrapper()!.IDENTIFIER().getText();
    const expressionCtx = ctx.expr();
    const annotationCtx = ctx.typeExpr(); // Assuming grammar allows optional typeExpr here

    let expressionType = this.visitExpr(expressionCtx);
    expressionType = this.applySubstitution(expressionType, this.currentSubstitution); // Apply subs before unification

    let finalType: ChicoryType = expressionType;

    if (annotationCtx) {
      let annotatedType = this.visitTypeExpr(annotationCtx);
      annotatedType = this.applySubstitution(annotatedType, this.currentSubstitution); // Apply subs to annotation too

      // Unify the annotated type with the inferred expression type
      const unificationResult = this.unify(annotatedType, expressionType, this.currentSubstitution);

      if (unificationResult instanceof Error) {
        this.reportError(
          `Type mismatch: Cannot assign expression of type '${expressionType}' to variable '${identifierName}' annotated with type '${annotatedType}'. ${unificationResult.message}`,
          ctx
        );
        // Use UnknownType or annotatedType? Let's use annotatedType to respect the user's intent partially.
        finalType = annotatedType;
      } else {
        // Unification successful, use the unified type (which might be more specific)
        // Apply substitutions resulting from unification
        finalType = this.applySubstitution(annotatedType, this.currentSubstitution);
      }
    }

    // Declare the variable with the final determined type
    this.environment.declare(identifierName, finalType, ctx, (str) =>
      this.reportError(str, ctx)
    );
    this.hints.push({ context: ctx.identifierWrapper()!, type: finalType.toString() }); // Add hint for variable
    return finalType;
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
    // Simplified handling for now - declare imported identifiers as UnknownType
    if (ctx.IDENTIFIER()) {
      this.environment.declare(
        ctx.IDENTIFIER()!.getText(),
        UnknownType,
        ctx,
        (str) => this.reportError(str, ctx)
      );
    }
    if (ctx.destructuringImportIdentifier()) {
      ctx
        .destructuringImportIdentifier()!
        .IDENTIFIER()
        .forEach((id) => {
          this.environment.declare(id.getText(), UnknownType, ctx, (str) =>
            this.reportError(str, ctx)
          );
        });
    }

    if (ctx.bindingImportIdentifier()) {
      ctx
        .bindingImportIdentifier()!
        .bindingIdentifier()
        .forEach((binding) => {
          // Should use the type but we aren't handling this yet
          const typeName = binding.IDENTIFIER().getText();
          const type = this.visitTypeExpr(binding.typeExpr());
          this.environment.declare(typeName, type, ctx, (str) =>
            this.reportError(str, ctx)
          );
        });
    }
    return UnitType;
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

            if (optionType instanceof GenericType && optionType.typeArguments.length > 0 && optionType.typeArguments[0] instanceof TypeVariable) {
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

            if (optionType instanceof GenericType && optionType.typeArguments.length > 0 && optionType.typeArguments[0] instanceof TypeVariable) {
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
              if (optionType.typeArguments.length > 0 && optionType.typeArguments[0] instanceof TypeVariable) {
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

    const type = this.environment.getType(identifierName);
    if (type) {
      // Apply any substitutions to the type
      const substitutedType = this.applySubstitution(
        type,
        this.currentSubstitution
      );

      // If it's a generic type, instantiate it with fresh type variables
      if (substitutedType instanceof GenericType) {
        const instantiatedType = this.instantiateGenericType(substitutedType);
        this.hints.push({ context: ctx, type: instantiatedType.toString() });
        return instantiatedType;
      }

      this.hints.push({ context: ctx, type: substitutedType.toString() });
      return substitutedType;
    }

    // Check if this is an ADT constructor
    const constructor = this.getConstructors().find(
      (c) => c.name === identifierName
    );
    if (constructor) {
      // Apply any substitutions to the constructor type
      const substitutedType = this.applySubstitution(
        constructor.type,
        this.currentSubstitution
      );
      this.hints.push({ context: ctx, type: substitutedType.toString() });

      // Check if this constructor belongs to a generic type
      const adtType = this.environment.getType(constructor.adtName);
      if (adtType instanceof GenericType) {
        // This is a constructor for a generic type
        // Instantiate the generic type with fresh type variables
        this.instantiateGenericType(adtType);

        // Get the freshly instantiated constructor
        const freshConstructor = this.constructors.find(
          (c) => c.name === identifierName && c !== constructor
        );

        if (freshConstructor) {
          return freshConstructor.type;
        }
      }

      // Special case for no-argument constructors
      if (
        substitutedType instanceof FunctionType &&
        substitutedType.paramTypes.length === 0
      ) {
        // For no-argument constructors, return the ADT type instead of the constructor type
        return new AdtType(constructor.adtName);
      }

      // For constructors with arguments, return the constructor type
      return substitutedType;
    }

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
    if (ctx.parameterList()) {
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
    }

    const returnType = this.visitExpr(ctx.expr());

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
    functionType: ChicoryType
  ): ChicoryType {
    // Apply current substitutions to the function type
    functionType = this.applySubstitution(
      functionType,
      this.currentSubstitution
    );

    if (
      !(functionType instanceof FunctionType) &&
      !(functionType instanceof GenericType)
    ) {
      this.reportError(
        `Cannot call a non-function type: '${functionType}'`,
        ctx
      );
      return UnknownType;
    }

    const argumentTypes = ctx.expr()
      ? ctx.expr().map((expr) => this.visitExpr(expr))
      : [];

    let expectedParamTypes: ChicoryType[] = [];
    let returnType: ChicoryType = UnknownType;

    if (functionType instanceof FunctionType) {
      expectedParamTypes = functionType.paramTypes;
      returnType = functionType.returnType;

      // Check if this is a constructor call for a generic type
      if (functionType.constructorName) {
        const constructor = this.constructors.find(
          (c) => c.name === functionType.constructorName
        );
        if (constructor) {
          const adtType = this.environment.getType(constructor.adtName);
          if (adtType instanceof GenericType) {
            // Create a local substitution map for this constructor call
            const localSubstitution = new Map<string, ChicoryType>();

            // Unify the parameter types with the argument types to infer type variables
            for (let i = 0; i < argumentTypes.length; i++) {
              const paramType = expectedParamTypes[i];
              const argType = argumentTypes[i];

              const result = this.unify(paramType, argType, localSubstitution);
              if (result instanceof Error) {
                this.reportError(
                  `Argument ${i + 1} type mismatch: ${result.message}`,
                  ctx
                );
              }
            }

            // Apply the local substitution to the return type
            returnType = this.applySubstitution(returnType, localSubstitution);

            // If the return type is an AdtType, convert it to a GenericType with inferred arguments
            if (
              returnType instanceof AdtType &&
              returnType.name === adtType.name
            ) {
              // Extract the inferred type arguments
              const typeArgs = adtType.typeArguments.map((typeVar) => {
                if (typeVar instanceof TypeVariable) {
                  return localSubstitution.get(typeVar.name) || typeVar;
                }
                return typeVar;
              });

              // Create a new GenericType with the inferred type arguments
              const inferredGenericType = new GenericType(
                adtType.name,
                typeArgs
              );

              // Add debug logging
              console.log(
                `[visitCallExpr] Inferred generic type: ${inferredGenericType}`
              );
              console.log(
                `[visitCallExpr] Type arguments: ${typeArgs
                  .map((t) => t.toString())
                  .join(", ")}`
              );

              // For constructor calls, we need to ensure the type arguments are properly tracked
              if (argumentTypes.length > 0) {
                // If we have arguments, use the inferred type arguments calculated above
                inferredGenericType.typeArguments = typeArgs;
              }

              return inferredGenericType;
            }

            return returnType;
          }
        }
      }
    } else if (functionType instanceof GenericType) {
      // Handle generic function types
      throw new Error("Not implemented generic type call expressions yet...");
    }

    // Create a local substitution map for this function call
    const localSubstitution = new Map<string, ChicoryType>();

    // Unify argument types with parameter types
    if (argumentTypes.length !== expectedParamTypes.length) {
      this.reportError(
        `Expected ${expectedParamTypes.length} arguments, but got ${argumentTypes.length}`,
        ctx
      );
    } else {
      for (let i = 0; i < argumentTypes.length; i++) {
        const result = this.unify(
          expectedParamTypes[i],
          argumentTypes[i],
          localSubstitution
        );
        if (result instanceof Error) {
          this.reportError(
            `Argument ${i + 1} type mismatch: ${result.message}`,
            ctx
          );
        }
      }
    }

    // Apply the local substitution to the return type
    returnType = this.applySubstitution(returnType, localSubstitution);

    // Merge the local substitution into the current substitution
    // but only for variables that appear in the function type
    for (const [varName, type] of localSubstitution.entries()) {
      // Only add substitutions for variables that appear in the function type
      if (this.variableAppearsIn(new TypeVariable(varName), functionType)) {
        this.currentSubstitution.set(varName, type);
      }
    }

    // Add a hint for debugging
    this.hints.push({ context: ctx, type: returnType.toString() });

    return returnType;
  }

  visitMatchExpr(ctx: parser.MatchExprContext): ChicoryType {
    const matchedType = this.visitExpr(ctx.expr());

    // Add debug logging
    console.log(`[visitMatchExpr] Matched type: ${matchedType}`);

    let returnTypes: ChicoryType[] = [];
    const coveredCases: string[] = []; // for exhaustiveness check
    const addCase = (str: string) => {
      console.log(`[visitMatchExpr] Adding case: ${str}`);
      coveredCases.push(str);
    };

    // Create a new scope for the match expression
    this.environment = this.environment.pushScope();

    ctx.matchArm().forEach((arm) => {
      const armReturnType = this.visitMatchArm(arm, matchedType, addCase);
      returnTypes.push(armReturnType);
    });

    // Pop the match expression scope
    this.environment = this.environment.popScope();

    console.log(
      `[visitMatchExpr] Covered cases: ${JSON.stringify(coveredCases)}`
    );
    console.log(matchedType);

    // Exhaustiveness Check
    let isExhaustive = true; // Assume exhaustive unless proven otherwise
    let missingCases: string[] = [];

    if (matchedType instanceof AdtType || matchedType instanceof GenericType) {
      const baseTypeName = matchedType.name; // Both AdtType and GenericType have a 'name' property

      // Get all constructors associated with the base type name *without modifying the global list*
      const allConstructorsForType = this.getConstructors().filter(
        (c) => c.adtName === baseTypeName
      );

      // Log the found constructors for debugging
      console.log(
        `[visitMatchExpr] Found constructors for ${baseTypeName}: ${allConstructorsForType.map(c => c.name).join(', ')}`
      );
      // console.log( // Optional: Log full types if needed
      //   `[visitMatchExpr] Found constructor types: ${JSON.stringify(
      //     allConstructorsForType.map((c) => c.type.toString())
      //   )}`
      // );

      if (allConstructorsForType.length === 0 && baseTypeName !== 'Option' && baseTypeName !== 'Result') { // Don't warn for built-ins if prelude fails silently
          console.warn(`[visitMatchExpr] Warning: No constructors found for type ${baseTypeName} during exhaustiveness check.`);
          // Cannot determine exhaustiveness if constructors aren't found
          isExhaustive = false; // Mark as potentially non-exhaustive
      }

      // Generate the list of possible case patterns based on the found constructors
      const allPossibleCases = allConstructorsForType.map((c) => {
        if (c.type instanceof FunctionType) {
          if (c.type.paramTypes.length === 0) {
            return c.name; // e.g., None
          } else {
            // Represent any parameterized constructor generically for exhaustiveness check
            return `${c.name}(*)`; // e.g., Some(*)
          }
        }
        return c.name; // Should not happen if constructors are FunctionTypes or the ADT type
      });

      console.log(
        `[visitMatchExpr] All possible cases for ${baseTypeName}: ${allPossibleCases.join(', ')}`
      );

      // Check for uncovered cases
      missingCases = allPossibleCases.filter((possibleCase) => {
        // Is this possible case covered by any of the actual cases found in the arms?
        return !coveredCases.some((coveredCase) => {
          // Case 1: Exact match (e.g., None === None)
          if (coveredCase === possibleCase) return true;

          // Case 2: Wildcard covers everything
          if (coveredCase === '*') return true;

          // Case 3: Parameterized/Wildcard covers specific parameterized case
          // e.g., covered 'Some(*)' should cover possible 'Some(*)'
          // e.g., covered 'Some(variable)' should cover possible 'Some(*)'
          // e.g., covered 'Some(Literal)' should cover possible 'Some(*)'
          const coveredParts = coveredCase.match(/^(.*?)(?:\((.*)\))?$/); // Name or Name(content)
          const possibleParts = possibleCase.match(/^(.*?)(?:\((.*)\))?$/);

          if (coveredParts && possibleParts && coveredParts[1] === possibleParts[1]) {
             // Names match (e.g., Some === Some)
             // Does the covered case represent any form of parameterization (wildcard, variable, literal)?
             if (coveredParts[2] !== undefined) { // coveredParts[2] is the content in parentheses
                 // Does the possible case also represent parameterization?
                 if (possibleParts[2] === '*') {
                     return true; // Covered parameterized case handles the general possible parameterized case
                 }
             }
          }
          return false;
        });
      });

      if (missingCases.length > 0 && !coveredCases.includes('*')) { // Only non-exhaustive if no wildcard covers the rest
        isExhaustive = false;
      }

    } else if (matchedType instanceof StringTypeClass || matchedType === StringType) {
      // String exhaustiveness: requires wildcard or variable pattern
      const hasWildcard = coveredCases.includes('*');
      const hasVariable = coveredCases.some(c => c.startsWith('variable(')); // Assuming addCase uses "variable(name)" marker
      if (!hasWildcard && !hasVariable) {
        isExhaustive = false;
        missingCases = ['_ (wildcard or variable)']; // Indicate what's missing
      }
    } else if (matchedType === NumberType || matchedType === BooleanType) {
         // Similar check for numbers/booleans: need wildcard or variable if not all literals covered
         const hasWildcard = coveredCases.includes('*');
         const hasVariable = coveredCases.some(c => c.startsWith('variable('));
         // A full check would require seeing if all possible literal values (true/false) are covered,
         // which is complex. For now, just require wildcard/variable for guaranteed exhaustiveness.
         if (!hasWildcard && !hasVariable) {
             // We can't be certain it's exhaustive without listing all literals
             // Let's not report an error, but maybe a warning or hint later?
             // For now, assume okay if specific literals are matched.
         }
    }
    // Add checks for other matchable types like Tuples, Records if needed

    // Report error if determined to be non-exhaustive
    if (!isExhaustive) {
       this.reportError(
         `Match expression on type '${matchedType}' may not be exhaustive. Missing cases: ${missingCases.join(", ")}`,
         ctx
       );
    }
    // --- End Exhaustiveness Check ---


    /**
     * TODO: Check that all arms are possible to reach:
     * It's meaningless to have:
     *    match (X) {
     *        Arm(_) => "wildcard"
     *        Arm(y) => "variable"
     *    }
     * because the first arm matches everything the second arm would.
     */

    // Check that all arms return the same type
    const firstType = returnTypes[0] || UnknownType;
    for (let i = 1; i < returnTypes.length; i++) {
      if (!typesAreEqual(firstType, returnTypes[i])) {
        this.reportError(
          `Match arms must all return the same type. Expected '${firstType}', found '${returnTypes[i]}'`,
          ctx.matchArm()[i]
        );
        return UnknownType;
      }
    }

    return firstType;
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
    addCase: (str: string) => void // Accepts string
  ): void {
    // Apply substitution to matchedType *before* checking its instance type
    const substitution: SubstitutionMap = new Map(); // Local substitution for pattern checks if needed
    matchedType = this.applySubstitution(matchedType, this.currentSubstitution); // Use main substitution

    console.log(`[visitPattern] Checking pattern '${ctx.getText()}' against matched type '${matchedType}'`); // Debug

    if (ctx.ruleContext instanceof parser.BareAdtMatchPatternContext) {
      const adtName = (ctx as parser.BareAdtMatchPatternContext)
        .IDENTIFIER()
        .getText();
      addCase(adtName); // Simple name for bare constructor
      console.log(`[visitPattern] Adding case (bare ADT): ${adtName}`);

      let baseTypeName: string | null = null;
      if (matchedType instanceof AdtType || matchedType instanceof GenericType) {
          baseTypeName = matchedType.name;
      } else if (matchedType instanceof TypeVariable) {
          console.log(`[visitPattern] Matching bare ADT '${adtName}' against TypeVariable '${matchedType.name}'. Cannot verify constructor statically.`);
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
         if (constructor.type instanceof FunctionType && constructor.type.paramTypes.length > 0) {
             this.reportError(`Constructor '${adtName}' expects arguments, but none were provided in the pattern.`, ctx);
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
      if (matchedType instanceof AdtType || matchedType instanceof GenericType) {
          baseTypeName = matchedType.name;
      } else if (matchedType instanceof TypeVariable) {
          console.log(`[visitPattern] Matching ADT pattern '${adtName}(${paramName})' against TypeVariable '${matchedType.name}'. Cannot verify constructor statically.`);
          // Declare param as Unknown or a fresh TypeVar? Let's use Unknown for now.
          this.environment.declare(paramName, UnknownType, ctx, (str) => this.reportError(str, ctx));
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
      if (!(constructorType instanceof FunctionType) || constructorType.paramTypes.length !== 1) {
            this.reportError(
                `Constructor '${adtName}' does not take exactly one parameter as expected by pattern '${adtName}(${paramName})'.`,
                ctx
            );
            // Declare param as Unknown to avoid cascading errors
            this.environment.declare(paramName, UnknownType, ctx, (str) => this.reportError(str, ctx));
            this.hints.push({ context: ctx, type: UnknownType.toString() });
            return;
      }

      // --- Infer parameter type ---
      let paramType: ChicoryType = UnknownType;
      const originalParamType = constructorType.paramTypes[0];

      // If the matched type is a specific generic instance (like Option<string>)
      // and the constructor parameter involves type variables from the generic definition (like T in Some(T)),
      // we need to substitute T with the specific type argument (string).
      if (matchedType instanceof GenericType && matchedType.typeArguments.length > 0 &&
          constructorType.returnType instanceof GenericType && constructorType.returnType.typeArguments.length > 0)
      {
          // Create substitution map from the generic ADT's parameters to the matched type's arguments
          const instantiationSubst = new Map<string, ChicoryType>();
          const adtDefinition = this.environment.getType(baseTypeName); // Get the generic definition (e.g., Option<T>)

          if (adtDefinition instanceof GenericType && adtDefinition.typeArguments.length === matchedType.typeArguments.length) {
              for (let i = 0; i < adtDefinition.typeArguments.length; i++) {
                  const genericVar = adtDefinition.typeArguments[i];
                  if (genericVar instanceof TypeVariable) {
                      instantiationSubst.set(genericVar.name, matchedType.typeArguments[i]);
                  }
              }
              paramType = this.applySubstitution(originalParamType, instantiationSubst);
              console.log(`[visitPattern] Instantiated param type for ${adtName}(${paramName}) from ${originalParamType} to ${paramType} using matched type ${matchedType}`);
          } else {
               console.warn(`[visitPattern] Mismatch between generic definition and matched type arguments for ${baseTypeName}. Using original param type.`);
               paramType = originalParamType; // Fallback
          }
      } else {
          // Not a generic match, or no arguments; use the constructor's defined parameter type directly
          paramType = originalParamType;
          console.log(`[visitPattern] Using constructor param type for ${adtName}(${paramName}): ${paramType}`);
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
      if (matchedType instanceof AdtType || matchedType instanceof GenericType) {
          baseTypeName = matchedType.name;
      } else if (matchedType instanceof TypeVariable) {
          console.log(`[visitPattern] Matching ADT wildcard pattern '${adtName}(_)' against TypeVariable '${matchedType.name}'. Cannot verify constructor statically.`);
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
      if (!(constructorType instanceof FunctionType) || constructorType.paramTypes.length !== 1) {
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
      const literalCtx = (ctx as parser.AdtWithLiteralMatchPatternContext).literal();
      const literalType = this.visitLiteral(literalCtx);
      const literalValueStr = literalCtx.getText(); // For addCase
      addCase(`${adtName}(*)`); // Standardize parameterized case for exhaustiveness
      console.log(
        `[visitPattern] Adding case (ADT with literal): ${adtName}(${literalValueStr})`
      );

      let baseTypeName: string | null = null;
      if (matchedType instanceof AdtType || matchedType instanceof GenericType) {
          baseTypeName = matchedType.name;
      } else if (matchedType instanceof TypeVariable) {
          console.log(`[visitPattern] Matching ADT literal pattern '${adtName}(${literalValueStr})' against TypeVariable '${matchedType.name}'. Cannot verify constructor or literal type statically.`);
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
      if (!(constructorType instanceof FunctionType) || constructorType.paramTypes.length !== 1) {
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
      if (matchedType instanceof GenericType && matchedType.typeArguments.length > 0 &&
          constructorType.returnType instanceof GenericType && constructorType.returnType.typeArguments.length > 0)
      {
           const instantiationSubst = new Map<string, ChicoryType>();
           const adtDefinition = this.environment.getType(baseTypeName);
           if (adtDefinition instanceof GenericType && adtDefinition.typeArguments.length === matchedType.typeArguments.length) {
               for (let i = 0; i < adtDefinition.typeArguments.length; i++) {
                   const genericVar = adtDefinition.typeArguments[i];
                   if (genericVar instanceof TypeVariable) {
                       instantiationSubst.set(genericVar.name, matchedType.typeArguments[i]);
                   }
               }
               expectedParamType = this.applySubstitution(originalParamType, instantiationSubst);
               console.log(`[visitPattern] Instantiated expected param type for ${adtName}(${literalValueStr}) from ${originalParamType} to ${expectedParamType} using matched type ${matchedType}`);
           } else {
                console.warn(`[visitPattern] Mismatch between generic definition and matched type arguments for ${baseTypeName}. Using original param type for literal check.`);
                expectedParamType = originalParamType; // Fallback
           }
      } else {
          expectedParamType = originalParamType;
          console.log(`[visitPattern] Using constructor param type for ${adtName}(${literalValueStr}): ${expectedParamType}`);
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
        console.error(`[visitPattern] Unhandled pattern context type: ${ctx.constructor.name}`);
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
            console.warn(`[instantiateGenericType] Warning: Mismatched number of type arguments provided for ${genericType.name}. Expected ${genericType.typeArguments.length}, got ${providedArgs.length}. Using provided arguments anyway.`);
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

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
} from "./ChicoryTypes";
import { TypeEnvironment } from "./TypeEnvironment";
import { CompilationError, TypeHint, TypeHintWithContext } from "./env";

type SubstitutionMap = Map<string, ChicoryType>;

export class ChicoryTypeChecker {
  private environment: TypeEnvironment;
  private errors: CompilationError[] = [];
  private hints: TypeHintWithContext[] = [];
  private constructors: ConstructorDefinition[] = [];
  private nextTypeVarId: number = 0;

  constructor() {
    this.environment = new TypeEnvironment(null); // Initialize with the global scope
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

    console.log(`[unify] Unifying type1: ${type1}`);
    console.log(`[unify] Unifying type2: ${type2}`);

    if (typesAreEqual(type1, type2)) {
      console.log(`[unify] Types are equal, returning: ${type1}`);
      return type1;
    }

    if (type1 instanceof GenericType && type1.typeArguments.length === 0) {
      // A generic type with no arguments can be unified with any type
      // This is similar to a type variable
      if (this.occursIn(new TypeVariable(type1.name), type2)) {
        console.log(`[unify] Occurs check failed for ${type1.name} in ${type2}`);
        return new Error(
          `Cannot unify ${type1} with ${type2} (fails occurs check)`
        );
      }
      console.log(`[unify] Unifying generic ${type1.name} with ${type2}`);
      substitution.set(type1.name, type2);
      return type2;
    }

    // Also handle the reverse case
    if (type2 instanceof GenericType && type2.typeArguments.length === 0) {
      console.log(`[unify] Handling reverse case - generic type2`);
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

    // Add case for GenericType
    if (type instanceof GenericType) {
      if (type.typeArguments.length === 0 && substitution.has(type.name)) {
        return this.applySubstitution(substitution.get(type.name)!, substitution);
      }
      return new GenericType(
        type.name,
        type.typeArguments.map(t => this.applySubstitution(t, substitution))
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
      return new FunctionType(newParamTypes, newReturnType, type.constructorName);
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

    // Add case for GenericType
    if (type instanceof GenericType) {
      if (type.name === typeVar.name) {
        return true;
      }
      return type.typeArguments.some(t => this.occursIn(typeVar, t));
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
  } {
    this.environment = new TypeEnvironment(null); // Reset to global scope
    this.errors = []; // Reset errors
    this.hints = []; // Reset hints
    this.constructors = []; // Reset constructors

    this.visitProgram(ctx);
    return { errors: this.errors, hints: this.hints };
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
    const expressionType = this.visitExpr(ctx.expr());
    
    // Apply any pending substitutions to the expression type
    const substitution: SubstitutionMap = new Map();
    const finalType = this.applySubstitution(expressionType, substitution);
    
    console.log(`[visitAssignStmt] Declaring ${identifierName} with type ${finalType}`);
    
    this.environment.declare(identifierName, finalType, ctx, (str) =>
      this.reportError(str, ctx)
    );
    return finalType;
  }

  visitTypeDefinition(ctx: parser.TypeDefinitionContext): ChicoryType {
    const typeName = ctx.IDENTIFIER().getText();
    const type = this.visitTypeExpr(ctx.typeExpr(), typeName);

    // Not doing full handling right now.
    this.environment.declare(typeName, type, ctx, (str) =>
      this.reportError(str, ctx)
    );
    return type;
  }

  private visitTypeExpr(
    ctx: parser.TypeExprContext,
    typeName?: string
  ): ChicoryType {
    if (ctx.adtType()) {
      // This is a generic if the "ADT" is not already declared
      const maybeAdtOption = ctx.adtType()?.adtOption();
      if (
        maybeAdtOption?.length === 1 &&
        maybeAdtOption[0] instanceof parser.AdtOptionNoArgContext
      ) {
        const possibleGeneric = maybeAdtOption[0].IDENTIFIER().getText();
        const isInEnvironment = this.environment.getType(possibleGeneric);
        if (!isInEnvironment) {
            console.log("Generic:", possibleGeneric)
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
    }

    this.reportError(
      `Type definition not fully supported yet: ${ctx.getText()}`,
      ctx
    );
    return UnknownType; // For now
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
      let val: ChicoryType;
      if (kv.primitiveType()) {
        val = this.getPrimitiveType(kv.primitiveType()!);
      } else if (kv.recordType()) {
        val = this.visitRecordType(kv.recordType()!);
      } else {
        val =
          this.environment.getType(kv.IDENTIFIER()[1].getText()) || UnknownType;
      }

      recordType.fields.set(kv.IDENTIFIER()[0].getText(), val);
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
          const fieldType = annotation.primitiveType()
            ? this.getPrimitiveType(annotation.primitiveType()!)
            : this.environment.getType(annotation.IDENTIFIER()[1].getText()) ||
              UnknownType; // Handle type references
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

        const paramType =
          this.environment.getType(option.IDENTIFIER()[1].getText()) ||
          UnknownType; // Get the named type
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
    if (ctx.getText() === "unit") return UnitType;
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
    if (ctx.ruleContext instanceof parser.MemberExpressionContext) {
      const memberName = (ctx as parser.MemberExpressionContext)
        .IDENTIFIER()
        .getText();
      if (!(baseType instanceof RecordType)) {
        this.reportError(
          `Cannot access member '${memberName}' on type '${baseType}'`,
          ctx
        );
        return UnknownType;
      }
      if (!baseType.fields.has(memberName)) {
        this.reportError(
          `Member '${memberName}' not found on type '${baseType}'`,
          ctx
        );
        return UnknownType;
      }
      return baseType.fields.get(memberName)!;
    } else if (ctx.ruleContext instanceof parser.IndexExpressionContext) {
      const indexType = this.visitExpr(
        (ctx as parser.IndexExpressionContext).expr()
      );
      if (!(baseType instanceof TupleType)) {
        this.reportError(`Cannot index into type '${baseType}'`, ctx);
        return UnknownType;
      }
      if (indexType !== NumberType) {
        this.reportError(`Index must be a number`, ctx);
        return UnknownType;
      }

      // Try to evaluate the index if it's a literal
      const indexExpr = (ctx as parser.IndexExpressionContext).expr().primaryExpr();
      if (indexExpr instanceof parser.LiteralExpressionContext) {
        const indexValue = parseInt(indexExpr.getText());
        if (
          !isNaN(indexValue) &&
          indexValue >= 0 &&
          indexValue < baseType.elementTypes.length
        ) {
          // Return the element type at the specified index
          return baseType.elementTypes[indexValue];
        }
        else {
            this.reportError("Tuple index out of range", ctx);
            return UnknownType;
        }
      }

      // If we can't determine the exact index, return UnknownType
      // This is safer than assuming it's the first element
      this.reportError(`Cannot determine index at compile time`, ctx);
      return UnknownType;
    } else if (ctx.ruleContext instanceof parser.CallExpressionContext) {
      return this.visitCallExpr(
        (ctx as parser.CallExpressionContext).callExpr(),
        baseType
      ); // Pass baseType
    } else if (ctx.ruleContext instanceof parser.OperationExpressionContext) {
      return this.visitOperation(
        ctx as parser.OperationExpressionContext,
        baseType
      );
    }

    this.reportError(`Unknown tail expression type: ${ctx.getText()}`, ctx);
    return UnknownType;
  }

  visitOperation(
    ctx: parser.OperationExpressionContext,
    baseType: ChicoryType
  ): ChicoryType {
    const operator = ctx.OPERATOR().getText();
    const rhsType = this.visitExpr(ctx.expr());

    switch (operator) {
      case "+":
        if (baseType === NumberType && rhsType === NumberType) {
          return NumberType;
        } else if (baseType === StringType && rhsType === StringType) {
          return StringType;
        } else {
          this.reportError(
            `Operator '+' cannot be applied to types '${baseType}' and '${rhsType}'`,
            ctx
          );
          return UnknownType;
        }
      case "-":
      case "*":
      case "/":
        if (baseType === NumberType && rhsType === NumberType) {
          return NumberType;
        } else {
          this.reportError(
            `Operator '${operator}' cannot be applied to types '${baseType}' and '${rhsType}'`,
            ctx
          );
          return UnknownType;
        }
      case "==":
      case "!=":
      case "<":
      case ">":
      case "<=":
      case ">=":
        // Basic compatibility check
        if (
          (baseType === NumberType && rhsType === NumberType) ||
          (baseType === StringType && rhsType === StringType) ||
          (baseType === BooleanType && rhsType === BooleanType)
        ) {
          return BooleanType;
        } else {
          this.reportError(
            `Operator '${operator}' cannot be applied to types '${baseType}' and '${rhsType}'`,
            ctx
          );
          return UnknownType;
        }

      case "&&":
      case "||":
        if (baseType === BooleanType && rhsType === BooleanType) {
          return BooleanType;
        } else {
          this.reportError(
            `Operator '${operator}' cannot be applied to types '${baseType}' and '${rhsType}'`,
            ctx
          );
          return UnknownType;
        }
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
    console.log(`[visitIdentifier] Processing identifier: ${identifierName}`);

    const type = this.environment.getType(identifierName);
    if (type) {
      console.log(
        `[visitIdentifier] Found type in environment for ${identifierName}: ${type}`
      );
      this.hints.push({ context: ctx, type: type.toString() });
      return type;
    }

    // Check if this is an ADT constructor
    const constructor = this.getConstructors().find(
      (c) => c.name === identifierName
    );
    if (constructor) {
      console.log(`[visitIdentifier] Found constructor: ${identifierName}`);
      console.log(`[visitIdentifier] Constructor Name: ${constructor.name}`);
      console.log(
        `[visitIdentifier] Constructor ADT Name: ${constructor.adtName}`
      );
      console.log(
        `[visitIdentifier] Constructor Type (FunctionType): ${constructor.type}`
      );
      this.hints.push({ context: ctx, type: constructor.type.toString() });
      
      // Special case for no-argument constructors
      if (constructor.type instanceof FunctionType && constructor.type.paramTypes.length === 0) {
        // For no-argument constructors, return the ADT type instead of the constructor type
        console.log(`[visitIdentifier] No-argument constructor, returning ADT type: ${constructor.adtName}`);
        return new AdtType(constructor.adtName);
      }
      
      // For constructors with arguments, return the constructor type
      return constructor.type;
    } else {
      console.log(
        `[visitIdentifier] Constructor NOT found for: ${identifierName}`
      );
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
    console.log(`[visitRecordExpr] Created record type: ${recordType}`);
    this.hints.push({ context: ctx, type: recordType.toString() });
    
    return recordType;
  }

  visitArrayLikeExpr(ctx: parser.ArrayLikeExprContext): ChicoryType {
    const elementTypes = ctx.expr().map((expr) => this.visitExpr(expr));
    if (elementTypes.length === 0) {
      return new TupleType([]); // Empty tuple
    }
    // Basic homogeneous array check for now
    const firstElementType = elementTypes[0];
    for (let i = 1; i < elementTypes.length; i++) {
      if (elementTypes[i] !== firstElementType) {
        this.reportError(
          `Array elements must have the same type. Expected '${firstElementType}', found '${elementTypes[i]}'`,
          ctx.expr()[i]
        );
        //  return new ArrayType(UnknownType); // Or some other error handling
      }
    }

    return new TupleType(elementTypes);
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

    if (conditionType !== BooleanType) {
      this.reportError(
        `Condition of if expression must be boolean, but got '${conditionType}'`,
        ctx.justIfExpr()[0].expr()[0]
      );
    }

    const thenType = this.visitExpr(ctx.justIfExpr()[0].expr()[1]);

    // Check 'else if' branches
    for (let i = 1; i < ctx.justIfExpr().length; i++) {
      const elseIfConditionType = this.visitExpr(ctx.justIfExpr()[i].expr()[0]);
      if (elseIfConditionType !== BooleanType) {
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
    this.environment = this.environment.pushScope(); // Push a new scope for function parameters

    const paramTypes: ChicoryType[] = [];
    if (ctx.parameterList()) {
      ctx
        .parameterList()!
        .IDENTIFIER()
        .forEach((param) => {
          // For now, declare params as UnknownType; we're not handling explicit type annotations on params yet.
          const paramName = param.getText();
          // TODO: Fix the scoping of this context (probably need to wrap param in .g4 or something)
          // this.environment.declare(paramName, UnknownType, param, (str) => this.reportError(str, param));
          this.environment.declare(paramName, UnknownType, ctx, (str) =>
            this.reportError(str, ctx)
          );
          paramTypes.push(UnknownType);
        });
    }

    const returnType = this.visitExpr(ctx.expr());
    this.environment = this.environment.popScope()!; // Pop the function scope
    return new FunctionType(paramTypes, returnType);
  }

  visitCallExpr(
    ctx: parser.CallExprContext,
    functionType: ChicoryType
  ): ChicoryType {
    // Add debug logging
    console.log(`[visitCallExpr] Function type: ${functionType}`);
    
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
    
    // Add debug logging
    console.log(`[visitCallExpr] Argument types: ${argumentTypes.map(t => t.toString()).join(', ')}`);
    
    let expectedParamTypes: ChicoryType[] = [];
    let returnType: ChicoryType = UnknownType;

    if (functionType instanceof FunctionType) {
      expectedParamTypes = functionType.paramTypes;
      returnType = functionType.returnType;
      console.log(`[visitCallExpr] Expected param types: ${expectedParamTypes.map(t => t.toString()).join(', ')}`);
      console.log(`[visitCallExpr] Return type before substitution: ${returnType}`);
    } else if (functionType instanceof GenericType) {
      // 1. Lookup the generic type def (e..g, from a bind stmt). For now let's assume a simple case.
      //  Ideally, we'd have a way to store and retrieve bound types from import stmts.
      // Maybe we have a function `getBoundType` that does this
      // const boundType = this.getBoudType(functionType.name);
      throw new Error("Not implemented generic type call expressions yet...");
    }

    const substitution: SubstitutionMap = new Map();

    // unify argument types with parameter types
    if (argumentTypes.length !== expectedParamTypes.length) {
      this.reportError(
        `Expected ${expectedParamTypes.length} arguments, but got ${argumentTypes.length}`,
        ctx
      );
    } else {
      for (let i = 0; i < argumentTypes.length; i++) {
        console.log(`[visitCallExpr] Unifying param ${i}: ${expectedParamTypes[i]} with arg: ${argumentTypes[i]}`);
        const result = this.unify(
          expectedParamTypes[i],
          argumentTypes[i],
          substitution
        );
        if (result instanceof Error) {
          this.reportError(
            `Argument ${i + 1} type mismatch: ${result.message}`,
            ctx
          );
        } else {
          console.log(`[visitCallExpr] Unified result for param ${i}: ${result}`);
        }
      }
    }

    returnType = this.applySubstitution(returnType, substitution);
    
    // Add a hint for debugging
    console.log(`[visitCallExpr] Return type after substitution: ${returnType}`);
    this.hints.push({ context: ctx, type: returnType.toString() });
    
    return returnType;
  }

  visitMatchExpr(ctx: parser.MatchExprContext): ChicoryType {
    const matchedType = this.visitExpr(ctx.expr());
    let returnTypes: ChicoryType[] = [];

    ctx.matchArm().forEach((arm) => {
      returnTypes.push(this.visitMatchArm(arm, matchedType));
    });

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
    const substitution: SubstitutionMap = new Map();
    matchedType = this.applySubstitution(matchedType, substitution);

    if (ctx.ruleContext instanceof parser.BareAdtMatchPatternContext) {
      const adtName = (ctx as parser.BareAdtMatchPatternContext)
        .IDENTIFIER()
        .getText();
      // Check if matchedType is an ADT, a type variable, or a generic type
      if (
        !(matchedType instanceof AdtType) && 
        !(matchedType instanceof TypeVariable) && 
        !(matchedType instanceof GenericType)
      ) {
        // Add specific error for function types
        if (matchedType instanceof FunctionType) {
          this.reportError(
            `Cannot match a function of type '${matchedType}' against ADT pattern '${adtName}'. Did you mean to match against the function's return value?`,
            ctx
          );
        } else {
          this.reportError(
            `Cannot match a value of type '${matchedType}' against ADT pattern '${adtName}'`,
            ctx
          );
        }
        return;
      }

      // If it's a type variable or generic type, we can't check the constructor at compile time
      if (
        matchedType instanceof TypeVariable || 
        (matchedType instanceof GenericType && matchedType.typeArguments.length === 0)
      ) {
        // Just assume it's valid for now
        return;
      }

      console.log("type???:", matchedType)
      // Check if the constructor exists for this ADT
      const constructor = this.constructors.find(
        (c) => c.name === adtName && c.adtName === matchedType?.name
      );
      if (!constructor) {
        this.reportError(
          `Constructor ${adtName} does not exist on type ${matchedType?.name}`,
          ctx
        );
      }
    } else if (
      ctx.ruleContext instanceof parser.AdtWithParamMatchPatternContext
    ) {
      const [adtName, paramName] = (
        ctx as parser.AdtWithParamMatchPatternContext
      )
        .IDENTIFIER()
        .map((id) => id.getText());

      if (!(matchedType instanceof AdtType)) {
        this.reportError(
          `Cannot match a value of type '${matchedType}' against ADT pattern '${adtName}'`,
          ctx
        );
        return;
      }

      // Find constructor.
      const constructor = this.constructors.find(
        (c) => c.name === adtName && c.adtName === matchedType.name
      );

      if (!constructor) {
        this.reportError(
          `Constructor ${adtName} does not exist on on type ${matchedType.name}`,
          ctx
        );
        return;
      }

      const constructorType = constructor.type;

      if (!(constructorType instanceof FunctionType)) {
        this.reportError(
          `Constructor ${adtName} does not take a parameter on on type ${matchedType.name}`,
          ctx
        );
        return;
      }

      // Declare the parameter (we are inferring the type).
      this.environment.declare(
        paramName,
        constructorType.paramTypes[0],
        ctx,
        (str) => this.reportError(str, ctx)
      );
    } else if (
      ctx.ruleContext instanceof parser.AdtWithLiteralMatchPatternContext
    ) {
      const adtName = (ctx as parser.AdtWithLiteralMatchPatternContext)
        .IDENTIFIER()
        .getText();
      if (!(matchedType instanceof AdtType)) {
        this.reportError(
          `Cannot match a value of type '${matchedType}' against ADT pattern '${adtName}'`,
          ctx
        );
        return;
      }

      // Find constructor.
      const constructor = this.constructors.find(
        (c) => c.name === adtName && c.adtName === matchedType.name
      );

      if (!constructor) {
        this.reportError(
          `Constructor ${adtName} does not exist on on type ${matchedType.name}`,
          ctx
        );
        return;
      }

      const constructorType = constructor.type;

      if (!(constructorType instanceof FunctionType)) {
        this.reportError(
          `Constructor ${adtName} does not take a parameter on on type ${matchedType.name}`,
          ctx
        );
        return;
      }

      const literalType = this.visitLiteral(
        (ctx as parser.AdtWithLiteralMatchPatternContext).literal()
      );

      if (constructorType.paramTypes[0] !== literalType) {
        this.reportError(`Incorrect literal type`, ctx);
      }
    } else if (ctx.ruleContext instanceof parser.WildcardMatchPatternContext) {
      // Always matches
    } else if (ctx.ruleContext instanceof parser.LiteralMatchPatternContext) {
      const literalType = this.visitLiteral(
        (ctx as parser.LiteralMatchPatternContext).literal()
      );
      
      // Check if the matched type is compatible with the literal type
      const result = this.unify(matchedType, literalType, new Map());
      if (result instanceof Error) {
        this.reportError(
          `Cannot match a literal of type '${literalType}' against a value of type '${matchedType}'`,
          ctx
        );
      }
    }
  }

  visitJsxExpr(ctx: parser.JsxExprContext): ChicoryType {
    // For now we will treat all JSX as untyped
    return UnknownType;
  }

  // You *could* override visit methods you don't need, but it's not strictly necessary.
  // The base visitor will provide default (empty) implementations.

  // Example:  If you didn't need to handle jsxAttributes, you could leave it out entirely.
  // visitJsxAttributes(ctx: parser.JsxAttributesContext): ChicoryType { ... }
}

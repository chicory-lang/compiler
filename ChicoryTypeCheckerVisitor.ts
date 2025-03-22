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
  private currentSubstitution: SubstitutionMap = new Map();

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

    if (typesAreEqual(type1, type2)) {
      return type1;
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
  } {
    this.environment = new TypeEnvironment(null); // Reset to global scope
    this.errors = []; // Reset errors
    this.hints = []; // Reset hints
    this.constructors = []; // Reset constructors
    this.currentSubstitution = new Map(); // Reset substitution
    this.nextTypeVarId = 0; // Reset type variable counter

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

    this.environment.declare(identifierName, finalType, ctx, (str) =>
      this.reportError(str, ctx)
    );
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
      const indexExpr = (ctx as parser.IndexExpressionContext)
        .expr()
        .primaryExpr();
      if (indexExpr instanceof parser.LiteralExpressionContext) {
        const indexValue = parseInt(indexExpr.getText());
        if (
          !isNaN(indexValue) &&
          indexValue >= 0 &&
          indexValue < baseType.elementTypes.length
        ) {
          // Return the element type at the specified index
          return baseType.elementTypes[indexValue];
        } else {
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
    const elementTypes = ctx.expr().map((expr) => this.visitExpr(expr));
    if (elementTypes.length === 0) {
      return new TupleType([]); // Empty tuple
    }
    // Basic homogeneous array check for now
    const firstElementType = elementTypes[0];
    for (let i = 1; i < elementTypes.length; i++) {
      if (!typesAreEqual(elementTypes[i], firstElementType)) {
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
                // If we have arguments, use their types as the type arguments
                // This is a simplification, but works for simple cases like Some(string)
                const directTypeArg = argumentTypes[0];
                inferredGenericType.typeArguments = [directTypeArg];

                console.log(
                  `[visitCallExpr] Direct type argument: ${directTypeArg}`
                );
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
    if (matchedType instanceof AdtType || matchedType instanceof GenericType) {
      const baseTypeName =
        matchedType instanceof AdtType ? matchedType.name : matchedType.name;

      // *** TEMPORARILY REVERSE THE CONSTRUCTOR LIST ***
      const originalConstructors = this.getConstructors();
      const reversedConstructors = [...originalConstructors].reverse();
      this.constructors = reversedConstructors;

      let allConstructorsForAdt = this.getConstructors().filter(
        (c) => c.adtName === baseTypeName
      );

      if (matchedType instanceof GenericType) {
        const baseTypeName = matchedType.name;

        const originalConstructors = this.getConstructors();
        const reversedConstructors = [...originalConstructors].reverse();
        this.constructors = reversedConstructors;

        let allConstructorsForAdt = this.getConstructors().filter(
          (constructor) => {
            if (!(constructor.type instanceof FunctionType)) return false;
            const constructorReturnType = constructor.type.returnType;
            if (!(constructorReturnType instanceof GenericType)) return false;
            if (
              constructorReturnType.typeArguments.length !==
              matchedType.typeArguments.length
            )
              return false;
            for (let i = 0; i < matchedType.typeArguments.length; i++) {
              const matchedTypeArg = matchedType.typeArguments[i];
              const constructorTypeArg = constructorReturnType.typeArguments[i];

              console.log(
                `[visitMatchExpr] [FILTER DEBUG] Unifying Matched Type Arg: ${matchedTypeArg} with Constructor Type Arg: ${constructorTypeArg}`
              ); // ADDED DEBUGGING
              const result = this.unify(
                matchedTypeArg,
                constructorTypeArg,
                new Map()
              );
              console.log(
                `[visitMatchExpr] [FILTER DEBUG] Unification Result: ${
                  result instanceof Error ? "Error" : "Success"
                }`
              ); // ADDED DEBUGGING
              if (result instanceof Error) {
                return false;
              }
            }
            return true;
          }
        );
      }

      const allPossibleCases = allConstructorsForAdt.map((c) => {
        if (c.type instanceof FunctionType) {
          if (c.type.paramTypes.length === 0) {
            return c.name;
          } else if (c.type.paramTypes.length === 1) {
            if (
              c.type.paramTypes[0] === NumberType ||
              c.type.paramTypes[0] === StringType ||
              c.type.paramTypes[0] === BooleanType
            ) {
              return `${c.name}(${c.type.paramTypes[0]})`;
            }
            return `${c.name}(*)`; // Single parameter: represent with *
          } else {
            return `${c.name}(*)`;
          }
        }
        return c.name; // No-arg constructor
      });

      console.log(
        `[visitMatchExpr] All constructors for ${baseTypeName}: ${allPossibleCases}`
      );
      console.log(
        `[visitMatchExpr] All constructors for ${baseTypeName}: ${JSON.stringify(
          allConstructorsForAdt.map((c) => c.type)
        )}`
      );

      const uncoveredCases = allPossibleCases.filter(
        (possibleCase) => !coveredCases.includes(possibleCase)
      );

      if (uncoveredCases.length > 0) {
        this.reportError(
          `Match expression on '${
            matchedType.name
          }' is not exhaustive.  Missing cases: ${uncoveredCases.join(", ")}`,
          ctx
        );
      }
      // *** RESTORE ORIGINAL CONSTRUCTOR ORDER ***
      this.constructors = originalConstructors;
    } else if (matchedType instanceof StringTypeClass) {
      // One arm must have a wildcard/variable:
      if (!coveredCases.includes("*")) {
        this.reportError("Strings require a wildcard or variable", ctx);
      }
    }

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
    const substitution: SubstitutionMap = new Map();
    matchedType = this.applySubstitution(matchedType, substitution);

    if (ctx.ruleContext instanceof parser.BareAdtMatchPatternContext) {
      const adtName = (ctx as parser.BareAdtMatchPatternContext)
        .IDENTIFIER()
        .getText();
      addCase(adtName); // Simple name for bare constructor
      console.log(`[visitPattern] Adding case of bare ADT: ${adtName}`);

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

      // If it's a type variable or generic type with no arguments, we can't check the constructor at compile time
      if (
        matchedType instanceof TypeVariable ||
        (matchedType instanceof GenericType &&
          matchedType.typeArguments.length === 0)
      ) {
        // Just assume it's valid for now
        return;
      }

      // Get the base type name for constructor lookup
      let baseTypeName: string;
      if (matchedType instanceof AdtType) {
        baseTypeName = matchedType.name;
      } else if (matchedType instanceof GenericType) {
        baseTypeName = matchedType.name;
      } else {
        // This shouldn't happen due to the checks above
        this.reportError(
          `Cannot match a value of type '${matchedType}' against ADT pattern '${adtName}'`,
          ctx
        );
        return;
      }

      // Check if the constructor exists for this ADT
      const constructor = this.constructors.find(
        (c) => c.name === adtName && c.adtName === baseTypeName
      );
      if (!constructor) {
        this.reportError(
          `Constructor ${adtName} does not exist on type ${baseTypeName}`,
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
      addCase(`${adtName}(*)`); // Use * for parameterized constructor
      console.log(
        `[visitPattern] Adding case of param ADT: ${adtName} with param: ${paramName}`
      );

      // Check if matchedType is an ADT or a generic type
      if (
        !(matchedType instanceof AdtType) &&
        !(matchedType instanceof GenericType)
      ) {
        this.reportError(
          `Cannot match a value of type '${matchedType}' against ADT pattern '${adtName}'`,
          ctx
        );
        return;
      }

      // Get the base type name for constructor lookup
      let baseTypeName: string;
      if (matchedType instanceof AdtType) {
        baseTypeName = matchedType.name;
      } else if (matchedType instanceof GenericType) {
        baseTypeName = matchedType.name;
      } else {
        // This shouldn't happen due to the checks above
        this.reportError(
          `Cannot match a value of type '${matchedType}' against ADT pattern '${adtName}'`,
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
          `Constructor ${adtName} does not exist on type ${baseTypeName}`,
          ctx
        );
        return;
      }

      const constructorType = constructor.type;

      if (!(constructorType instanceof FunctionType)) {
        this.reportError(
          `Constructor ${adtName} does not take a parameter on type ${baseTypeName}`,
          ctx
        );
        return;
      }

      let paramType: ChicoryType;
      if (matchedType instanceof GenericType) {
        if (matchedType.typeArguments.length > 0) {
          paramType = matchedType.typeArguments[0];
        } else {
          paramType = new TypeVariable(`${paramName}Type`);
        }
      } else {
        paramType = constructorType.paramTypes[0];
      }

      // Declare the parameter with the inferred type
      this.environment.declare(paramName, paramType, ctx, (str) =>
        this.reportError(str, ctx)
      );
    } else if (
      ctx.ruleContext instanceof parser.AdtWithWildcardMatchPatternContext
    ) {
      const adtName = (ctx as parser.AdtWithWildcardMatchPatternContext)
        .IDENTIFIER()
        .getText();
      addCase(`${adtName}(*)`); // Indicate wildcard parameter in case tracking
      console.log(
        `[visitPattern] Adding case of ADT with wildcard: ${adtName}(_)`
      );

      // Check if matchedType is an ADT or a generic type
      if (
        !(matchedType instanceof AdtType) &&
        !(matchedType instanceof GenericType)
      ) {
        this.reportError(
          `Cannot match a value of type '${matchedType}' against ADT pattern '${adtName}'`,
          ctx
        );
        return;
      }

      // Get the base type name for constructor lookup
      let baseTypeName: string;
      if (matchedType instanceof AdtType) {
        baseTypeName = matchedType.name;
      } else if (matchedType instanceof GenericType) {
        baseTypeName = matchedType.name;
      } else {
        this.reportError(
          `Cannot match a value of type '${matchedType}' against ADT pattern '${adtName}'`,
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
          `Constructor ${adtName} does not exist on type ${baseTypeName}`,
          ctx
        );
        return;
      }

      const constructorType = constructor.type;

      if (!(constructorType instanceof FunctionType)) {
        // Should still be a function type even with wildcard param
        this.reportError(
          `Constructor ${adtName} does not take a parameter on type ${baseTypeName}`,
          ctx
        );
        return;
      }

      if (constructorType.paramTypes.length !== 1) {
        // Expecting exactly one parameter for wildcard case
        this.reportError(
          `Constructor ${adtName} should take exactly one parameter for wildcard pattern on type ${baseTypeName}`,
          ctx
        );
        return;
      }
      // No need to declare a parameter in environment, it's a wildcard.
    } else if (
      ctx.ruleContext instanceof parser.AdtWithLiteralMatchPatternContext
    ) {
      const adtName = (ctx as parser.AdtWithLiteralMatchPatternContext)
        .IDENTIFIER()
        .getText();
      addCase(`${adtName}(Literal)`); // More generic addCase for literals
      console.log(`[visitPattern] Adding case of literal ADT: ${adtName}`);

      // Check if matchedType is an ADT or a generic type
      if (
        !(matchedType instanceof AdtType) &&
        !(matchedType instanceof GenericType)
      ) {
        this.reportError(
          `Cannot match a value of type '${matchedType}' against ADT pattern '${adtName}'`,
          ctx
        );
        return;
      }

      // Get the base type name for constructor lookup
      let baseTypeName: string;
      if (matchedType instanceof AdtType) {
        baseTypeName = matchedType.name;
      } else if (matchedType instanceof GenericType) {
        baseTypeName = matchedType.name;
      } else {
        // This shouldn't happen due to the checks above
        this.reportError(
          `Cannot match a value of type '${matchedType}' against ADT pattern '${adtName}'`,
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
          `Constructor ${adtName} does not exist on type ${baseTypeName}`,
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

      // *** USE UNIFICATION HERE ***
      const unificationResult = this.unify(
        constructorType.paramTypes[0],
        literalType,
        new Map()
      );
      if (unificationResult instanceof Error) {
        this.reportError(
          `Incorrect literal type: ${unificationResult.message}`,
          ctx
        ); // Report unification error
      }
    } else if (ctx.ruleContext instanceof parser.WildcardMatchPatternContext) {
      // Always matches
      addCase("*"); // Wildcard case
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

      if (literalType instanceof StringTypeClass) {
        addCase(literalType.toString());
      }
    }
  }

  visitJsxExpr(ctx: parser.JsxExprContext): ChicoryType {
    // For now we will treat all JSX as untyped
    return UnknownType;
  }

  private instantiateGenericType(
    genericType: GenericType,
    typeArgs: ChicoryType[] = []
  ): ChicoryType {
    console.log(
      `[instantiateGenericType] Instantiating generic type: ${
        genericType.name
      }, typeArgs: ${typeArgs.map((t) => t.toString())}`
    ); // [DEBUG]

    // Create fresh type variables for each type parameter
    const freshTypeVars = genericType.typeArguments.map((typeVar) => {
      if (typeVar instanceof TypeVariable) {
        return this.newTypeVar();
      }
      return typeVar;
    });

    // Create a substitution map from original type variables to fresh ones
    const renameSubstitution = new Map<string, ChicoryType>();
    for (let i = 0; i < genericType.typeArguments.length; i++) {
      const origVar = genericType.typeArguments[i];
      if (origVar instanceof TypeVariable) {
        renameSubstitution.set(origVar.name, freshTypeVars[i]);
      }
    }

    // Apply the renaming substitution to all constructors
    const originalConstructors = this.constructors.filter(
      (c) => c.adtName === genericType.name
    );
    const freshConstructors: ConstructorDefinition[] = [];

    console.log(
      `[instantiateGenericType] Original constructors for ${
        genericType.name
      }: ${originalConstructors.map((c) => c.name).join(", ")}`
    ); // [DEBUG]

    for (const constructor of originalConstructors) {
      // Iterate over ORIGINAL constructors
      let freshType = this.applySubstitution(
        constructor.type,
        renameSubstitution
      );

      // If type arguments were provided, apply them
      if (typeArgs.length > 0) {
        const argSubstitution = new Map<string, ChicoryType>();
        for (let i = 0; i < freshTypeVars.length && i < typeArgs.length; i++) {
          if (freshTypeVars[i] instanceof TypeVariable) {
            argSubstitution.set(
              (freshTypeVars[i] as TypeVariable).name,
              typeArgs[i]
            );
          }
        }
        freshType = this.applySubstitution(freshType, argSubstitution);
      }

      const freshConstructorDef: ConstructorDefinition = {
        // [DEBUG] Created fresh constructor
        adtName: constructor.adtName,
        name: constructor.name,
        type: freshType,
      };
      freshConstructors.push(freshConstructorDef);
      console.log(
        `[instantiateGenericType] Created fresh constructor: ${freshConstructorDef.name}, type: ${freshConstructorDef.type}`
      ); // [DEBUG]
    }

    // *** REPLACE existing constructors instead of PUSHING ***
    console.log(
      `[instantiateGenericType] Replacing constructors for ${
        genericType.name
      } in this.constructors with fresh constructors: ${freshConstructors
        .map((c) => c.name)
        .join(", ")}`
    ); // [DEBUG]

    // 1. Filter out the *old* constructors for this generic type
    this.constructors = this.constructors.filter(
      (c) => c.adtName !== genericType.name
    );
    // 2. Add the *new* fresh constructors
    this.constructors.push(...freshConstructors);

    // Return the instantiated type
    if (typeArgs.length > 0) {
      return new GenericType(genericType.name, typeArgs);
    } else {
      return new GenericType(genericType.name, freshTypeVars);
    }
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

// ChicoryTypeCheckerVisitor.ts
import { ParserRuleContext, Token, TerminalNode } from 'antlr4ng';
import * as parser from './generated/ChicoryParser';
import { CompilationError, LspRange } from './env';

type Type =
    | { kind: 'external', module: string }
    | { kind: 'primitive', name: 'number' | 'string' | 'boolean' | 'jsx' | 'unit' }
    | { kind: 'function', params: Type[], return: Type }
    | { kind: 'tuple', elements: Type[] }
    | { kind: 'record', fields: Map<string, Type> }
    | { kind: 'adt', name: string }
    | { kind: 'generic', base: Type, typeArgs: Type[] }
    | { kind: 'typeParam', name: string }
    | { kind: 'variable', id: number };

type SymbolInfo = {
    name: string;               // The name of the symbol (e.g., variable name, type name, constructor name)
    type: Type;                // The inferred type of the symbol
    context: ParserRuleContext;  // The context in which the symbol was defined (to lookup location)
    kind: 'variable' | 'type' | 'constructor' | 'parameter' | 'import'; // The kind of symbol
};

type ConstructorDef = {
    adtName: string;
    name: string;
    type: Type;
    context: ParserRuleContext;
};

type TypeDef =
    | { kind: 'primitive', name: 'number' | 'string' | 'boolean' | 'unit' | 'typeParam', typeParam?: string }
    | { kind: 'function', params: Type[], return: Type }
    | { kind: 'tuple', elements: Type[] }
    | { kind: 'record', fields: Map<string, Type> }
    | { kind: 'adt', constructors: ConstructorDef[] }
    | { kind: 'generic', base: Type, typeArgs: Type[] };

type EnvEntry = { type: Type; context: ParserRuleContext };

export class ChicoryTypeChecker {
    private typeDefs: Map<string, { def: TypeDef; context: ParserRuleContext }> = new Map();
    private constructorMap: Map<string, ConstructorDef> = new Map();
    private currentEnv: Map<string, EnvEntry>[] = [new Map()];
    private substitution: Map<number, Type> = new Map();
    private errors: CompilationError[] = [];
    private symbols: SymbolInfo[] = [];
    private freshVarCounter = 0;
    
    // Public method to get all ADT constructors
    getConstructors(): ConstructorDef[] {
        return Array.from(this.constructorMap.values());
    }

    private freshVar(): Type {
        return { kind: 'variable', id: this.freshVarCounter++ };
    }

    private resolve(type: Type): Type {
        while (type.kind === 'variable') {
            const sub = this.substitution.get(type.id);
            if (!sub) break;
            type = sub;
        }
        return type;
    }

    private unify(t1: Type, t2: Type, ctx: ParserRuleContext): void {
        t1 = this.resolve(t1);
        t2 = this.resolve(t2);

        if (t1.kind === 'variable' && t2.kind === 'variable' && t1.id === t2.id) return;
        if (t1.kind === 'variable') {
            this.substitution.set(t1.id, t2);
            return;
        }
        if (t2.kind === 'variable') {
            this.substitution.set(t2.id, t1);
            return;
        }

        if (t1.kind === 'primitive' && t2.kind === 'primitive' && t1.name === t2.name) return;

        if (t1.kind === 'function' && t2.kind === 'function') {
            if (t1.params.length !== t2.params.length) {
                this.errors.push({ message: `Function parameter count mismatch`, context: ctx });
                return;
            }
            t1.params.forEach((p, i) => this.unify(p, t2.params[i], ctx));
            this.unify(t1.return, t2.return, ctx);
            return;
        }

        if (t1.kind === 'generic' && t2.kind === 'generic') {
            this.unify(t1.base, t2.base, ctx);
            if (t1.typeArgs.length !== t2.typeArgs.length) {
                this.errors.push({ message: `Generic type argument count mismatch`, context: ctx });
                return;
            }
            t1.typeArgs.forEach((arg, i) => this.unify(arg, t2.typeArgs[i], ctx));
            return;
        }

        if (t1.kind === 'tuple' && t2.kind === 'tuple') {
            if (t1.elements.length !== t2.elements.length) {
                this.errors.push({ message: `Tuple length mismatch`, context: ctx });
                return;
            }
            t1.elements.forEach((e, i) => this.unify(e, t2.elements[i], ctx));
            return;
        }

        if (t1.kind === 'record' && t2.kind === 'record') {
            const allKeys = new Set([...t1.fields.keys(), ...t2.fields.keys()]);
            for (const key of allKeys) {
                const t1Field = t1.fields.get(key);
                const t2Field = t2.fields.get(key);
                if (!t1Field || !t2Field) {
                    this.errors.push({ message: `Record field '${key}' mismatch`, context: ctx });
                    continue;
                }
                this.unify(t1Field, t2Field, ctx);
            }
            return;
        }

        if (t1.kind === 'adt' && t2.kind === 'adt' && t1.name === t2.name) return;

        this.errors.push({
            message: `Type mismatch between ${this.typeToString(t1)} and ${this.typeToString(t2)}`,
            context: ctx
        });
    }

    private typeToString(type: Type): string {
        type = this.resolve(type);
        switch (type.kind) {
            case 'primitive': return type.name;
            case 'variable': return `T${type.id}`;
            case 'function': return `(${type.params.map(t => this.typeToString(t)).join(', ')}) => ${this.typeToString(type.return)}`;
            case 'tuple': return `[${type.elements.map(t => this.typeToString(t)).join(', ')}]`;
            case 'record': {
                const fields = Array.from(type.fields.entries()).map(([k, v]) => `${k}: ${this.typeToString(v)}`);
                return `{ ${fields.join(', ')} }`;
            }
            case 'adt': return type.name;
            default: return 'unknown';
        }
    }

    check(ctx: parser.ProgramContext): { errors: CompilationError[]; symbols: SymbolInfo[] } {
        this.errors = [];
        this.symbols = [];
        this.visitProgram(ctx);
        return { errors: this.errors, symbols: this.symbols };
    }

    private visitProgram(ctx: parser.ProgramContext): void {
        ctx.stmt().forEach(stmt => this.visitStmt(stmt));
    }

    private visitStmt(ctx: parser.StmtContext): void {
        if (ctx.assignStmt()) {
            this.visitAssignStmt(ctx.assignStmt()!);
        } else if (ctx.typeDefinition()) {
            this.visitTypeDefinition(ctx.typeDefinition()!);
        } else if (ctx.importStmt()) { // ADD THIS CHECK
            this.visitImportStmt(ctx.importStmt()!);
        } else if (ctx.expr()) {
            this.visitExpr(ctx.expr()!);
        }
        else {              
            throw new Error('Unknown statement type');
        }
    }

    private visitImportStmt(ctx: parser.ImportStmtContext): void {
        // Handle default import (if present)
        if (ctx.IDENTIFIER()) {
            const defaultImport = ctx.IDENTIFIER()!.getText();
            this.declareSymbol(defaultImport, {
                kind: 'external',
                module: ctx.STRING().getText()
            }, ctx);
        }
    
        // Handle destructuring imports
        const destructuring = ctx.destructuringImportIdentifier();
        if (destructuring) {
            destructuring.IDENTIFIER().forEach(id => {
                this.declareSymbol(id.getText(), {
                    kind: 'external',
                    module: ctx.STRING().getText()
                }, ctx);
            });
        }
    }

    private declareSymbol(
        name: string, 
        type: Type,
        context: ParserRuleContext
    ): void {
        // Check for existing declaration in current scope
        if (this.currentEnv[this.currentEnv.length - 1].has(name)) {
            this.errors.push({
                message: `Duplicate identifier '${name}'`,
                context: context
            });
            return;
        }
    
        // Add to environment and symbol table
        this.currentEnv[this.currentEnv.length - 1].set(name, { type, context });
        this.symbols.push({
            name,
            type,
            context,
            kind: 'import'
        });
    }

    private visitAssignStmt(ctx: parser.AssignStmtContext): void {
        const varName = ctx.IDENTIFIER().getText();
        const exprType = this.visitExpr(ctx.expr());
        this.currentEnv[this.currentEnv.length - 1].set(varName, { type: exprType, context: ctx });
        this.symbols.push({
            name: varName,
            type: exprType,
            context: ctx,
            kind: 'variable'
        });
    }

    private visitTypeDefinition(ctx: parser.TypeDefinitionContext): void {
        const typeName = ctx.IDENTIFIER().getText();
        
        // Handle type parameters if present
        const typeParams: string[] = [];
        if (ctx.typeParams()) {
            ctx.typeParams()!.IDENTIFIER().forEach(id => {
                typeParams.push(id.getText());
            });
        }
        
        // Visit the type expression with type parameters
        const typeExpr = this.visitTypeExpr(ctx.typeExpr(), typeName, typeParams);
        
        this.typeDefs.set(typeName, { def: typeExpr, context: ctx });
        this.symbols.push({
            name: typeName,
            type: this.typeDefToType(typeExpr, typeName),
            context: ctx,
            kind: 'type'
        });
        
        if (typeExpr.kind === 'adt') {
            typeExpr.constructors.forEach(constructor => {
                this.constructorMap.set(constructor.name, constructor);
                this.symbols.push({
                    name: constructor.name,
                    type: constructor.type,
                    context: constructor.context,
                    kind: 'constructor'
                });
                
                // Register constructor in the current scope
                this.currentEnv[this.currentEnv.length - 1].set(constructor.name, { 
                    type: constructor.type, 
                    context: constructor.context 
                });
            });
        }
    }

    private typeDefToType(typeDef: TypeDef, typeName: string): Type {
        switch (typeDef.kind) {
            case 'primitive': 
                if (typeDef.name === 'typeParam' && typeDef.typeParam) {
                    return { kind: 'typeParam', name: typeDef.typeParam };
                }
                return { kind: 'primitive', name: typeDef.name };
            case 'record': return { kind: 'record', fields: typeDef.fields };
            case 'tuple': return { kind: 'tuple', elements: typeDef.elements };
            case 'function': return { kind: 'function', params: typeDef.params, return: typeDef.return };
            case 'adt': return { kind: 'adt', name: typeName };
            case 'generic': return { kind: 'generic', base: typeDef.base, typeArgs: typeDef.typeArgs };
        }
    }

    private visitTypeExpr(ctx: parser.TypeExprContext, typeName?: string, typeParams: string[] = []): TypeDef {
        // Create a scope for type parameters if they exist
        const typeParamScope = new Map<string, Type>();
        typeParams.forEach(param => {
            typeParamScope.set(param, { kind: 'typeParam', name: param });
        });
        
        if (ctx.adtType()) {
            if (!typeName) {
                this.errors.push({ message: 'ADT type must be part of a type definition', context: ctx });
                return { kind: 'primitive', name: 'number' };
            }
            return this.visitAdtType(ctx.adtType()!, typeName, typeParamScope);
        }
        if (ctx.recordType()) return this.visitRecordType(ctx.recordType()!, typeParamScope);
        if (ctx.tupleType()) return this.visitTupleType(ctx.tupleType()!, typeParamScope);
        if (ctx.primitiveType()) return this.visitPrimitiveType(ctx.primitiveType()!);
        if (ctx.functionType()) return this.visitFunctionType(ctx.functionType()!, typeParamScope);
        if (ctx.genericTypeExpr()) return this.visitGenericTypeExpr(ctx.genericTypeExpr()!, typeParamScope);
        
        // Check if this is a direct reference to a type parameter
        const text = ctx.getText();
        if (text && typeParamScope.has(text)) {
            return { 
                kind: 'primitive', 
                name: 'typeParam',
                typeParam: text
            } as any; // Adding a custom property to handle type params
        }
        
        // If it's a single identifier, try to look it up as a type
        if (ctx.getChildCount() === 1 && ctx.getChild(0) instanceof TerminalNode) {
            const typeName = ctx.getText();
            const typeDefEntry = this.typeDefs.get(typeName);
            if (typeDefEntry) {
                return typeDefEntry.def;
            }
        }
        
        this.errors.push({ message: `Invalid type expression: ${ctx.getText()}`, context: ctx });
        return { kind: 'primitive', name: 'number' };
    }

    private visitFunctionType(ctx: parser.FunctionTypeContext, typeParamScope: Map<string, Type> = new Map()): TypeDef {
        const paramTypes: Type[] = [];
        
        // Process parameters if they exist
        if (ctx.typeParam()) {
            ctx.typeParam().forEach(param => {
                if (param instanceof parser.NamedTypeParamContext) {
                    // Named parameter (with type annotation)
                    const paramType = this.typeDefToType(this.visitTypeExpr(param.typeExpr(), undefined, Array.from(typeParamScope.keys())), '');
                    paramTypes.push(paramType);
                } else if (param instanceof parser.UnnamedTypeParamContext) {
                    // Unnamed parameter (just a type)
                    const typeExpr = param.typeExpr();
                    const typeText = typeExpr.getText();
                    
                    // Check if it's a type parameter identifier
                    if (typeText && typeParamScope.has(typeText)) {
                        paramTypes.push(typeParamScope.get(typeText)!);
                    } else {
                        const paramType = this.typeDefToType(this.visitTypeExpr(typeExpr, undefined, Array.from(typeParamScope.keys())), '');
                        paramTypes.push(paramType);
                    }
                }
            });
        }
        
        // Process return type
        const returnTypeExpr = ctx.typeExpr();
        const returnTypeText = returnTypeExpr.getText();
        
        let returnType: Type;
        if (returnTypeText && typeParamScope.has(returnTypeText)) {
            // If the return type is a direct reference to a type parameter
            returnType = typeParamScope.get(returnTypeText)!;
        } else {
            returnType = this.typeDefToType(this.visitTypeExpr(returnTypeExpr, undefined, Array.from(typeParamScope.keys())), '');
        }
        
        return { 
            kind: 'function', 
            params: paramTypes, 
            return: returnType 
        };
    }

    private visitGenericTypeExpr(ctx: parser.GenericTypeExprContext, typeParamScope: Map<string, Type> = new Map()): TypeDef {
        let baseType: Type;
        
        // Get the base type (identifier)
        const typeName = ctx.IDENTIFIER().getText();
        
        // Check if it's a type parameter
        if (typeParamScope.has(typeName)) {
            baseType = typeParamScope.get(typeName)!;
        } else {
            baseType = this.lookupType(typeName, ctx);
        }
        
        // Process type arguments
        const typeArgs: Type[] = [];
        for (const typeExpr of ctx.typeExpr()) {
            const typeText = typeExpr.getText();
            
            // Check if the type argument is a direct reference to a type parameter
            if (typeText && typeParamScope.has(typeText)) {
                typeArgs.push(typeParamScope.get(typeText)!);
            } else {
                const typeArg = this.typeDefToType(
                    this.visitTypeExpr(typeExpr, undefined, Array.from(typeParamScope.keys())), 
                    ''
                );
                typeArgs.push(typeArg);
            }
        }
        
        return {
            kind: 'generic',
            base: baseType,
            typeArgs: typeArgs
        };
    }

    private visitAdtType(ctx: parser.AdtTypeContext, typeName: string, typeParamScope: Map<string, Type> = new Map()): TypeDef {
        const constructors: ConstructorDef[] = [];
        const adtType: Type = { kind: 'adt', name: typeName };
    
        ctx.adtOption().forEach(option => {
            let constructorName: string;
            let constructorContext: Token;
            let paramTypes: Type[] = [];
    
            // Handle different ADT option variants
            if (option instanceof parser.AdtOptionAnonymousRecordContext) {
                // Structure: IDENTIFIER( { ... } )
                constructorName = option.IDENTIFIER().getText();
                constructorContext = option.IDENTIFIER().symbol;
                
                // Process anonymous record fields
                const fields = new Map<string, Type>();
                option.adtTypeAnnotation().forEach(ann => {
                    const fieldName = ann.IDENTIFIER()[0].getText();
                    let fieldType: Type;
                    if (ann.primitiveType()) {
                        fieldType = this.visitPrimitiveType(ann.primitiveType()!) as Type;
                    } else {
                        const typeName = ann.IDENTIFIER()[1].getText();
                        // Check if it's a type parameter
                        if (typeParamScope.has(typeName)) {
                            fieldType = typeParamScope.get(typeName)!;
                        } else {
                            fieldType = this.lookupType(typeName, ann);
                        }
                    }
                    fields.set(fieldName, fieldType);
                });
                paramTypes.push({ kind: 'record', fields });
            }
            else if (option instanceof parser.AdtOptionNamedTypeContext) {
                // Structure: IDENTIFIER( IDENTIFIER )
                constructorName = option.IDENTIFIER()[0].getText();
                constructorContext = option.IDENTIFIER()[0].symbol;
                const paramTypeName = option.IDENTIFIER()[1].getText();
                
                // Check if it's a type parameter
                if (typeParamScope.has(paramTypeName)) {
                    paramTypes.push(typeParamScope.get(paramTypeName)!);
                } else {
                    paramTypes.push(this.lookupType(paramTypeName, option));
                }
            }
            else if (option instanceof parser.AdtOptionPrimitiveTypeContext) {
                // Structure: IDENTIFIER( primitiveType )
                constructorName = option.IDENTIFIER().getText();
                constructorContext = option.IDENTIFIER().symbol;
                paramTypes.push(this.visitPrimitiveType(option.primitiveType()!) as Type);
            }
            else if (option instanceof parser.AdtOptionNoArgContext) {
                // Structure: IDENTIFIER (no params)
                constructorName = option.IDENTIFIER().getText();
                constructorContext = option.IDENTIFIER().symbol;
            }
            else {
                this.errors.push({ message: 'Unknown ADT variant', context: option });
                return;
            }
    
            constructors.push({
                adtName: typeName,
                name: constructorName,
                type: { 
                    kind: 'function', 
                    params: paramTypes,
                    return: adtType 
                },
                // TODO: give the more narrowly constrained context...
                context: ctx
            });
        });
    
        return { kind: 'adt', constructors };
    }

    private visitAdtOption(ctx: parser.AdtOptionContext): Type {
        if (ctx instanceof parser.AdtOptionAnonymousRecordContext) {
            const fields = new Map<string, Type>();
            ctx.adtTypeAnnotation().forEach(ann => {
                const name = ann.IDENTIFIER()[0].getText();
                const type = ann.primitiveType() ? this.visitPrimitiveType(ann.primitiveType()!) as Type : this.lookupType(ann.IDENTIFIER()[1].getText(), ann);
                fields.set(name, type);
            });
            return { kind: 'record', fields };
        } else if (ctx instanceof parser.AdtOptionNamedTypeContext) {
            const typeName = ctx.IDENTIFIER()[1].getText();
            return this.lookupType(typeName, ctx);
        } else if (ctx instanceof parser.AdtOptionPrimitiveTypeContext) {
            return this.visitPrimitiveType(ctx.primitiveType()!) as Type;
        } else {
            return this.freshVar();
        }
    }

    private visitRecordType(ctx: parser.RecordTypeContext, typeParamScope: Map<string, Type> = new Map()): TypeDef {
        const fields = new Map<string, Type>();
        ctx.recordTypeAnontation().forEach(ann => {
            const name = ann.IDENTIFIER()[0].getText();
            let type: Type;
            if (ann.primitiveType()) {
                type = this.visitPrimitiveType(ann.primitiveType()!) as Type;
            } else if (ann.recordType()) {
                type = this.visitRecordType(ann.recordType()!, typeParamScope) as Type;
            } else {
                const typeName = ann.IDENTIFIER()[1].getText();
                // Check if it's a type parameter
                if (typeParamScope.has(typeName)) {
                    type = typeParamScope.get(typeName)!;
                } else {
                    type = this.lookupType(typeName, ann);
                }
            }
            fields.set(name, type);
        });
        return { kind: 'record', fields };
    }

    private visitTupleType(ctx: parser.TupleTypeContext, typeParamScope: Map<string, Type> = new Map()): TypeDef {
        const elements = ctx.tupleField().map(field => this.visitTupleField(field, typeParamScope));
        return { kind: 'tuple', elements };
    }

    private visitTupleField(ctx: parser.TupleFieldContext, typeParamScope: Map<string, Type> = new Map()): Type {
        if (ctx.primitiveType()) return this.visitPrimitiveType(ctx.primitiveType()!) as Type;
        if (ctx.IDENTIFIER()) {
            const typeName = ctx.IDENTIFIER()!.getText();
            // Check if it's a type parameter
            if (typeParamScope.has(typeName)) {
                return typeParamScope.get(typeName)!;
            }
            return this.lookupType(typeName, ctx);
        }
        this.errors.push({ message: 'Invalid tuple field', context: ctx });
        return this.freshVar();
    }

    private visitPrimitiveType(ctx: parser.PrimitiveTypeContext): TypeDef {
        const name = ctx.getText() as 'number' | 'string' | 'boolean' | 'unit';
        return { kind: 'primitive', name };
    }

    private lookupType(typeName: string, context: ParserRuleContext): Type {
        const typeDefEntry = this.typeDefs.get(typeName);
        if (!typeDefEntry) {
            this.errors.push({ message: `Undefined type ${typeName}`, context });
            return this.freshVar();
        }
        const typeDef = typeDefEntry.def;
        switch (typeDef.kind) {
            case 'primitive': return { kind: 'primitive', name: typeDef.name };
            case 'record': return { kind: 'record', fields: typeDef.fields };
            case 'tuple': return { kind: 'tuple', elements: typeDef.elements };
            case 'adt': return { kind: 'adt', name: typeName };
            case 'function': return { kind: 'function', params: typeDef.params, return: typeDef.return };
            case 'generic': return { kind: 'generic', base: typeDef.base, typeArgs: typeDef.typeArgs };
            default: return this.freshVar();
        }
    }

    private visitExpr(ctx: parser.ExprContext): Type {
        let currentType = this.visitPrimaryExpr(ctx.primaryExpr());
        ctx.tailExpr().forEach(tail => {
            currentType = this.visitTailExpr(tail, currentType);
        });
        return currentType;
    }

    private visitPrimaryExpr(ctx: parser.PrimaryExprContext): Type {
        if (ctx instanceof parser.IfExpressionContext) return this.visitIfExpr(ctx.ifExpr());
        if (ctx instanceof parser.FunctionExpressionContext) return this.visitFuncExpr(ctx.funcExpr());
        if (ctx instanceof parser.MatchExpressionContext) return this.visitMatchExpr(ctx.matchExpr());
        if (ctx instanceof parser.BlockExpressionContext) return this.visitBlockExpr(ctx.blockExpr());
        if (ctx instanceof parser.RecordExpressionContext) return this.visitRecordExpr(ctx.recordExpr());
        if (ctx instanceof parser.ArrayLikeExpressionContext) return this.visitArrayLikeExpr(ctx.arrayLikeExpr());
        if (ctx instanceof parser.IdentifierExpressionContext) return this.visitIdentifier(ctx);
        if (ctx instanceof parser.LiteralExpressionContext) return this.visitLiteral(ctx.literal());
        if (ctx instanceof parser.ParenExpressionContext) return this.visitExpr(ctx.expr());
        if (ctx instanceof parser.JsxExpressionContext) return this.visitJsxExpr(ctx.jsxExpr());
        this.errors.push({ message: 'Unknown primary expression', context: ctx });
        return this.freshVar();
    }

    private visitTailExpr(ctx: parser.TailExprContext, currentType: Type): Type {
        if (ctx instanceof parser.MemberExpressionContext) {
            const memberName = ctx.IDENTIFIER().getText();
            const resolved = this.resolve(currentType);
            if (resolved.kind !== 'record') {
                this.errors.push({ message: `Cannot access member ${memberName} of non-record`, context: ctx });
                return this.freshVar();
            }
            const fieldType = resolved.fields.get(memberName);
            if (!fieldType) {
                this.errors.push({ message: `Record has no member ${memberName}`, context: ctx });
                return this.freshVar();
            }
            return fieldType;
        } else if (ctx instanceof parser.IndexExpressionContext) {
            const indexType = this.visitExpr(ctx.expr());
            this.unify(indexType, { kind: 'primitive', name: 'number' }, ctx);
            const resolved = this.resolve(currentType);
            if (resolved.kind !== 'tuple') {
                this.errors.push({ message: 'Cannot index non-tuple type', context: ctx });
                return this.freshVar();
            }
            return this.freshVar(); // Tuple index type cannot be inferred without literal index
        } else if (ctx instanceof parser.CallExpressionContext) {
            const args = ctx.callExpr().expr().map(arg => this.visitExpr(arg));
            const returnType = this.freshVar();
            this.unify(currentType, { kind: 'function', params: args, return: returnType }, ctx);
            return returnType;
        } else if (ctx instanceof parser.OperationExpressionContext) {
            const rightType = this.visitExpr(ctx.expr());
            return this.visitOperator(ctx.OPERATOR().getText(), currentType, rightType, ctx);
        } else {
            this.errors.push({ message: 'Unknown tail expression', context: ctx });
            return this.freshVar();
        }
    }

    private visitOperator(op: string, left: Type, right: Type, ctx: ParserRuleContext): Type {
        switch (op) {
            case '+':
                // Handle string concatenation or number addition
                const resolvedLeft = this.resolve(left);
                const resolvedRight = this.resolve(right);
                
                if (resolvedLeft.kind === 'primitive' && resolvedLeft.name === 'string') {
                    // If left is string, right must be string too
                    this.unify(right, { kind: 'primitive', name: 'string' }, ctx);
                    return { kind: 'primitive', name: 'string' };
                } else if (resolvedRight.kind === 'primitive' && resolvedRight.name === 'string') {
                    // If right is string, left must be string too
                    this.unify(left, { kind: 'primitive', name: 'string' }, ctx);
                    return { kind: 'primitive', name: 'string' };
                } else {
                    // Default to number addition
                    this.unify(left, { kind: 'primitive', name: 'number' }, ctx);
                    this.unify(right, { kind: 'primitive', name: 'number' }, ctx);
                    return { kind: 'primitive', name: 'number' };
                }
            case '-': case '*': case '/':
                this.unify(left, { kind: 'primitive', name: 'number' }, ctx);
                this.unify(right, { kind: 'primitive', name: 'number' }, ctx);
                return { kind: 'primitive', name: 'number' };
            case '==': case '!=':
                this.unify(left, right, ctx);
                return { kind: 'primitive', name: 'boolean' };
            case '&&': case '||':
                this.unify(left, { kind: 'primitive', name: 'boolean' }, ctx);
                this.unify(right, { kind: 'primitive', name: 'boolean' }, ctx);
                return { kind: 'primitive', name: 'boolean' };
            default:
                this.errors.push({ message: `Unsupported operator ${op}`, context: ctx });
                return this.freshVar();
        }
    }

    private visitIfExpr(ctx: parser.IfExprContext): Type {
        const resultType = this.freshVar();
        ctx.justIfExpr().forEach(justIfExpr => {
            const condType = this.visitExpr(justIfExpr.expr()[0]);
            this.unify(condType, { kind: 'primitive', name: 'boolean' }, justIfExpr);
            const thenType = this.visitExpr(justIfExpr.expr()[1]);
            this.unify(thenType, resultType, justIfExpr);
        });
        if (ctx.expr()) {
            const elseType = this.visitExpr(ctx.expr()!);
            this.unify(elseType, resultType, ctx);
        }
        return resultType;
    }

    private visitFuncExpr(ctx: parser.FuncExprContext): Type {
        this.enterScope();
        const params = ctx.parameterList()?.IDENTIFIER().map(id => ({
            name: id.getText(),
            context: id
        })) || [];
        const paramTypes = params.map(() => this.freshVar());
        params.forEach((param, i) => {
            // TODO: more narrowly constrain ctx to identifier (but it's a terminal node, so it doesn't have a ctx)
            this.currentEnv[this.currentEnv.length - 1].set(param.name, { type: paramTypes[i], context: ctx });
            this.symbols.push({
                name: param.name,
                type: paramTypes[i],
                context: ctx,
                kind: 'parameter'
            });
        });
        const bodyType = this.visitExpr(ctx.expr());
        this.exitScope();
        return { kind: 'function', params: paramTypes, return: bodyType };
    }

    private visitMatchExpr(ctx: parser.MatchExprContext): Type {
        const matchedType = this.visitExpr(ctx.expr());
        const resolvedType = this.resolve(matchedType);

        if (resolvedType.kind !== 'adt') {
            this.errors.push({ message: 'Match expression must be applied to an ADT type', context: ctx.expr() });
            return this.freshVar();
        }

        const adtDef = this.typeDefs.get(resolvedType.name)?.def;
        if (!adtDef || adtDef.kind !== 'adt') {
            this.errors.push({ message: `ADT ${resolvedType.name} is not defined`, context: ctx.expr() });
            return this.freshVar();
        }

        const resultType = this.freshVar();
        ctx.matchArm().forEach(arm => {
            const patternCtx = arm.matchPattern();
            this.enterScope();
            this.visitMatchPattern(patternCtx, resolvedType.name, adtDef);
            const armType = this.visitExpr(arm.expr());
            this.unify(armType, resultType, arm);
            this.exitScope();
        });

        return resultType;
    }

    private visitMatchPattern(ctx: parser.MatchPatternContext, adtName: string, adtDef: TypeDef): void {
        if (adtDef.kind !== 'adt') return;

        if (ctx instanceof parser.BareAdtMatchPatternContext) {
            const constructorName = ctx.IDENTIFIER().getText();
            const constructor = this.constructorMap.get(constructorName);
            if (!constructor || constructor.adtName !== adtName) {
                this.errors.push({ message: `Constructor ${constructorName} is not part of ADT ${adtName}`, context: ctx });
                return;
            }
            const constructorType = this.resolve(constructor.type);
            if (constructorType.kind === 'function' && constructorType.params.length !== 0) {
                this.errors.push({ message: `Constructor ${constructorName} expects parameters`, context: ctx });
            }
        } else if (ctx instanceof parser.AdtWithParamMatchPatternContext) {
            const constructorName = ctx.IDENTIFIER()[0].getText();
            const paramName = ctx.IDENTIFIER()[1].getText();
            const constructor = this.constructorMap.get(constructorName);
            if (!constructor || constructor.adtName !== adtName) {
                this.errors.push({ message: `Constructor ${constructorName} is not part of ADT ${adtName}`, context: ctx });
                return;
            }
            const constructorType = this.resolve(constructor.type);
            if (constructorType.kind !== 'function' || constructorType.params.length !== 1) {
                this.errors.push({ message: `Constructor ${constructorName} expects one parameter`, context: ctx });
                return;
            }
            const paramType = constructorType.params[0];
            this.currentEnv[this.currentEnv.length - 1].set(paramName, { type: paramType, context: ctx });
            this.symbols.push({
                name: paramName,
                type: paramType,
                context:ctx,
                // TODO: give the more narrowly constrained context...
                kind: 'variable'
            });
        } else if (ctx instanceof parser.AdtWithLiteralMatchPatternContext) {
            const constructorName = ctx.IDENTIFIER().getText();
            const constructor = this.constructorMap.get(constructorName);
            if (!constructor || constructor.adtName !== adtName) {
                this.errors.push({ message: `Constructor ${constructorName} is not part of ADT ${adtName}`, context: ctx });
                return;
            }
            const constructorType = this.resolve(constructor.type);
            if (constructorType.kind !== 'function' || constructorType.params.length !== 1) {
                this.errors.push({ message: `Constructor ${constructorName} expects one parameter`, context: ctx });
                return;
            }
            const literalType = this.visitLiteral(ctx.literal());
            this.unify(literalType, constructorType.params[0], ctx);
        } else if (ctx instanceof parser.WildcardMatchPatternContext) {
            // No action needed
        } else if (ctx instanceof parser.LiteralMatchPatternContext) {
            const matchExpr = ctx.parent!.parent as parser.MatchExprContext;
            const literalType = this.visitLiteral(ctx.literal());
            const matchedType = this.resolve(
                this.visitExpr(matchExpr.expr())
            );
            this.unify(literalType, matchedType, ctx);
        } else {
            this.errors.push({ message: 'Unknown match pattern type', context: ctx });
        }
    }

    private visitBlockExpr(ctx: parser.BlockExprContext): Type {
        this.enterScope();
        ctx.stmt().forEach(stmt => this.visitStmt(stmt));
        const resultType = this.visitExpr(ctx.expr());
        this.exitScope();
        return resultType;
    }

    private visitRecordExpr(ctx: parser.RecordExprContext): Type {
        const fields = new Map<string, Type>();
        ctx.recordKvExpr().forEach(kv => {
            const name = kv.IDENTIFIER().getText();
            const type = this.visitExpr(kv.expr());
            fields.set(name, type);
        });
        return { kind: 'record', fields };
    }

    private visitArrayLikeExpr(ctx: parser.ArrayLikeExprContext): Type {
        const elements = ctx.expr().map(expr => this.visitExpr(expr));
        return { kind: 'tuple', elements };
    }

    private visitIdentifier(ctx: parser.IdentifierExpressionContext): Type {
        const name = ctx.getText();
        const entry = this.lookupVariable(name);
        if (!entry) {
            this.errors.push({ message: `Undefined variable: ${name}`, context: ctx });
            return this.freshVar();
        }
        return entry.type;
    }

    private lookupVariable(name: string): EnvEntry | undefined {
        for (let i = this.currentEnv.length - 1; i >= 0; i--) {
            const entry = this.currentEnv[i].get(name);
            if (entry) return entry;
        }
        const constructor = this.constructorMap.get(name);
        if (constructor) {
            return { type: constructor.type, context: constructor.context };
        }
        return undefined;
    }

    private visitLiteral(ctx: parser.LiteralContext): Type {
        if (ctx instanceof parser.StringLiteralContext) {
            return { kind: 'primitive', name: 'string' };
        } else if (ctx instanceof parser.NumberLiteralContext) {
            return { kind: 'primitive', name: 'number' };
        } else if (ctx instanceof parser.BooleanLiteralContext) {
            return { kind: 'primitive', name: 'boolean' };
        } else {
            this.errors.push({ message: `Unknown literal type: ${ctx.getText()}`, context: ctx });
            return this.freshVar();
        }
    }

    private visitJsxExpr(ctx: parser.JsxExprContext): Type {
        if (ctx.jsxSelfClosingElement()) {
            const componentName = ctx.jsxSelfClosingElement()!.IDENTIFIER().getText();
            const entry = this.lookupVariable(componentName);
            if (!entry) {
                this.errors.push({ message: `Undefined component ${componentName}`, context: ctx });
                return { kind: 'primitive', name: 'jsx' };
            }
            const propsType = this.visitJsxAttributes(ctx.jsxSelfClosingElement()!.jsxAttributes());
            this.unify(entry.type, { kind: 'function', params: [propsType], return: { kind: 'primitive', name: 'jsx' } }, ctx);
            return { kind: 'primitive', name: 'jsx' };
        } else if (ctx.jsxOpeningElement()) {
            const componentName = ctx.jsxOpeningElement()!.IDENTIFIER().getText();
            const entry = this.lookupVariable(componentName);
            if (!entry) {
                this.errors.push({ message: `Undefined component ${componentName}`, context: ctx });
                return { kind: 'primitive', name: 'jsx' };
            }
            const propsType = this.visitJsxAttributes(ctx.jsxOpeningElement()!.jsxAttributes());
            this.unify(entry.type, { kind: 'function', params: [propsType], return: { kind: 'primitive', name: 'jsx' } }, ctx);
            ctx.jsxChild().forEach(child => this.visitJsxChild(child));
            return { kind: 'primitive', name: 'jsx' };
        }
        throw new Error('Unknown JSX expression type');
    }

    private visitJsxAttributes(ctx: parser.JsxAttributesContext | null): Type {
        const fields = new Map<string, Type>();
        if (ctx) {
            ctx.jsxAttribute().forEach(attr => {
                const name = attr.IDENTIFIER().getText();
                const value = this.visitJsxAttributeValue(attr.jsxAttributeValue());
                fields.set(name, value);
            });
        }
        return { kind: 'record', fields };
    }

    private visitJsxAttributeValue(ctx: parser.JsxAttributeValueContext): Type {
        if (ctx.STRING()) {
            return { kind: 'primitive', name: 'string' };
        } else if (ctx.NUMBER()) {
            return { kind: 'primitive', name: 'number' };
        } else if (ctx.expr()){
            return this.visitExpr(ctx.expr()!);
        }
        throw new Error('Unknown JSX attribute value type');
    }

    private visitJsxChild(ctx: parser.JsxChildContext): void {
        if (ctx instanceof parser.JsxChildExpressionContext) {
            this.visitExpr(ctx.expr());
        } else if (ctx instanceof parser.JsxChildJsxContext) {
            this.visitJsxExpr(ctx.jsxExpr());
        }
    }

    private enterScope(): void {
        this.currentEnv.push(new Map());
    }

    private exitScope(): void {
        this.currentEnv.pop();
    }
}

import { ParserRuleContext } from 'antlr4ng';
import * as parser from './generated/ChicoryParser';
import { ChicoryTypeChecker } from './ChicoryTypeCheckerVisitor';
import { CompilationError } from './env';
import { FunctionType } from './ChicoryTypes';

export class ChicoryParserVisitor {
    private typeChecker: ChicoryTypeChecker;
    private indentLevel: number = 0;
    private scopeLevel: number = 0;
    private uniqueVarCounter: number = 0;
    private errors: CompilationError[] = [];
    private hints: { context: ParserRuleContext, type: string }[] = [];
    
    constructor(typeChecker?: ChicoryTypeChecker) {
        this.typeChecker = typeChecker || new ChicoryTypeChecker();
    }

    // Utility to generate consistent indentation
    private indent(): string {
        return "    ".repeat(this.indentLevel);
    }

    // Generate unique variable names per instance
    private getUniqueChicoryVariableName(): string {
        return `__chicory_var_${this.uniqueVarCounter++}`;
    }

    // Error reporting for LSP integration
    private reportError(message: string, context: ParserRuleContext): void {
        this.errors.push({ message, context });
    }

    // Scope management
    private enterScope(): void {
        this.scopeLevel++;
    }

    private exitScope(): void {
        this.scopeLevel--;
    }

    // Main entry point for compilation
    visitProgram(ctx: parser.ProgramContext): string {
        const lines: string[] = ctx.stmt().map(stmt => this.visitStmt(stmt));
        if (ctx.exportStmt()) {
            lines.push(this.visitExportStmt(ctx.exportStmt()!));
        }
        return lines.join("\n");
    }

    visitStmt(ctx: parser.StmtContext): string {
        if (ctx.assignStmt()) {
            return `${this.visitAssignStmt(ctx.assignStmt()!)};`;
        } else if (ctx.typeDefinition()) {
            // No semi-colon for type definitions
            return `${this.visitTypeDefinition(ctx.typeDefinition()!)}`;
        } else if (ctx.importStmt()) {
            return `${this.visitImportStmt(ctx.importStmt()!)};`;
        } else if (ctx.expr()) {
            return `${this.visitExpr(ctx.expr()!)};`;
        }
        this.reportError(`Unknown statement type: ${ctx.getText()}`, ctx);
        return ""; // Continue processing with a no-op
    }

    visitAssignStmt(ctx: parser.AssignStmtContext): string {
        const assignKwd = ctx.assignKwd().getText(); // 'let' or 'const'
        const identifier = ctx.identifierWrapper().getText();
        const expr = this.visitExpr(ctx.expr());
        return `${this.indent()}${assignKwd} ${identifier} = ${expr}`;
    }

    visitExportStmt(ctx: parser.ExportStmtContext): string {
        const identifiers = ctx.IDENTIFIER().map(id => id.getText()).join(", ");
        return `${this.indent()}export { ${identifiers} };`;
    }

    visitTypeDefinition(ctx: parser.TypeDefinitionContext): string {
        const typeName = ctx.IDENTIFIER().getText();
        const typeExpr = ctx.typeExpr();
        
        // Check if this is an ADT definition
        if (typeExpr.adtType()) {
            // Get constructors from the type checker
            const constructors = this.typeChecker.getConstructors().filter(c => 
                c.adtName === typeName
            );
            
            // Generate constructor functions for each ADT variant
            const constructorFunctions = constructors.map(constructor => {
                const constructorName = constructor.name;
                
                // Check if the constructor takes parameters
                const constructorType = constructor.type;
                if (constructorType instanceof FunctionType && constructorType.paramTypes.length > 0) {
                    return `${this.indent()}const ${constructorName} = (value) => { return { type: "${constructorName}", value }; };`;
                } else {
                    // For no-argument constructors, create the object directly
                    return `${this.indent()}const ${constructorName} = () => { return { type: "${constructorName}" }; };`;
                }
            }).join("\n");
            
            return constructorFunctions;
        }
        
        // For function types and generic types, we just erase them
        if (typeExpr.functionType() || typeExpr.genericTypeExpr()) {
            return `${this.indent()}/* Type Erasure: ${typeName} */`;
        }
        
        return `${this.indent()}/* Type Erasure: ${typeName} */`; // Placeholder for other types
    }

    visitImportStmt(ctx: parser.ImportStmtContext): string {
        // Handle regular imports
        if (ctx.getText().startsWith('import')) {
            const defaultImport = ctx.IDENTIFIER() ? ctx.IDENTIFIER()!.getText() : "";
            const destructuring = ctx.destructuringImportIdentifier()
                ? this.visitDestructuringImportIdentifier(ctx.destructuringImportIdentifier()!)
                : "";
            const body = [defaultImport, destructuring].filter(Boolean).join(", ");
            const from = ctx.STRING().getText();
            return `${this.indent()}import ${body} from ${from}`;
        }
        
        // Handle binding imports
        else if (ctx.getText().startsWith('bind')) {
            const defaultImport = ctx.IDENTIFIER() ? ctx.IDENTIFIER()!.getText() : "";
            const destructuring = ctx.bindingImportIdentifier()
                ? this.visitBindingImportIdentifier(ctx.bindingImportIdentifier()!)
                : "";
            const body = [defaultImport, destructuring].filter(Boolean).join(", ");
            const from = ctx.STRING().getText();
            return `${this.indent()}import ${body} from ${from}`;
        }
        
        throw new Error("Invalid import statement");
    }

    visitDestructuringImportIdentifier(ctx: parser.DestructuringImportIdentifierContext): string {
        const identifiers = ctx.IDENTIFIER();
        return identifiers.length > 0
            ? `{ ${identifiers.map(id => id.getText()).join(", ")} }`
            : "";
    }
    
    visitBindingImportIdentifier(ctx: parser.BindingImportIdentifierContext): string {
        const bindingIdentifiers = ctx.bindingIdentifier().map(binding => 
            binding.IDENTIFIER().getText()
        );
        
        return bindingIdentifiers.length > 0
            ? `{ ${bindingIdentifiers.join(", ")} }`
            : "";
    }

    visitExpr(ctx: parser.ExprContext): string {
        let primary = this.visitPrimaryExpr(ctx.primaryExpr());
        for (const tailExpr of ctx.tailExpr()) {
            primary += this.visitTailExpr(tailExpr);
        }
        return primary;
    }

    visitTailExpr(ctx: parser.TailExprContext): string {
        if (ctx.ruleContext instanceof parser.MemberExpressionContext) {
            return this.visitMemberExpr(ctx as parser.MemberExpressionContext);
        } else if (ctx.ruleContext instanceof parser.IndexExpressionContext) {
            return this.visitIndexExpr(ctx as parser.IndexExpressionContext);
        } else if (ctx.ruleContext instanceof parser.CallExpressionContext) {
            return this.visitCallExpr((ctx as parser.CallExpressionContext).callExpr());
        } else if (ctx.ruleContext instanceof parser.OperationExpressionContext) {
            return this.visitOperation(ctx as parser.OperationExpressionContext);
        }
        this.reportError(`Unknown tail expression type: ${ctx.getText()}`, ctx);
        return "";
    }

    visitMemberExpr(ctx: parser.MemberExpressionContext): string {
        return `.${ctx.IDENTIFIER().getText()}`;
    }

    visitIndexExpr(ctx: parser.IndexExpressionContext): string {
        return `[${this.visitExpr(ctx.expr())}]`;
    }

    visitOperation(ctx: parser.OperationExpressionContext): string {
        return ` ${ctx.OPERATOR().getText()} ${this.visitExpr(ctx.expr())}`;
    }

    visitPrimaryExpr(ctx: parser.PrimaryExprContext): string {
        const child = ctx.getChild(0);
        if (ctx instanceof parser.ParenExpressionContext) {
            return `(${this.visitExpr(ctx.expr())})`
        } else if (child instanceof parser.IfExprContext) {
            return this.visitIfElseExpr(child);
        } else if (child instanceof parser.FuncExprContext) {
            return this.visitFuncExpr(child);
        } else if (child instanceof parser.JsxExprContext) {
            return this.visitJsxExpr(child);
        } else if (child instanceof parser.MatchExprContext) {
            return this.visitMatchExpr(child);
        } else if (child instanceof parser.BlockExprContext) {
            return this.visitBlockExpr(child);
        } else if (child instanceof parser.RecordExprContext) {
            return this.visitRecordExpr(child);
        } else if (child instanceof parser.ArrayLikeExprContext) {
            return this.visitArrayLikeExpr(child);
        } else if (ctx.ruleContext instanceof parser.IdentifierExpressionContext) {
            return this.visitIdentifier(ctx);
        } else if (child instanceof parser.LiteralContext) {
            return this.visitLiteral(child);
        }
        this.reportError(`Unknown primary expression type: ${ctx.getText()}`, ctx);
        return "";
    }

    visitIfElseExpr(ctx: parser.IfExprContext): string {
        const ifs = ctx.justIfExpr().map(justIf => this.visitIfExpr(justIf));
        const getElseExpr = () => {
            const child = ctx.expr()!.getChild(0);
            return child instanceof parser.BlockExpressionContext
                ? this.visitBlockExpr(child.blockExpr())
                : `{ return ${this.visitExpr(ctx.expr()!)}; }`;
        };
        return ifs.join("") + (ctx.expr() ? `(() => ${getElseExpr()})()` : "undefined");
    }

    visitIfExpr(ctx: parser.JustIfExprContext): string {
        const condition = this.visitExpr(ctx.expr()[0]);
        const thenExpr = ctx.expr()[1].getChild(0);
        const block = thenExpr instanceof parser.BlockExpressionContext
            ? this.visitBlockExpr(thenExpr.blockExpr())
            : `{ return ${this.visitExpr(ctx.expr()[1])}; }`;
        return `(${condition}) ? (() => ${block})() : `;
    }

    visitFuncExpr(ctx: parser.FuncExprContext): string {
        this.enterScope();
        const params = ctx.parameterList() ? this.visitParameterList(ctx.parameterList()!) : "";
        const childExpr = ctx.expr().getChild(0);
        const body = childExpr instanceof parser.BlockExpressionContext
            ? this.visitBlockExpr(childExpr.blockExpr())
            : this.visitExpr(ctx.expr());
        this.exitScope();
        return `(${params}) => ${body}`;
    }

    visitParameterList(ctx: parser.ParameterListContext): string {
        return ctx.IDENTIFIER().map(id => id.getText()).join(", ");
    }

    visitCallExpr(ctx: parser.CallExprContext): string {
        const args = ctx.expr()
            ? ctx.expr().map(expr => this.visitExpr(expr)).join(", ")
            : "";
        return `(${args})`;
    }

    visitMatchExpr(ctx: parser.MatchExprContext): string {
        this.indentLevel++;
        const expr = this.visitExpr(ctx.expr());
        const varName = this.getUniqueChicoryVariableName();
        const matchExpr = `${this.indent()}const ${varName} = ${expr};`;
        const arms = ctx.matchArm().map((arm, i) =>
            `${this.indent()}${i > 0 ? "else " : ""}${this.visitMatchArm(arm, varName)}`
        );
        const body = [matchExpr, ...arms].join("\n");
        this.indentLevel--;
        return `(() => {\n${body}\n${this.indent()}})()`;
    }

    visitMatchArm(ctx: parser.MatchArmContext, varName: string): string {
        const { pattern, inject } = this.visitPattern(ctx.matchPattern(), varName);
        const getBlock = () => {
            const childExpr = ctx.expr().getChild(0);
            if (!childExpr) return "";
            if (childExpr instanceof parser.BlockExpressionContext) {
                return this.visitBlockExpr(childExpr.blockExpr(), inject);
            }
            const expr = `return ${this.visitExpr(ctx.expr())};`;
            if (inject) {
                this.indentLevel++;
                const blockBody = `${this.indent()}${inject}\n${this.indent()}${expr}`;
                this.indentLevel--;
                return `{\n${blockBody}\n${this.indent()}}`;
            }
            return expr;
        };
        return `if (${pattern}) ${getBlock()}`;
    }

    // We need tons of work here, we need to disambiguate identifiers that are adts vs destructuring identifiers
    visitPattern(ctx: parser.MatchPatternContext, varName: string): { pattern: string; inject?: string } {
        if (ctx.ruleContext instanceof parser.BareAdtMatchPatternContext) {
            const adtName = (ctx as parser.BareAdtMatchPatternContext).IDENTIFIER().getText();
            return { pattern: `${varName}.type === "${adtName}"` };
        } else if (ctx.ruleContext instanceof parser.AdtWithParamMatchPatternContext) {
            const [adtName, paramName] = (ctx as parser.AdtWithParamMatchPatternContext).IDENTIFIER().map(id => id.getText());
            return {
                pattern: `${varName}.type === "${adtName}"`,
                inject: `const ${paramName} = ${varName}.value;`
            };
        } else if (ctx.ruleContext instanceof parser.AdtWithWildcardMatchPatternContext) {
                const adtName = (ctx as parser.AdtWithWildcardMatchPatternContext).IDENTIFIER().getText();
                // Just check the type
                return { pattern: `${varName}.type === "${adtName}"` }; 
        } else if (ctx.ruleContext instanceof parser.AdtWithLiteralMatchPatternContext) {
            const adtName = (ctx as parser.AdtWithLiteralMatchPatternContext).IDENTIFIER().getText();
            const literalValue = this.visitLiteral((ctx as parser.AdtWithLiteralMatchPatternContext).literal());
            return { pattern: `${varName}.type === "${adtName}" && ${varName}.value === ${literalValue}` };
        } else if (ctx.ruleContext instanceof parser.WildcardMatchPatternContext) {
            return { pattern: "true" };
        } else if (ctx.ruleContext instanceof parser.LiteralMatchPatternContext) {
            const literalValue = this.visitLiteral((ctx as parser.LiteralMatchPatternContext).literal());
            return { pattern: `${varName} === ${literalValue}` };
        }
        this.reportError(`Unknown match pattern type: ${ctx.getText()}`, ctx);
        return { pattern: "false" };
    }

    visitBlockExpr(ctx: parser.BlockExprContext, inject: string = ""): string {
        this.enterScope();
        this.indentLevel++;
        const stmts = ctx.stmt().map(stmt => this.visitStmt(stmt));
        const finalExpr = this.visitExpr(ctx.expr());
        const block = [
            ...(inject ? [this.indent() + inject] : []),
            ...stmts,
            `${this.indent()}return ${finalExpr};`
        ];
        this.indentLevel--;
        this.exitScope();
        return `{\n${block.join("\n")}\n${this.indent()}}`;
    }

    visitRecordExpr(ctx: parser.RecordExprContext): string {
        const kvs = ctx.recordKvExpr().map(kv => this.visitRecordKvExpr(kv));
        return `{ ${kvs.join(", ")} }`;
    }

    visitRecordKvExpr(ctx: parser.RecordKvExprContext): string {
        const key = ctx.IDENTIFIER().getText();
        const value = this.visitExpr(ctx.expr());
        return `${key}: ${value}`;
    }

    visitArrayLikeExpr(ctx: parser.ArrayLikeExprContext): string {
        const elements = ctx.expr().map(expr => this.visitExpr(expr));
        return `[${elements.join(", ")}]`;
    }

    visitJsxExpr(ctx: parser.JsxExprContext): string {
        if (ctx.jsxSelfClosingElement()) {
            return this.visitJsxSelfClosingElement(ctx.jsxSelfClosingElement()!);
        }
        const opening = this.visitJsxOpeningElement(ctx.jsxOpeningElement()!);
        const children = ctx.jsxChild().map(child => this.visitJsxChild(child)).join("");
        const closing = this.visitJsxClosingElement(ctx.jsxClosingElement()!);
        return `${opening}${children}${closing}`;
    }

    visitJsxSelfClosingElement(ctx: parser.JsxSelfClosingElementContext): string {
        const tag = ctx.IDENTIFIER().getText();
        const attrs = ctx.jsxAttributes() ? this.visitJsxAttributes(ctx.jsxAttributes()!) : "";
        return `${this.indent()}<${tag}${attrs} />`;
    }

    visitJsxOpeningElement(ctx: parser.JsxOpeningElementContext): string {
        const tag = ctx.IDENTIFIER().getText();
        const attrs = ctx.jsxAttributes() ? this.visitJsxAttributes(ctx.jsxAttributes()!) : "";
        return `${this.indent()}<${tag}${attrs}>`;
    }

    visitJsxClosingElement(ctx: parser.JsxClosingElementContext): string {
        const tag = ctx.IDENTIFIER().getText();
        return `${this.indent()}</${tag}>`;
    }

    visitJsxAttributes(ctx: parser.JsxAttributesContext): string {
        return ctx.jsxAttribute().map(attr => this.visitJsxAttribute(attr)).join("");
    }

    visitJsxAttribute(ctx: parser.JsxAttributeContext): string {
        const name = ctx.IDENTIFIER().getText();
        const value = ctx.jsxAttributeValue() ? this.visitJsxAttributeValue(ctx.jsxAttributeValue()) : "";
        return ` ${name}=${value}`;
    }

    visitJsxAttributeValue(ctx: parser.JsxAttributeValueContext): string {
        const text = ctx.getText();
        // Preserve quotes for string literals, quote non-quoted values
        return text.startsWith('"') || text.startsWith("{") ? text : `"${text}"`;
    }

    visitJsxChild(ctx: parser.JsxChildContext): string {
        if (ctx instanceof parser.JsxChildJsxContext) {
            return this.visitJsxExpr(ctx.jsxExpr());
        } else if (ctx instanceof parser.JsxChildExpressionContext) {
            return `{${this.visitExpr(ctx.expr())}}`;
        } else if (ctx instanceof parser.JsxChildTextContext) {
            return ctx.getText().trim();
        }
        this.reportError(`Unknown JSX child type: ${ctx.getText()}`, ctx);
        return "";
    }

    visitIdentifier(ctx: ParserRuleContext): string {
        const name = ctx.getText();
        
        // Check if this is a no-argument ADT constructor
        const constructor = this.typeChecker.getConstructors().find(c => c.name === name);
        if (constructor) {
            const constructorType = constructor.type;
            if (constructorType instanceof FunctionType && constructorType.paramTypes.length === 0) {
                // For no-argument constructors, return the object directly
                return `{ type: "${name}" }`;
            }
        }
        
        return name;
    }

    visitLiteral(ctx: parser.LiteralContext): string {
        return ctx.getText();
    }

    // Public method to get compilation output and errors
    getOutput(ctx: parser.ProgramContext): { code: string; errors: CompilationError[]; hints: { context: ParserRuleContext, type: string }[] } {
        this.errors = []; // Reset errors per compilation
        this.hints = []; // Reset hints per compilation
        this.uniqueVarCounter = 0; // Reset variable counter
        this.scopeLevel = 0; // Reset scope level
        
        // Run type checker first
        const {errors, hints} = this.typeChecker.check(ctx);
        
        const typeErrors = errors.map(err => ({
            message: `Type error: ${err.message}`,
            context: err.context
        }));
        
        // Collect type hints
        this.hints = hints;

        const code = this.visitProgram(ctx);
        return { code, errors: [...this.errors, ...typeErrors], hints: this.hints };
    }
}

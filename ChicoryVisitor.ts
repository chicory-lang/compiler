import { readFileSync } from "fs";
import { ParserRuleContext } from "antlr4ng";
import * as parser from "./generated/ChicoryParser";
import { ChicoryTypeChecker } from "./ChicoryTypeCheckerVisitor";
import { CompilationError, TypeHintWithContext, ChicoryType } from "./env";
import {
  AdtType,
  ArrayType,
  FunctionType,
  GenericType,
  RecordType, // Added import
} from "./ChicoryTypes";

export class ChicoryParserVisitor {
  private filename: string;
  private typeChecker: ChicoryTypeChecker;
  private indentLevel: number = 0;
  private scopeLevel: number = 0;
  private uniqueVarCounter: number = 0;
  private errors: CompilationError[] = [];
  private hints: TypeHintWithContext[] = [];
  private expressionTypes: Map<ParserRuleContext, ChicoryType> = new Map();

  constructor(typeChecker: ChicoryTypeChecker, filename: string) {
    this.typeChecker = typeChecker || new ChicoryTypeChecker();
    this.filename = filename;
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
    const lines: string[] = ctx.stmt().map((stmt) => {
      try {
        const result = this.visitStmt(stmt);
        console.log(`[visitProgram] Visited stmt: ${stmt.getText().substring(0, 50)}... -> JS length: ${result?.length ?? 'undefined'}`); // LOGGING
        return result;
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        const stack = e instanceof Error ? e.stack : '';
        console.error(`[visitProgram] ERROR visiting statement: ${stmt.getText().substring(0, 80)}...`); // LOGGING
        console.error(`  Error: ${errorMsg}`); // LOGGING
        console.error(`  Stack: ${stack}`); // LOGGING
        // Report a generic error associated with the statement context
        this.reportError(`Internal error during compilation of statement: ${errorMsg}`, stmt);
        return `/* ERROR visiting statement: ${stmt.getText().substring(0, 50)}... */`; // Return placeholder
      }
    });
    if (ctx.exportStmt()) {
      try { // Also wrap export statement visit
        lines.push(this.visitExportStmt(ctx.exportStmt()!));
      } catch (e) {
          const errorMsg = e instanceof Error ? e.message : String(e);
          console.error(`[visitProgram] ERROR visiting export statement: ${ctx.exportStmt()!.getText()}`); // LOGGING
          console.error(`  Error: ${errorMsg}`); // LOGGING
          this.reportError(`Internal error during compilation of export statement: ${errorMsg}`, ctx.exportStmt()!);
          lines.push(`/* ERROR visiting export statement */`);
      }
    }
    return lines.join("\n");
  }

  visitStmt(ctx: parser.StmtContext): string {
    let resultJs = ""; // Initialize
    if (ctx.assignStmt()) {
      resultJs = `${this.visitAssignStmt(ctx.assignStmt()!)};`;
    } else if (ctx.typeDefinition()) {
      resultJs = `${this.visitTypeDefinition(ctx.typeDefinition()!)}`;
    } else if (ctx.importStmt()) {
      resultJs = `${this.visitImportStmt(ctx.importStmt()!)};`;
    } else if (ctx.globalStmt()) {
      // We only need global statements to type check references to identifiers in the global scope
      // The identifiers compile 1:1 so we don't need to do anything here
    } else if (ctx.expr()) {
      resultJs = `${this.visitExpr(ctx.expr()!)};`;
    } else {
    this.reportError(`Unknown statement type: ${ctx.getText()}`, ctx);
    resultJs = ""; // Continue processing with a no-op
  }
  // console.log(`[visitStmt] Input: ${ctx.getText().substring(0, 50)}... Output JS: ${resultJs}`); // LOGGING REMOVED
  return resultJs;
}

  visitAssignStmt(ctx: parser.AssignStmtContext): string {
    const assignKwd = ctx.assignKwd().getText(); // 'let' or 'const'
    const targetCtx = ctx.assignTarget();
    // Get the type associated with the *assignment target* by the type checker.
    // This should be the final, unified type considering annotations.
    const expectedType = this.expressionTypes.get(targetCtx);
    const expr = this.visitExpr(ctx.expr(), expectedType); // Pass expected type to RHS visitor

    let targetJs: string;
    if (targetCtx.IDENTIFIER()) {
      targetJs = targetCtx.IDENTIFIER()!.getText();
    } else if (targetCtx.recordDestructuringPattern()) {
      const identifiers = targetCtx
        .recordDestructuringPattern()!
        .IDENTIFIER()
        .map((id) => id.getText())
        .join(", ");
      targetJs = `{ ${identifiers} }`;
    } else if (targetCtx.arrayDestructuringPattern()) {
      const identifiers = targetCtx
        .arrayDestructuringPattern()!
        .IDENTIFIER()
        .map((id) => id.getText())
        .join(", ");
      targetJs = `[ ${identifiers} ]`;
    } else {
      targetJs = `/* ERROR: Unknown assignment target */`;
      this.reportError(
        `Unknown assignment target type during compilation: ${targetCtx.getText()}`,
        targetCtx
      );
    }
    return `${this.indent()}${assignKwd} ${targetJs} = ${expr}`;
  }

  visitExportStmt(ctx: parser.ExportStmtContext): string {
    const identifiers = ctx
      .IDENTIFIER()
      .map((id) => id.getText())
      .join(", ");
    return `${this.indent()}export { ${identifiers} };`;
  }

  visitTypeDefinition(ctx: parser.TypeDefinitionContext): string {
    const typeName = ctx.IDENTIFIER().getText();
    const typeExpr = ctx.typeExpr().primaryTypeExpr(); // Keep reference for erasure check later

    // --- Generate ADT Constructors if they exist ---
    console.log(`[visitTypeDefinition] Checking for constructors for type '${typeName}'`);
    const allConstructors = this.typeChecker.getConstructors();
    const constructors = allConstructors.filter((c) => c.adtName === typeName);
    console.log(`[visitTypeDefinition] Found ${constructors.length} constructors for ADT '${typeName}':`, constructors.map(c => c.name));

    if (constructors.length > 0) {
      // Generate constructor functions for each ADT variant found
      const constructorFunctions = constructors
        .map((constructor) => {
          const constructorName = constructor.name;

          // Check if the constructor takes parameters
          const constructorType = constructor.type;
          if (
            constructorType instanceof FunctionType &&
            constructorType.paramTypes.length > 0
          ) {
            return `${this.indent()}const ${constructorName} = (value) => { return { type: "${constructorName}", value }; };`;
          } else {
            // For no-argument constructors, create the object directly
            return `${this.indent()}const ${constructorName} = () => { return { type: "${constructorName}" }; };`;
          }
        })
        .join("\n");
      // Return the generated functions. We don't erase ADTs.
      return constructorFunctions;
    }

    // --- If no constructors found, proceed with Type Erasure ---
    console.log(`[visitTypeDefinition] No constructors found for '${typeName}'. Performing type erasure.`);
    // Erase function types, generic type aliases (that aren't ADTs), and simple aliases
    // Use the original typeExpr reference to check the structure for erasure purposes
    if (typeExpr.functionType() || typeExpr.genericTypeExpr() || typeExpr.recordType() || typeExpr.tupleType() || typeExpr.primitiveType() || typeExpr.IDENTIFIER()) {
       return `${this.indent()}/* Type Erasure: ${typeName} */`;
    }

    // Fallback erasure (should ideally not be reached if grammar/logic is complete)
    console.warn(`[visitTypeDefinition] Unhandled type structure for erasure: ${typeExpr.getText()}`);
    return `${this.indent()}/* Type Erasure (Fallback): ${typeName} */`;
  }

  visitImportStmt(ctx: parser.ImportStmtContext): string {
    if (
      !(
        ctx instanceof parser.ImportStatementContext ||
        ctx instanceof parser.BindStatementContext
      )
    ) {
      throw new Error("Invalid import statement");
    }
    const fromPathRaw = ctx.STRING().getText();
    let fromPath = fromPathRaw.substring(1, fromPathRaw.length - 1);

    // Check if it's a Chicory import based on the original path
    // const isChicoryImport = fromPath.endsWith(".chic");
    // if (isChicoryImport) {
    //   fromPath = fromPath.replace(/\.chic$/, ".js");
    // }
    // const jsFromPath = `"${fromPath}"`;

    if (ctx instanceof parser.ImportStatementContext) {
      const defaultImport = ctx.IDENTIFIER() ? ctx.IDENTIFIER()!.getText() : "";
      const destructuring = ctx.destructuringImportIdentifier()
        ? this.visitDestructuringImportIdentifier(
            ctx.destructuringImportIdentifier()!
          )
        : "";
      const body = [defaultImport, destructuring].filter(Boolean).join(", ");
    //   return this.indent() + `import ${body} from ${jsFromPath}`;
      return this.indent() + `import ${body} from "${fromPath}"`;
    } else if (ctx instanceof parser.BindStatementContext) {
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

  visitDestructuringImportIdentifier(
    ctx: parser.DestructuringImportIdentifierContext
  ): string {
    const identifiers = ctx.IDENTIFIER();
    return identifiers.length > 0
      ? `{ ${identifiers.map((id) => id.getText()).join(", ")} }`
      : "";
  }

  visitBindingImportIdentifier(
    ctx: parser.BindingImportIdentifierContext
  ): string {
    const bindingIdentifiers = ctx
      .bindingIdentifier()
      .map((binding) => binding.IDENTIFIER().getText());

    return bindingIdentifiers.length > 0
      ? `{ ${bindingIdentifiers.join(", ")} }`
      : "";
  }

  // Add expectedType parameter
  visitExpr(ctx: parser.ExprContext, expectedType?: ChicoryType): string { // Added expectedType
    // Get the type of the primary expression from the map
    const primaryExprCtx = ctx.primaryExpr();
    // Pass expectedType down to primary expression visitor
    let currentJs = this.visitPrimaryExpr(primaryExprCtx, expectedType);

    // --- Get Type of Base Expression ---
    // Use the specific context node that the type checker used as the key.
    // For identifiers, it's the IdentifierExpressionContext itself.
    // For other primary expressions (literals, records, etc.), it's the PrimaryExprContext.
    let typeLookupCtx: ParserRuleContext = primaryExprCtx;
    if (primaryExprCtx instanceof parser.IdentifierExpressionContext) {
        typeLookupCtx = primaryExprCtx; // Use the specific context for identifiers
    }
    // Add 'else if' for other specific contexts if needed (e.g., LiteralExpressionContext)
    let currentType = this.expressionTypes.get(typeLookupCtx); // Use the determined context for lookup
    // --- End Get Type ---


    // Iterate through tail expressions, compiling them sequentially
    for (const tailExprCtx of ctx.tailExpr()) {
      // Pass the current JS string and its inferred type to the compiler helper
      currentJs = this.compileTailExpr(tailExprCtx, currentJs, currentType);
      // Update the current type for the next iteration using the type map
      currentType = this.expressionTypes.get(tailExprCtx);
      if (!currentType) {
        // This might happen if type checking failed for this part.
        // Log or handle? For now, continue, JS might still be valid.
        console.warn(`No type found for tail expression: ${tailExprCtx.getText()}`);
      }
    }
    return currentJs; // Return the final compiled JS string
  }

  compileTailExpr(
    ctx: parser.TailExprContext,
    baseJs: string,
    baseType: ChicoryType | undefined
  ): string {
    // We use baseType (type of the expression *before* this tail part)
    // to decide *how* to compile this tail part.

    if (ctx.ruleContext instanceof parser.MemberExpressionContext) {
      const memberName = (ctx as parser.MemberExpressionContext)
        .IDENTIFIER()
        .getText();
      // Direct JS member access works for records and arrays (for built-ins)
      return `${baseJs}.${memberName}`;
    } else if (ctx.ruleContext instanceof parser.IndexExpressionContext) {
      const indexExprJs = this.visitExpr(
        (ctx as parser.IndexExpressionContext).expr()
      );
      // Use the type of the base expression to decide compilation strategy
      if (baseType instanceof ArrayType) {
        // Use the injected runtime helper for safe array access returning Option
        // NOTE: The type checker now handles Option wrapping for array index,
        // so the compiler just needs to generate the JS index access.
        // The type checker ensures the result is Option<T>.
        // However, if we want runtime safety *in JS* (e.g., for out-of-bounds),
        // a helper might still be useful, but let's stick to direct access for now
        // and rely on the type checker's Option result type.
        // If a helper IS used, it must return the Some/None structure.
        // return `__chicory_array_index(${baseJs}, ${indexExprJs})`; // Example helper
        return `${baseJs}[${indexExprJs}]`; // Direct access (JS returns undefined if out of bounds)
      } else {
        // Assume Tuple access (or potentially String in future)
        // Type checker already validated this (or errored)
        return `${baseJs}[${indexExprJs}]`;
      }
    } else if (ctx.ruleContext instanceof parser.CallExpressionContext) {
      const callCtx = (ctx as parser.CallExpressionContext).callExpr();
      // Determine expected parameter types directly from the FunctionType
      const expectedParamTypes = (baseType instanceof FunctionType) ? baseType.paramTypes : [];

      const args = callCtx.expr()
        ? callCtx
            .expr()
            .map((expr, index) => {
                const expectedArgType = expectedParamTypes[index]; // Get expected type for this arg
                // Pass expected type down to the argument expression visitor
                return this.visitExpr(expr, expectedArgType);
            })
            .join(", ")
        : "";

      // ---> START REPLACEMENT <--- // Note: This section handles Option wrapping for specific array methods

      // Get the type inferred by the type checker for the *result* of this specific call expression node
      const resultType = this.expressionTypes.get(ctx); // ctx is the TailExprContext wrapping CallExpressionContext

      // Check if the result type is Option<...> AND if the method being called is find or findIndex
      if (resultType instanceof GenericType && resultType.name === "Option") {
        // Check the actual method name stored in baseJs (e.g., "myArray.find")
        if (baseJs.endsWith(".find")) {
          return `((__res) => __res === undefined ? None() : Some(__res))(${baseJs}(${args}))`;
        } else if (baseJs.endsWith(".findIndex")) {
          return `((__res) => __res === -1 ? None() : Some(__res))(${baseJs}(${args}))`;
        }
        // If other Option-returning methods are added, handle them here.
      }

      // Default case: Not an Option-returning array method we handle specially,
      // or type information was missing. Generate standard function call syntax.
      return `${baseJs}(${args})`;

      // ---> END REPLACEMENT <---
    } else if (ctx.ruleContext instanceof parser.OperationExpressionContext) {
      const op = (ctx as parser.OperationExpressionContext)
        .OPERATOR()
        .getText();
      const rhsJs = this.visitExpr(
        (ctx as parser.OperationExpressionContext).expr()
      );
      // Standard binary operation syntax
      return `${baseJs} ${op} ${rhsJs}`;
    }

    this.reportError(
      `Unknown tail expression type during compilation: ${ctx.getText()}`,
      ctx
    );
    return `${baseJs}/* ERROR: Unknown tail expr ${ctx.getText()} */`;
  }

  visitTailExpr(ctx: parser.TailExprContext): string {
    if (ctx.ruleContext instanceof parser.MemberExpressionContext) {
      return this.visitMemberExpr(ctx as parser.MemberExpressionContext);
    } else if (ctx.ruleContext instanceof parser.IndexExpressionContext) {
      return this.visitIndexExpr(ctx as parser.IndexExpressionContext);
    } else if (ctx.ruleContext instanceof parser.CallExpressionContext) {
      return this.visitCallExpr(
        (ctx as parser.CallExpressionContext).callExpr()
      );
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

  // Add expectedType parameter
  visitPrimaryExpr(
    ctx: parser.PrimaryExprContext,
    expectedType?: ChicoryType // Added expectedType
  ): string {
    const child = ctx.getChild(0);
    if (ctx instanceof parser.ParenExpressionContext) {
      // Pass expectedType through parentheses
      return `(${this.visitExpr(ctx.expr(), expectedType)})`; // Pass expectedType
    } else if (child instanceof parser.IfExprContext) {
      return this.visitIfElseExpr(child); // If doesn't directly use expectedType here
    } else if (child instanceof parser.FuncExprContext) {
      return this.visitFuncExpr(child);
    } else if (child instanceof parser.JsxExprContext) {
      return this.visitJsxExpr(child);
    } else if (child instanceof parser.MatchExprContext) {
      return this.visitMatchExpr(child);
    } else if (child instanceof parser.BlockExprContext) {
      return this.visitBlockExpr(child);
    } else if (child instanceof parser.RecordExprContext) {
      // Pass expectedType to record expression visitor
      return this.visitRecordExpr(child, expectedType); // Pass expectedType
    } else if (child instanceof parser.ArrayLikeExprContext) {
      return this.visitArrayLikeExpr(child); // Array doesn't use expectedType directly here
    } else if (ctx.ruleContext instanceof parser.IdentifierExpressionContext) {
      return this.visitIdentifier(ctx); // Identifier doesn't use expectedType directly here
    } else if (child instanceof parser.LiteralContext) {
      return this.visitLiteral(child);
    }
    this.reportError(`Unknown primary expression type: ${ctx.getText()}`, ctx);
    return "";
  }

  visitIfElseExpr(ctx: parser.IfExprContext): string {
    const ifs = ctx.justIfExpr().map((justIf) => this.visitIfExpr(justIf));
    const getElseExpr = () => {
      const child = ctx.expr()!.getChild(0);
      return child instanceof parser.BlockExpressionContext
        ? this.visitBlockExpr(child.blockExpr())
        : `{ return ${this.visitExpr(ctx.expr()!)}; }`;
    };
    return (
      ifs.join("") + (ctx.expr() ? `(() => ${getElseExpr()})()` : "undefined")
    );
  }

  visitIfExpr(ctx: parser.JustIfExprContext): string {
    const condition = this.visitExpr(ctx.expr()[0]);
    const thenExpr = ctx.expr()[1].getChild(0);
    const block =
      thenExpr instanceof parser.BlockExpressionContext
        ? this.visitBlockExpr(thenExpr.blockExpr())
        : `{ return ${this.visitExpr(ctx.expr()[1])}; }`;
    return `(${condition}) ? (() => ${block})() : `;
  }

  visitFuncExpr(ctx: parser.FuncExprContext): string {
    this.enterScope();

    const params: string[] = [];
    if (
      ctx instanceof parser.ParenFunctionExpressionContext &&
      ctx.parameterList()
    ) {
      params.push(...this.visitParameterList(ctx.parameterList()!));
    } else if (ctx instanceof parser.ParenlessFunctionExpressionContext) {
      params.push(ctx.idOrWild().getText());
    }

    // @ts-expect-error TS can't tell that ctx will always have an expr. But we know it will because there are only two options and both have one expr.
    const body = this.visitExpr(ctx.expr()!);

    this.exitScope();
    return `(${params.join(", ")}) => ${body}`;
  }

  visitParameterList(ctx: parser.ParameterListContext): string[] {
    return ctx.idOrWild().map((id) => id.getText());
  }

  visitCallExpr(ctx: parser.CallExprContext): string {
    const args = ctx.expr()
      ? ctx
          .expr()
          .map((expr) => this.visitExpr(expr))
          .join(", ")
      : "";
    return `(${args})`;
  }

  visitMatchExpr(ctx: parser.MatchExprContext): string {
    this.indentLevel++;
    const expr = this.visitExpr(ctx.expr());
    const varName = this.getUniqueChicoryVariableName();
    const matchExpr = `${this.indent()}const ${varName} = ${expr};`;
    const arms = ctx
      .matchArm()
      .map(
        (arm, i) =>
          `${this.indent()}${i > 0 ? "else " : ""}${this.visitMatchArm(
            arm,
            varName
          )}`
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
  visitPattern(
    ctx: parser.MatchPatternContext,
    varName: string
  ): { pattern: string; inject?: string } {
    if (ctx.ruleContext instanceof parser.BareAdtOrVariableMatchPatternContext) {
      const adtName = (ctx as parser.BareAdtOrVariableMatchPatternContext)
        .IDENTIFIER()
        .getText();
      return { pattern: `${varName}.type === "${adtName}"` };
    } else if (
      ctx.ruleContext instanceof parser.AdtWithParamMatchPatternContext
    ) {
      const [adtName, paramName] = (
        ctx as parser.AdtWithParamMatchPatternContext
      )
        .IDENTIFIER()
        .map((id) => id.getText());
      return {
        pattern: `${varName}.type === "${adtName}"`,
        inject: `const ${paramName} = ${varName}.value;`,
      };
    } else if (
      ctx.ruleContext instanceof parser.AdtWithWildcardMatchPatternContext
    ) {
      const adtName = (ctx as parser.AdtWithWildcardMatchPatternContext)
        .IDENTIFIER()
        .getText();
      // Just check the type
      return { pattern: `${varName}.type === "${adtName}"` };
    } else if (
      ctx.ruleContext instanceof parser.AdtWithLiteralMatchPatternContext
    ) {
      const adtName = (ctx as parser.AdtWithLiteralMatchPatternContext)
        .IDENTIFIER()
        .getText();
      const literalValue = this.visitLiteral(
        (ctx as parser.AdtWithLiteralMatchPatternContext).literal()
      );
      return {
        pattern: `${varName}.type === "${adtName}" && ${varName}.value === ${literalValue}`,
      };
    } else if (ctx.ruleContext instanceof parser.WildcardMatchPatternContext) {
      return { pattern: "true" };
    } else if (ctx.ruleContext instanceof parser.LiteralMatchPatternContext) {
      const literalValue = this.visitLiteral(
        (ctx as parser.LiteralMatchPatternContext).literal()
      );
      return { pattern: `${varName} === ${literalValue}` };
    }
    this.reportError(`Unknown match pattern type: ${ctx.getText()}`, ctx);
    return { pattern: "false" };
  }

  visitBlockExpr(ctx: parser.BlockExprContext, inject: string = ""): string {
    this.enterScope();
    this.indentLevel++;
    const stmts = ctx.stmt().map((stmt) => this.visitStmt(stmt));
    const finalExpr = this.visitExpr(ctx.expr());
    const block = [
      ...(inject ? [this.indent() + inject] : []),
      ...stmts,
      `${this.indent()}return ${finalExpr};`,
    ];
    this.indentLevel--;
    this.exitScope();
    return `{\n${block.join("\n")}\n${this.indent()}}`;
  }

  // Add expectedType parameter
  visitRecordExpr(
    ctx: parser.RecordExprContext,
    expectedType?: ChicoryType
  ): string {
    const providedKeys = new Set<string>();
    const compiledKvs: string[] = [];

    // Compile provided key-value pairs
    ctx.recordKvExpr().forEach((kv) => {
      const key = kv.IDENTIFIER().getText();
      providedKeys.add(key);
      compiledKvs.push(this.visitRecordKvExpr(kv));
    });

    // --- NEW Optional Field Handling (Rescript Style) ---
    // Use the *expected* type passed down from the calling context (assignment, function arg, etc.)
    // const expectedRecordType = this.expressionTypes.get(ctx); // <<< OLD: Used inferred type of the literal itself
    const expectedRecordType = expectedType; // <<< NEW: Use the passed-down expected type
    let finalRecordType: RecordType | null = null;

    if (expectedRecordType) {
        // Resolve potential aliases to get the underlying RecordType
        finalRecordType = this.typeChecker.resolveToRecordType(expectedRecordType);
        console.log(`[visitRecordExpr] Expected type (from param/annotation) resolved to: ${finalRecordType?.toString()}`); // Adjusted log
    } else {
        console.log(`[visitRecordExpr] No expected type passed down for record literal.`); // Adjusted log
        // If no expected type, compile literally (no Some/None wrapping)
        // This happens for inferred records: let r = { a: 1 }
    }

    if (finalRecordType) {
        // Expected type IS a RecordType, apply wrapping logic
        const finalCompiledKvs: string[] = [];

        // Process provided fields
        ctx.recordKvExpr().forEach((kv) => {
            const key = kv.IDENTIFIER().getText();
            const valueJs = this.visitExpr(kv.expr()); // Compile the value expression
            const expectedFieldInfo = finalRecordType!.fields.get(key);
            const valueExprCtx = kv.expr(); // Get the original expression context for the value

            if (expectedFieldInfo?.optional) {
                // Check if the original expression was already Some(...) or None
                const valueText = valueExprCtx.getText();
                const alreadyWrapped = valueText.startsWith("Some(") || valueText === "None"; // Basic check

                if (alreadyWrapped) {
                    // If already wrapped in source, compile it directly without adding another Some()
                    finalCompiledKvs.push(`${key}: ${valueJs}`);
                    this.typeChecker.prelude.requireOptionType(); // Still need prelude
                    console.log(`  > Compiling optional field '${key}': Value already wrapped ('${valueText}'). Using direct value.`);
                } else {
                    // If not already wrapped, wrap the compiled value in Some()
                    finalCompiledKvs.push(`${key}: Some(${valueJs})`);
                    this.typeChecker.prelude.requireOptionType(); // Ensure Some/None are available
                    console.log(`  > Compiling optional field '${key}': Wrapping value in Some().`);
                }
            } else {
                // If the expected field is required, compile directly
                finalCompiledKvs.push(`${key}: ${valueJs}`);
                 if (!expectedFieldInfo) {
                     console.warn(`  > Field '${key}' provided but not found in expected type ${finalRecordType}. Compiling literally.`);
                 } else {
                     console.log(`  > Compiling required field '${key}': Using direct value.`);
                 }
            }
            providedKeys.add(key); // Track provided keys
        });

        // Add None() for omitted optional fields
        for (const [expectedKey, expectedFieldInfo] of finalRecordType.fields) {
            if (!providedKeys.has(expectedKey) && expectedFieldInfo.optional) {
                finalCompiledKvs.push(`${expectedKey}: None()`);
                this.typeChecker.prelude.requireOptionType();
                console.log(`  > Compiling omitted optional field '${expectedKey}': Adding None().`);
            }
            // Omitted required fields are type errors, already handled by checker.
        }
        return `{ ${finalCompiledKvs.join(", ")} }`;

    } else {
        // No expected type or not a record type, compile literally
        console.log(`[visitRecordExpr] Compiling record literally (no expected type or not a record).`);
        return `{ ${compiledKvs.join(", ")} }`;
    }
    // --- End NEW Optional Field Handling ---
  }

  visitRecordKvExpr(ctx: parser.RecordKvExprContext): string {
    const key = ctx.IDENTIFIER().getText();
    const value = this.visitExpr(ctx.expr());
    return `${key}: ${value}`;
  }

  visitArrayLikeExpr(ctx: parser.ArrayLikeExprContext): string {
    const elements = ctx.expr().map((expr) => this.visitExpr(expr));
    return `[${elements.join(", ")}]`;
  }

  visitJsxExpr(ctx: parser.JsxExprContext): string {
    if (ctx.jsxSelfClosingElement()) {
      return this.visitJsxSelfClosingElement(ctx.jsxSelfClosingElement()!);
    }
    const opening = this.visitJsxOpeningElement(ctx.jsxOpeningElement()!);
    const children = ctx
      .jsxChild()
      .map((child) => this.visitJsxChild(child))
      .join("");
    const closing = this.visitJsxClosingElement(ctx.jsxClosingElement()!);
    return `${opening}${children}${closing}`;
  }

  visitJsxSelfClosingElement(ctx: parser.JsxSelfClosingElementContext): string {
    const tag = ctx.IDENTIFIER().getText();
    const attrs = ctx.jsxAttributes()
      ? this.visitJsxAttributes(ctx.jsxAttributes()!)
      : "";
    return `${this.indent()}<${tag}${attrs} />`;
  }

  visitJsxOpeningElement(ctx: parser.JsxOpeningElementContext): string {
    const tag = ctx.IDENTIFIER().getText();
    const attrs = ctx.jsxAttributes()
      ? this.visitJsxAttributes(ctx.jsxAttributes()!)
      : "";
    return `${this.indent()}<${tag}${attrs}>`;
  }

  visitJsxClosingElement(ctx: parser.JsxClosingElementContext): string {
    const tag = ctx.IDENTIFIER().getText();
    return `${this.indent()}</${tag}>`;
  }

  visitJsxAttributes(ctx: parser.JsxAttributesContext): string {
    return ctx
      .jsxAttribute()
      .map((attr) => this.visitJsxAttribute(attr))
      .join("");
  }

  visitJsxAttribute(ctx: parser.JsxAttributeContext): string {
    const name = ctx.IDENTIFIER()?.getText() || "type"
    const value = ctx.jsxAttributeValue()
      ? this.visitJsxAttributeValue(ctx.jsxAttributeValue())
      : "";
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
    const constructor = this.typeChecker
      .getConstructors()
      .find((c) => c.name === name);
    if (constructor) {
      const constructorType = constructor.type;
      if (
        constructorType instanceof FunctionType &&
        constructorType.paramTypes.length === 0
      ) {
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
  getOutput(ctx: parser.ProgramContext): {
    code: string;
    errors: CompilationError[];
    hints: { context: ParserRuleContext; type: string }[];
  } {
    this.errors = []; // Reset errors per compilation
    this.hints = []; // Reset hints per compilation
    this.uniqueVarCounter = 0; // Reset variable counter
    this.scopeLevel = 0; // Reset scope level
    this.expressionTypes.clear(); // Clear type map

    const { errors, hints, expressionTypes, prelude } =
      this.typeChecker.check(
        ctx,
        this.filename,
        (fp) => readFileSync(fp, "utf-8"),
        new Map(), // Use actual cache/processing set if integrating properly
        new Set()
      );
    this.expressionTypes = expressionTypes;
    // Store the prelude instance returned by the checker
    this.typeChecker.prelude = prelude; // Ensure the visitor uses the final prelude state

    const typeErrors = errors.map((err) => ({
      message: `Type Error: ${err.message}`,
      context: err.context,
    }));

    // Collect type hints
    this.hints = hints;

    const compiledUserCode = this.visitProgram(ctx);
    console.log(`[getOutput] Compiled User Code:\n---\n${compiledUserCode}\n---`); // LOGGING

    // Use the prelude instance stored in the visitor's typeChecker instance
    const preludeCode = this.typeChecker.prelude.getPrelude(); // LOGGING
    console.log(`[getOutput] Prelude Code:\n---\n${preludeCode}\n---`); // LOGGING

    const finalCode = (preludeCode + "\n" + compiledUserCode).trim();
    console.log(`[getOutput] Final Code:\n---\n${finalCode}\n---`); // LOGGING

    return {
      code: finalCode,
      errors: [...this.errors, ...typeErrors],
      hints: this.hints,
    };
  }
}

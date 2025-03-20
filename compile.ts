import { CharStream, CommonTokenStream, ParserRuleContext, ParseTreeWalker, TokenStream } from 'antlr4ng';
import { ChicoryLexer } from './generated/ChicoryLexer';
import { ChicoryParser } from './generated/ChicoryParser';
import { ChicoryParserVisitor } from './ChicoryVisitor';
import { ChicoryTypeChecker } from './ChicoryTypeCheckerVisitor';
import { LspDiagnostic, CompilationError, SyntaxError, TypeHint, LspRange } from './env';
import { ChicoryErrorListener } from './ChicoryErrorListener';

const rangeContains = (outer: LspRange, inner: LspRange): boolean => {
    return (
        (outer.start.line < inner.start.line ||
          (outer.start.line === inner.start.line && outer.start.character < inner.start.character))
        &&
        (outer.end.line > inner.end.line ||
          (outer.end.line === inner.end.line && outer.end.character > inner.end.character))
    );
}

const filterOutErrorsThatContainOtherErrors = (errors: LspDiagnostic[]): LspDiagnostic[] => {
    const filteredErrors: LspDiagnostic[] = [];

    for (const error of errors) {
        let containsOtherError = false;

        for (const otherError of errors) {
            if (error !== otherError && rangeContains(error.range, otherError.range)) {
                containsOtherError = true
            }
        }
        if (!containsOtherError) {
            filteredErrors.push(error);
        }
    }

    return filteredErrors;
}

const getRange = (ctx: ParserRuleContext, tokenStream: TokenStream) => {
    const {start, stop} = ctx.getSourceInterval()
    const startToken = tokenStream.get(start)
    const stopToken = tokenStream.get(stop)
    return {
        start: { line: startToken.line - 1, character: startToken.column },
        end: { line: stopToken.line - 1, character: stopToken.column + (stopToken.text?.length || 1) }
    }
}

const compilerErrorToLspError = (tokenStream: TokenStream) => ((e: CompilationError) => ({
    severity: 1, // 1 is error
    message: e.message as string,
    range: getRange(e.context, tokenStream),
    source: "chicory",
}))

const syntaxErrorToLspError = (e: SyntaxError) => ({
    severity: 1, // 1 is error
    source: "chicory",
    ...e
})

export type CompileResult = {
    code: string;
    errors: LspDiagnostic[];
    hints: TypeHint[];
}

export default (source: string): CompileResult => {
    if (!source.trim()) {
        return { code: "", errors: [], hints: [] }
    }
    let inputStream = CharStream.fromString(source);
    let lexer = new ChicoryLexer(inputStream);
    let tokenStream = new CommonTokenStream(lexer);
    let parser = new ChicoryParser(tokenStream);

    const errorListener = new ChicoryErrorListener();
    lexer.removeErrorListeners();
    lexer.addErrorListener(errorListener);
    parser.removeErrorListeners();
    parser.addErrorListener(errorListener);

    let tree = parser.program();
    
    // Create type checker first
    const typeChecker = new ChicoryTypeChecker();
    
    // Create visitor with the type checker
    const visitor = new ChicoryParserVisitor(typeChecker);

    let code: string = ""
    let errors: LspDiagnostic[] = []
    let hints: TypeHint[] = []
    try {
        const {code: compiledCode, errors: unprocessedErrors, hints: unprocessedHints} = visitor.getOutput(tree) || {code: "", errors: [], hints: []}
        const mapErrors = compilerErrorToLspError(tokenStream)

        code = compiledCode
        errors.push(...unprocessedErrors.map(mapErrors))
        hints = unprocessedHints.map(({context, type}) => ({
            range: getRange(context, tokenStream),
            type
        }));
    }
    catch (e) {
        // We ensure that the compiler does not crash if the parser fails to produce a parseable parse tree
    }

    const syntaxErrors = errorListener.getErrors();
    errors.push(...syntaxErrors.map(syntaxErrorToLspError))

    errors = filterOutErrorsThatContainOtherErrors(errors)
    
    // Convert hints to LSP format

    return {
        code,
        errors,
        hints
    }
}

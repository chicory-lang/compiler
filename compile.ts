import { CharStream, CommonTokenStream, ParserRuleContext, ParseTreeWalker, TokenStream } from 'antlr4ng';
import { ChicoryLexer } from './generated/ChicoryLexer';
import { ChicoryParser } from './generated/ChicoryParser';
import { ChicoryParserVisitor } from './ChicoryVisitor';
import { ChicoryTypeChecker } from './ChicoryTypeCheckerVisitor';
import { LspDiagnostic, CompilationError } from './env';

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
    let tree = parser.program();
    
    // Create type checker first
    const typeChecker = new ChicoryTypeChecker();
    
    // Create visitor with the type checker
    const visitor = new ChicoryParserVisitor(typeChecker);
    const {code, errors: unprocessedErrors, hints: unprocessedHints} = visitor.getOutput(tree) || {code: "", errors: [], hints: []}

    const mapErrors = compilerErrorToLspError(tokenStream)
    const errors = unprocessedErrors.map(mapErrors)
    
    // Convert hints to LSP format
    const hints = unprocessedHints.map(hint => ({
        range: getRange(hint.context, tokenStream),
        type: hint.type
    }));

    return {
        code,
        errors,
        hints
    }
}

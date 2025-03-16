import { ParserRuleContext } from "antlr4ng";

type CompilationError = { message: string; context: ParserRuleContext };

type LspRange = {
    start: {
        line: number;
        character: number;
    };
    end: {
        line: number;
        character: number;
    };
};

type LspDiagnostic = {
    severity: number;
    message: string;
    range: LspRange;
    source: string;
}
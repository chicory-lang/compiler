import { ParserRuleContext } from "antlr4ng";

type CompilationError = { message: string; context: ParserRuleContext };

type SyntaxError = { message: string; range: LspRange }

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

type TypeHintWithContext = {
    context: ParserRuleContext;
    type: string;
}

type TypeHint = {
    range: LspRange;
    type: string;
}

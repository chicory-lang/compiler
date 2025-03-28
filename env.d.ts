import { ParserRuleContext } from "antlr4ng";

export interface ChicoryType {
  toString(): string; // For easy debugging and hint display
}

type CompilationError = { message: string; context: ParserRuleContext };

type SyntaxError = { message: string; range: LspRange };

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
};

type TypeHintWithContext = {
  context: ParserRuleContext;
  type: string;
  // message?: string;  // Optional extra message
};

type TypeHint = {
  range: LspRange;
  type: string;
};

// Define the cache structure
type CompilationCacheEntry = {
  exports: Map<string, ChicoryType>;
  errors: CompilationError[];
  // Potentially add other artifacts like generated prelude requirements
};

type CompilationCache = Map<string, CompilationCacheEntry>; // Key: absolute file path

type ProcessingFiles = Set<string>; // Key: absolute file path

type SubstitutionMap = Map<string, ChicoryType>;

import { ANTLRErrorListener, ATNSimulator, RecognitionException, Recognizer, Token } from "antlr4ng";
import { SyntaxError } from "./env";

// Custom error listener to provide better error messages
export class ChicoryErrorListener {
  private errors: SyntaxError[] = [];

  syntaxError<S extends Token, T extends ATNSimulator>(recognizer: Recognizer<T>, offendingSymbol: S | null, line: number, charPositionInLine: number, msg: string, e: RecognitionException | null)
  : void {
    // Create a context-like object for the error
    const range = {
      start: { line, character: charPositionInLine },
      end: { line, character: charPositionInLine + (offendingSymbol?.text?.length || 1) - 1 }
    };

    this.errors.push({ message: "Syntax Error: " + msg, range });
  }

  getErrors(): SyntaxError[] {
    return this.errors;
  }

  clearErrors(): void {
    this.errors = [];
  }

  reportAmbiguity() {}
  reportAttemptingFullContext() {}
  reportContextSensitivity() {}
}
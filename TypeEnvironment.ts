import { ParserRuleContext } from "antlr4ng";
import { ChicoryType } from "./env";

export class TypeEnvironment {
  private bindings: Map<string, ChicoryType>;

  constructor(public parent: TypeEnvironment | null) {
    this.bindings = new Map();
  }

  getType(identifier: string): ChicoryType | undefined {
    let type = this.bindings.get(identifier);
    if (type) {
      return type;
    }
    if (this.parent) {
      return this.parent.getType(identifier);
    }
    return undefined;
  }

  declare(
    identifier: string,
    type: ChicoryType,
    context: ParserRuleContext | null,
    pushError: (str) => void
  ): void {
    if (this.bindings.has(identifier)) {
      pushError(
        `Identifier '${identifier}' is already declared in this scope.`
      );
      return; // We don't want to continue because this is an error
    }
    this.bindings.set(identifier, type);
  }

  pushScope(): TypeEnvironment {
    return new TypeEnvironment(this);
  }

  popScope(): TypeEnvironment {
    if (this.parent === null) {
      throw new Error("Cannot pop the global scope.");
    }
    return this.parent;
  }

  getAllTypes(): Map<string, ChicoryType> {
    return new Map(this.bindings);
  }
}

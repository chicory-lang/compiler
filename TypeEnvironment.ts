import { ParserRuleContext } from "antlr4ng";
import { TypeVariable } from "./ChicoryTypes";
import { ChicoryType } from "./env";

export interface EnvironmentEntry {
  type: ChicoryType;
  genericParams: TypeVariable[];
}

export class TypeEnvironment {
  private bindings: Map<string, EnvironmentEntry>;

  constructor(public parent: TypeEnvironment | null) {
    this.bindings = new Map();
  }

  getEntry(identifier: string): EnvironmentEntry | undefined {
    const entry = this.bindings.get(identifier);
    if (entry) {
      return entry;
    }
    if (this.parent) {
      return this.parent.getEntry(identifier);
    }
    return undefined;
  }

  getType(identifier: string): ChicoryType | undefined {
    return this.getEntry(identifier)?.type;
  }

  declare(
    identifier: string,
    type: ChicoryType,
    context: ParserRuleContext | null,
    pushError: (str) => void,
    genericParams: TypeVariable[] = []
  ): void {
    if (this.bindings.has(identifier)) {
      pushError(
        `Identifier '${identifier}' is already declared in this scope.`
      );
      return; // We don't want to continue because this is an error
    }
    this.bindings.set(identifier, { type, genericParams });
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

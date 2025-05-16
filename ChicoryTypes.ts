import { ChicoryType } from "./env";

// Primitive Types
export class StringTypeClass implements ChicoryType {
  static instance = new StringTypeClass();
  private constructor() {} // Make constructor private to enforce singleton
  toString() {
    return "string";
  }
}

export class NumberTypeClass implements ChicoryType {
  static instance = new NumberTypeClass();
  private constructor() {}
  toString() {
    return "number";
  }
}

export class BooleanTypeClass implements ChicoryType {
  static instance = new BooleanTypeClass();
  private constructor() {}
  toString() {
    return "boolean";
  }
}

export class UnitTypeClass implements ChicoryType {
  // Represents 'void' or '()'
  static instance = new UnitTypeClass();
  private constructor() {}
  toString() {
    return "void";
  }
}

// Function Type
export class FunctionType implements ChicoryType {
  constructor(
    public paramTypes: ChicoryType[],
    public returnType: ChicoryType,
    public constructorName?: string
  ) {}
  toString() {
    if (this.constructorName) {
      return `${this.returnType} ~> ${this.constructorName}`;
    }
    const params = this.paramTypes.map((p) => p.toString()).join(", ");
    return `(${params}) => ${this.returnType.toString()}`;
  }
}

// Record Type Field Definition
export interface RecordField {
    type: ChicoryType;
    optional: boolean;
}

// Record Type
export class RecordType implements ChicoryType {
  constructor(public fields: Map<string, RecordField>) {} // Store RecordField objects
  toString() {
    const fieldStrings = Array.from(this.fields.entries()).map(
      ([key, field]) => `${key}${field.optional ? "?" : ""}: ${field.type.toString()}` // Add '?' if optional
    );
    return `{ ${fieldStrings.join(", ")} }`;
  }
}

// Tuple Type
export class TupleType implements ChicoryType {
  constructor(public elementTypes: ChicoryType[]) {}
  toString() {
    return `[${this.elementTypes.map((e) => e.toString()).join(", ")}]`;
  }
}

// Array Type
export class ArrayType implements ChicoryType {
  readonly kind = "Array";
  constructor(public elementType: ChicoryType) {}

  toString(): string {
    const elementStr = this.elementType.toString();
    // Parenthesize complex inner types for clarity
    if (
      this.elementType instanceof FunctionType ||
      this.elementType instanceof TupleType ||
      // this.elementType instanceof ArrayType || // Handle T[][] correctly
      (this.elementType instanceof GenericType &&
        this.elementType.typeArguments.length > 0) ||
      // Add other conditions if needed, e.g., ADT type strings that might conflict
      this.elementType instanceof AdtType // Maybe parenthesize ADTs too? e.g., (MyADT)[] vs potential ambiguity
    ) {
      return `(${elementStr})[]`;
    }
    return `${elementStr}[]`;
  }
}

// ADT Type
export class AdtType implements ChicoryType {
  constructor(
    public name: string,
    public typeParameters: ChicoryType[] = []
  ) {}
  toString() {
    if (this.typeParameters.length === 0) {
      return this.name;
    }
    return `${this.name}<${this.typeParameters.map(t => t.toString()).join(", ")}>`;
  }
}

// Generic Type (Simplified for now)
export class GenericType implements ChicoryType {
  constructor(public id: number, public name: string, public typeArguments: ChicoryType[]) {}

  toString() {
    if (this.typeArguments.length === 0) {
      return this.name;
    }
    const args = this.typeArguments.map((t) => t.toString()).join(", ");
    return `${this.name}<${args}>`;
  }
}

// Type Variable (For future use with type inference)
export class TypeVariable implements ChicoryType {
  constructor(public id: number, public name: string) {}
  toString() {
    return this.name;
  }
}

// String Literal Type
export class StringLiteralType implements ChicoryType {
  constructor(public value: string) {}
  toString() {
    return `"${this.value}"`; // Represent as "value"
  }
}

// Literal Union Type
export class LiteralUnionType implements ChicoryType {
  constructor(public values: Set<string>) {} // Store the actual string values
  toString() {
    return Array.from(this.values).map(v => `"${v}"`).join(" | ");
  }
}

// JSX Element Type
export class JsxElementType implements ChicoryType {
  // Represents the result of a JSX expression, holding the type of its expected props.
  constructor(public propsType: RecordType) {}
  toString() {
    const props = this.propsType.toString()
    const propsMessage = props.length > 23
      ? props.slice(0, 20) + "..."
      : props
    // Indicate the props type it expects
    return `JsxElement<${propsMessage}>`;
  }
}

// Unknown Type (For errors or incomplete type information)
export class UnknownTypeClass implements ChicoryType {
  static instance = new UnknownTypeClass();
  private constructor() {}
  toString() {
    return "unknown";
  }
}

// Constructor Definition (for ADTs)
export interface ConstructorDefinition {
  adtName: string;
  name: string;
  type: ChicoryType; // Can be FunctionType (if constructor takes args) or the ADT Type (if no args)
}

export function typesAreEqual(type1: ChicoryType, type2: ChicoryType): boolean {
  if (type1 === type2) {
    return true;
  }
  // TODO:
  // if (type1.kind !== type2.kind) {
  //     // Allow unifying a GenericType placeholder like 'T' with a concrete type during inference
  //     // This might need refinement based on how generics are fully handled.
  //     if (type1 instanceof TypeVariable || type2 instanceof TypeVariable) return true;
  //     if (type1 instanceof GenericType && type1.typeArguments.length === 0) return true;
  //     if (type2 instanceof GenericType && type2.typeArguments.length === 0) return true;

  //     return false;
  // }

  if (type1 instanceof RecordType && type2 instanceof RecordType) {
    if (type1.fields.size !== type2.fields.size) {
      return false;
    }

    // Compare fields based on type and optional flag
    for (const [key, field1] of type1.fields) {
      const field2 = type2.fields.get(key);
      if (!field2 || field1.optional !== field2.optional || !typesAreEqual(field1.type, field2.type)) {
        return false;
      }
    }
    return true;
  } else if (type1 instanceof TupleType && type2 instanceof TupleType) {
    if (type1.elementTypes.length !== type2.elementTypes.length) {
      return false;
    }
    for (let i = 0; i < type1.elementTypes.length; i++) {
      if (!typesAreEqual(type1.elementTypes[i], type2.elementTypes[i])) {
        return false;
      }
    }
    return true;
  } else if (type1 instanceof ArrayType && type2 instanceof ArrayType) {
    return typesAreEqual(type1.elementType, type2.elementType);
  } else if (type1 instanceof FunctionType && type2 instanceof FunctionType) {
    if (type1.paramTypes.length !== type2.paramTypes.length) {
      return false;
    }
    for (let i = 0; i < type1.paramTypes.length; i++) {
      if (!typesAreEqual(type1.paramTypes[i], type2.paramTypes[i])) {
        return false;
      }
    }
    return typesAreEqual(type1.returnType, type2.returnType);
  } else if (type1 instanceof AdtType && type2 instanceof AdtType) {
    return type1.name === type2.name;
  } else if (type1 instanceof GenericType && type2 instanceof GenericType) {
    if (
      type1.name !== type2.name ||
      type1.typeArguments.length !== type2.typeArguments.length
    ) {
      // Allow comparison if one has no args (placeholder) - refinement might be needed
      if (
        type1.typeArguments.length === 0 ||
        type2.typeArguments.length === 0
      ) {
        return type1.name === type2.name;
      }
      return false;
    }
    for (let i = 0; i < type1.typeArguments.length; i++) {
      if (!typesAreEqual(type1.typeArguments[i], type2.typeArguments[i])) {
        return false;
      }
    }
    return true;
  } else if (type1 instanceof TypeVariable && type2 instanceof TypeVariable) {
    return type1.id === type2.id; // Compare by ID for uniqueness
  } else if (type1 instanceof JsxElementType && type2 instanceof JsxElementType) {
    // Two JsxElement types are equal if their expected props types are equal
    return typesAreEqual(type1.propsType, type2.propsType);
  } else if (type1 instanceof StringLiteralType && type2 instanceof StringLiteralType) {
    return type1.value === type2.value;
  } else if (type1 instanceof LiteralUnionType && type2 instanceof LiteralUnionType) {
    if (type1.values.size !== type2.values.size) {
      return false;
    }
    for (const val of type1.values) {
      if (!type2.values.has(val)) {
        return false;
      }
    }
    return true;
  }
  // Cross-type comparisons (e.g., StringLiteralType vs LiteralUnionType) are handled by unification, not equality.
  return false;
}

// Singleton instances for primitive types
export const StringType = StringTypeClass.instance;
export const NumberType = NumberTypeClass.instance;
export const BooleanType = BooleanTypeClass.instance;
export const UnitType = UnitTypeClass.instance;
export const UnknownType = UnknownTypeClass.instance;

// --- Specific ADT for CSS Display Property ---
export const DisplayTypeAdt = new AdtType("DisplayType");
// --- End DisplayType ADT ---

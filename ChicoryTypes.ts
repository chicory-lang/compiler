import { ParserRuleContext } from 'antlr4ng';

export interface ChicoryType {
    toString(): string; // For easy debugging and hint display
}

// Primitive Types
export class StringTypeClass implements ChicoryType {
    static instance = new StringTypeClass();
    private constructor() {} // Make constructor private to enforce singleton
    toString() { return "string"; }
}

export class NumberTypeClass implements ChicoryType {
    static instance = new NumberTypeClass();
    private constructor() {}
    toString() { return "number"; }
}

export class BooleanTypeClass implements ChicoryType {
    static instance = new BooleanTypeClass();
    private constructor() {}
    toString() { return "boolean"; }
}

export class UnitTypeClass implements ChicoryType {  // Represents 'void' or '()'
    static instance = new UnitTypeClass();
    private constructor() {}
    toString() { return "unit"; }
}

// Function Type
export class FunctionType implements ChicoryType {
    constructor(public paramTypes: ChicoryType[], public returnType: ChicoryType, public constructorName?: string) {}
    toString() {
        if (this.constructorName) {
            return `${this.returnType} ~> ${this.constructorName}`
        }
        const params = this.paramTypes.map(p => p.toString()).join(", ");
        return `(${params}) => ${this.returnType.toString()}`;
    }
}

// Record Type
export class RecordType implements ChicoryType {
    constructor(public fields: Map<string, ChicoryType>) {}
    toString() {
        const fieldStrings = Array.from(this.fields.entries())
            .map(([key, value]) => `${key}: ${value.toString()}`);
        return `{ ${fieldStrings.join(", ")} }`;
    }
}

// Tuple Type
export class TupleType implements ChicoryType {
    constructor(public elementTypes: ChicoryType[]) {}
    toString() {
        return `[${this.elementTypes.map(e => e.toString()).join(", ")}]`;
    }
}

// ADT Type
export class AdtType implements ChicoryType {
    constructor(public name: string) {}
    toString() { return this.name; }
}

// Generic Type (Simplified for now)
export class GenericType implements ChicoryType {
    constructor(public name: string, public typeArguments: ChicoryType[]) {}
    
    toString() {
        if (this.typeArguments.length === 0) {
            return this.name;
        }
        const args = this.typeArguments.map(t => t.toString()).join(", ");
        return `${this.name}(...${args})`;
    }
}

// Type Variable (For future use with type inference)
export class TypeVariable implements ChicoryType {
    constructor(public name: string) {}
    toString() { return this.name; }
}

// Unknown Type (For errors or incomplete type information)
export class UnknownTypeClass implements ChicoryType {
    static instance = new UnknownTypeClass();
    private constructor() {}
    toString() { return "unknown"; }
}

// Constructor Definition (for ADTs)
export interface ConstructorDefinition {
    adtName: string;
    name: string;
    type: ChicoryType; // Can be FunctionType (if constructor takes args) or the ADT Type (if no args)
}

export function typesAreEqual(type1: ChicoryType, type2: ChicoryType): boolean {
    if (type1 === type2) {
        return true
    }

    if (type1 instanceof RecordType && type2 instanceof RecordType) {
        if (type1.fields.size !== type2.fields.size) {
            return false;
        }

        for (const [key, value] of type1.fields) {
            const value2 = type2.fields.get(key);
            if (!value2 || !typesAreEqual(value, value2)) {
                return false;
            }
        }
        return true;
    }
    else if (type1 instanceof TupleType && type2 instanceof TupleType) {
        if (type1.elementTypes.length !== type2.elementTypes.length) {
            return false;
        }
        for (let i = 0; i < type1.elementTypes.length; i++) {
            if (!typesAreEqual(type1.elementTypes[i], type2.elementTypes[i])) {
                return false;
            }
        }
        return true;
    }
    else if (type1 instanceof FunctionType && type2 instanceof FunctionType) {
        if (type1.paramTypes.length !== type2.paramTypes.length) {
            return false;
        }
        for (let i = 0; i < type1.paramTypes.length; i++) {
            if (!typesAreEqual(type1.paramTypes[i], type2.paramTypes[i])) {
                return false;
            }
        }
        return typesAreEqual(type1.returnType, type2.returnType);
    }
    else if (type1 instanceof AdtType && type2 instanceof AdtType) {
        return type1.name === type2.name;
    }
    else if (type1 instanceof GenericType && type2 instanceof GenericType) {
        return type1.name === type2.name;
    }
    else if (type1 instanceof TypeVariable && type2 instanceof TypeVariable) {
        return type1.name === type2.name;
    }

    return false;
}

// Singleton instances for primitive types
export const StringType = StringTypeClass.instance;
export const NumberType = NumberTypeClass.instance;
export const BooleanType = BooleanTypeClass.instance;
export const UnitType = UnitTypeClass.instance;
export const UnknownType = UnknownTypeClass.instance;
import { expect, test } from 'vitest';
import { compile } from '../compile';

test('Function type definitions', () => {
    const code = `
type SimpleFunc = () => number
type FuncWithParams = (number, string) => boolean
type NestedFunc = (number) => (string) => boolean

export {}
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('Function type with named parameters', () => {
    const code = `
type NamedParamFunc = (x: number, y: string) => boolean

export {}
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('Function type with unit return type', () => {
    const code = `
type VoidFunc = (number) => unit

export {}
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('Function type used in variable declaration', () => {
    const code = `
type Callback = (number) => string

const myFunc = (x) => {
    return x + 1
}

const myCallback = myFunc

export {}
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('Function type with complex return type', () => {
    const code = `
type RecordReturningFunc = (number) => { result: number, error: string }
type TupleReturningFunc = (string) => [number, boolean]

export {}
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

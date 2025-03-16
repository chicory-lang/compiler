import { expect, test } from "bun:test";
import compile from "../compile";

test('Function type definitions', () => {
    const code = `
type SimpleFunc = () => number
type FuncWithParams = (number, string) => boolean
type NestedFunc = (number) => (string) => boolean
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('Function type with named parameters', () => {
    const code = `
type NamedParamFunc = (x: number, y: string) => boolean
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('Function type with unit return type', () => {
    const code = `
type VoidFunc = (number) => unit
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('Function type used in variable declaration', () => {
    const code = `
type Callback = (number) => number

const double = (x) => x * 2

const myCallback = double
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('Function type with complex return type', () => {
    const code = `
type RecordReturningFunc = (number) => { result: number, error: string }
type TupleReturningFunc = (string) => [number, boolean]
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('String concatenation with + operator', () => {
    const code = `
const greeting = "Hello"
const name = "World"
const message = greeting + " " + name

const num = 42
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

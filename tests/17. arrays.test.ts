import { expect, test } from "bun:test";
import compile from "../compile";

test('should handle array literals', () => {
    const code = `const a = [1, 2, 3]`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('should handle empty array literals', () => {
    const code = `const a = []`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('should handle array literals with type annotation', () => {
    const code = `const a: string[] = ["test"]`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('should give errors with array literal and wrong type annotation', () => {
    const code = `const a: string[] = [123]`;
    const result = compile(code);
    expect(result.errors).toHaveLength(1);
});

test('should handle array of strings', () => {
    const code = `const a: string[] = ["a", "b", "c"]`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('should handle array of numbers', () => {
    const code = `const a: number[] = [1,2,3,4.0]`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('should handle array of booleans', () => {
    const code = `const a: boolean[] = [true, false, true]`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('should not allow array of mixed types', () => {
    const code = `const a: string[] = [true, 1]`;
    const result = compile(code);
    expect(result.errors).toHaveLength(1);
});

test('should allow indexing and return an option', () => {
    const code = `const a: string[] = ["a", "b"]
match (a[0]) {
    Some("a") => "Yay"
    _ => "Nay"
}`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

// // TODO: check for NONE...
// test('should allow indexing out of bounds and return None', () => {
//     const code = `const a: string[] = ["a", "b"]
// match (a[3]) {
//     "a" => "Yay"
//     _ => "Nay"
// }`;
//     const result = compile(code);
//     expect(result.errors).toHaveLength(1);
// });

// TODO: add tests for map, filter, find ...
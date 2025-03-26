import { expect, test } from "bun:test";
import compile from "../compile";

test('should allow annotating types', () => {
    const code = `const a: string = "test"`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('should give an error for the wrong type', () => {
    const code = `const a: number = "test"`;
    const result = compile(code);
    expect(result.errors).toHaveLength(1);
});
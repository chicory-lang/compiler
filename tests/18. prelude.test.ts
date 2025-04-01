import { expect, test } from "bun:test";
import compile from "../compile";

test('Ensure that prelude is included (option)', () => {
    const code = `const a = Some("test")`;
    const result = compile(code);
    expect(result.code).toBe(`const Some = (value) => ({ type: "Some", value });
const None = () => ({ type: "None" });
const a = Some("test");`);
});
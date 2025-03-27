import { expect, test } from "bun:test";
import compile from "../compile";

test("let assign number", () => {
  const { code } = compile("let a = 1");
  expect(code).toBe("let a = 1;");
});

test("const assign number", () => {
  const { code } = compile("const b = 20");
  expect(code).toBe("const b = 20;");
});

test("let assign float", () => {
  const { code } = compile("let c = 3.14");
  expect(code).toBe("let c = 3.14;");
});

test("const assign string", () => {
  const { code } = compile(`const d = "hello"`);
  expect(code).toBe(`const d = "hello";`);
});

test("let assign boolean", () => {
  const { code } = compile("let e = true");
  expect(code).toBe("let e = true;");
});


test("record destructuring assignment", () => {
  const { code } = compile("let { a, b, c } = {a:true, b:2, c: \"three\"}");
  expect(code).toBe("let { a, b, c } = { a: true, b: 2, c: \"three\" };");
});

test("record destructuring assignment (partial)", () => {
  const { code, errors } = compile("let { a } = {a:true, b:2, c: \"three\"}");
  expect(code).toBe("let { a } = { a: true, b: 2, c: \"three\" };");
  expect(errors.length).toBe(0)
});

test("array destructuring assignment", () => {
  const { code, errors } = compile("let [a, b, c] = [true, false, true]");
  expect(code).toBe("let [ a, b, c ] = [true, false, true];");
  expect(errors.length).toBe(0)
});

test("array destructuring assignment (partial)", () => {
  const { code, errors } = compile("const [a] = [true, false, true]");
  expect(code).toBe("const [ a ] = [true, false, true];");
  expect(errors.length).toBe(0)
});

test("tuple destructuring assignment", () => {
  const { code, errors } = compile("let [a, b, c] = [true, \"false\", 3]");
  expect(code).toBe("let [ a, b, c ] = [true, \"false\", 3];");
  expect(errors.length).toBe(0)
});
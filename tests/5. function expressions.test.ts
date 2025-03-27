import { expect, test } from "bun:test";
import compile from "../compile";

test("function expr", () => {
  const { code } = compile(`() => {
 let a = 1
 if (a) { "1" } else { "2" }
}`);
  expect(code).toBe(`() => {
    let a = 1;
    return (a) ? (() => {
        return "1";
    })() : (() => {
        return "2";
    })();
};`);
});

test("single param function expr (without parens)", () => {
  const { code } = compile(`const a = b => 2`);
  expect(code).toBe(`const a = (b) => 2;`);
});

test("single param function expr with block expr", () => {
  const { code } = compile(`const a = b => {
    let a = 1
    if (a == 1) { "1" } else { "2" }
  }`);
  expect(code).toBe(`const a = (b) => {
    let a = 1;
    return (a == 1) ? (() => {
        return \"1\";
    })() : (() => {
        return \"2\";
    })();
};`);
});
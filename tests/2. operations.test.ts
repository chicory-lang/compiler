import { expect, test } from "bun:test";
import compile from "../compile";

test("numeric subtraction", () => {
  const { code } = compile(`let a = 1 - 2.3`);
  expect(code).toBe(`let a = 1 - 2.3;`);
});

test("string concatentation", () => {
  const { code } = compile(`"asdkfl" + "asdf"`);
  expect(code).toBe(`"asdkfl" + "asdf";`);
});

test("addition with identifier", () => {
  const { code } = compile(`1231 + i_am_an_identifier`);
  expect(code).toBe(`1231 + i_am_an_identifier;`);
});

test("cannot coerce numbers and strings", () => {
  const { errors } = compile(`1231 + "i_am_an_identifier"`);
  expect(errors).toHaveLength(1);
})
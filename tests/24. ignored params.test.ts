import { expect, test } from "bun:test";
import compile from "../compile"; // Adjust path as needed

test("should allow ignored params", () => {
    // onClick expects a function that returns void, the provided function returns 123
  const chicoryCode = `const a = [1,2,3]
  const b = a.map((_, i) => i + 1)`;
  const { code, errors, hints } = compile(chicoryCode);

  expect(errors.length).toBe(0)
});

test("should automatically ignore params", () => {
    // onClick expects a function that returns void, the provided function returns 123
  const chicoryCode = `const a = [1,2,3]
  const b = a.map((i) => i + 1)`; // i.e., a.map((i, _) => i + 1)
  const { code, errors, hints } = compile(chicoryCode);

  expect(errors.length).toBe(0)
});
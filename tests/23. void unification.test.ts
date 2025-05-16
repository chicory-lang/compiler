import { expect, test } from "bun:test";
import compile from "../compile"; // Adjust path as needed

test("should allow unifying void with a function with a return value", () => {
    // onClick expects a function that returns void, the provided function returns 123
  const chicoryCode = `const a = () => <button onClick={(e) => 123}></button>`;
  const { code, errors, hints } = compile(chicoryCode);

  expect(errors.length).toBe(0)
});

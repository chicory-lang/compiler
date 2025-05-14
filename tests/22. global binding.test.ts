import { expect, test } from "bun:test";
import compile from "../compile"; // Adjust path as needed

test("should parse a global binding", () => {
  const chicoryCode = `
      global console as {
        log: (T) => void
      }
    `;
  // Expecting errors initially as JSX type checking isn't fully implemented
  const { code, errors, hints } = compile(chicoryCode);

  expect(errors.length).toBe(0)
});

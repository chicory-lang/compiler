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

test("should parse a global binding with a function expression", () => {
  const chicoryCode = `
  bind {
       useState as (T) => [T, (T) => void]
   } from "react"

   const [items, setItems] = useState([])

   // First use of setItems. This should infer that "items" is string[].
   setTodos(["hello"])

   // Second use of setItems. This should fail if the type of "items"
   // was not correctly constrained to string[].
   setTodos([123])
    `;
  // Expecting errors initially as JSX type checking isn't fully implemented
  const { code, errors, hints } = compile(chicoryCode);

  expect(errors.length).toBeGreaterThan(0)
});
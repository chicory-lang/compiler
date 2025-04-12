import { expect, test } from "bun:test";
import compile from "../compile"; // Adjust path as needed
import {
  StringType,
  NumberType,
  GenericType,
} from "../ChicoryTypes"; // Adjust path

test("should define and typecheck record with optional field", () => {
  const chicoryCode = `
      type User = {
        id: number,
        name?: string // Optional field
      }

      let user1: User = { id: 1, name: Some("Alice") } // Note that name is expected to be an Option<string>
      let user2: User = { id: 2 } // name is omitted, should be valid

      // Accessing optional field should yield Option<string>
      let name1 = user1.name
      let name2 = user2.name
    `;
  const { code, errors, hints } = compile(chicoryCode);

  expect(errors).toHaveLength(0);

  // Check hints for inferred types (adjust hint structure if needed)
  const name1Hint = hints.find(
    (h) => h.range.start.line === 10 && h.range.start.character === 10
  ); // 'name1' variable
  const name2Hint = hints.find(
    (h) => h.range.start.line === 11 && h.range.start.character === 10
  ); // 'name2' variable

  // Assuming Option<string> stringifies correctly
  const expectedOptionStringType = new GenericType(42, "Option", [
    StringType,
  ]).toString();
  expect(name1Hint?.type).toBe(expectedOptionStringType);
  expect(name2Hint?.type).toBe(expectedOptionStringType);

  // Basic check that code compiles
  expect(code).toContain('let user1 = { id: 1, name: Some("Alice") };');
  expect(code).toContain("let user2 = { id: 2, name: None() };");
});

test("should fail typecheck if required field is missing", () => {
  const chicoryCode = `
      type User = {
        id: number, // Required field
        name?: string
      }

      let user: User = { name: Some("Bob") } // Should give error for missing 'id'
    `;
  const { errors } = compile(chicoryCode);
  // This error might come from the assignment check, not the type definition itself
  // The exact error message might vary.
  expect(errors.length).toBe(1);
  expect(
    errors.some(
      (e) => e.message.includes("Missing") && e.message.includes("'id'")
    )
  ).toBe(true);
});

test("should fail typecheck if optional field assigned wrong type", () => {
  const chicoryCode = `
      type Config = {
        timeout?: number,
        retries: number
      }

      let config: Config = { retries: 3, timeout: 500 } // 'timeout' should be Option<number>
    `;
  const { errors } = compile(chicoryCode);
  expect(errors.length).toBeGreaterThan(0);
  // Check for a type mismatch error related to 'timeout'
  expect(
    errors.some(
      (e) =>
        e.message.includes("Option<number>") && e.message.includes("number")
    )
  ).toBe(true);
});

test("should work with match on optional field", () => {
  const chicoryCode = `
      type User = { id: number, name?: string }
      let u1: User = { id: 1 }
      let u2: User = { id: 2, name: Some("Charlie") }

      let greeting1 = match (u1.name) {
        Some(n) => "Hello, " + n
        None => "Hello, guest"
      }

      let greeting2 = match (u2.name) {
        Some(n) => "Hello, " + n
        None => "Hello, guest"
      }
    `;
  const { code, errors, hints } = compile(chicoryCode);
  expect(errors).toHaveLength(0);

  // Check inferred type of greetings (should be string)
  const greeting1Hint = hints.find(
    (h) => h.range.start.line === 5 && h.range.start.character === 10
  );
  const greeting2Hint = hints.find(
    (h) => h.range.start.line === 10 && h.range.start.character === 10
  );
  console.log("GG", greeting1Hint, greeting2Hint)
  expect(greeting1Hint?.type).toBe(StringType.toString());
  expect(greeting2Hint?.type).toBe(StringType.toString());
});

test("should work with generic optional fields", () => {
  const chicoryCode = `
        type Box<T> = { value?: T, label: string }

        let b1: Box<number> = { label: "Age", value: Some(30) }
        let b2: Box<number> = { label: "Count" }
        let b3: Box<string> = { label: "Message", value: Some("Hi") }

        let val1 = b1.value // Option<number>
        let val2 = b2.value // Option<number>
        let val3 = b3.value // Option<string>
      `;
  const { errors, hints } = compile(chicoryCode);
  expect(errors).toHaveLength(0);

  const val1Hint = hints.find(
    (h) => h.range.start.line === 7 && h.range.start.character === 12
  );
  const val2Hint = hints.find(
    (h) => h.range.start.line === 8 && h.range.start.character === 12
  );
  const val3Hint = hints.find(
    (h) => h.range.start.line === 9 && h.range.start.character === 12
  );

  expect(val1Hint?.type).toBe(
    new GenericType(1, "Option", [NumberType]).toString()
  );
  expect(val2Hint?.type).toBe(
    new GenericType(2, "Option", [NumberType]).toString()
  );
  expect(val3Hint?.type).toBe(
    new GenericType(3, "Option", [StringType]).toString()
  );
});

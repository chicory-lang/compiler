import { expect, test } from "bun:test";
import compile from "../compile"; // Adjust path as needed
import { StringType, NumberType, GenericType } from "../ChicoryTypes"; // Adjust path

test("should define and typecheck record with optional field", () => {
  const chicoryCode = `
      type User = {
        id: number,
        name?: string // Optional field
      }

      let user1: User = { id: 1, name: "Alice" } // Note that name is expected to be a string when being defined, but is accessed as an Option
      let user2: User = { id: 2 } // name is omitted, should be valid

      // Accessing optional field should yield Option<string>
      let name1 = user1.name
      let name2 = user2.name

      match (name1) {
        Some(n) => n
        None => "Unknown"
      }
      match (name2) {
        Some(n) => n
        None => "Unknown"
      }
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
  expect(name1Hint?.type).toBe("Option<string>");
  expect(name2Hint?.type).toBe("Option<string>");

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

      let user: User = { name: "Bob" } // Should give error for missing 'id'
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

test("should work with match on optional field", () => {
  const chicoryCode = `
      type User = { id: number, name?: string }
      let u1: User = { id: 1 }
      let u2: User = { id: 2, name: "Charlie" }

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
  console.log("GG", greeting1Hint, greeting2Hint);
  expect(greeting1Hint?.type).toBe(StringType.toString());
  expect(greeting2Hint?.type).toBe(StringType.toString());
});

test("should work with generic optional fields", () => {
  const chicoryCode = `
        type Box<T> = { value?: T, label: string }

        let b1: Box<number> = { label: "Age", value: 30 }
        let b2: Box<number> = { label: "Count" }
        let b3: Box<string> = { label: "Message", value: "Hi" }

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

  expect(val1Hint?.type).toBe("Option<number>");
  expect(val2Hint?.type).toBe("Option<number>");
  expect(val3Hint?.type).toBe("Option<string>");
});

test("should add None() for missing optional field in ADT constructor arg", () => {
  const chicoryCode = `
type UserProfile = {
  name?: string,
  age: number
}

type User =
  | LoggedIn(UserProfile)
  | Guest

// 'name' is omitted, compiler should add 'name: None()'
let u: User = LoggedIn({ age: 30 })

let nameIsNone = match (u) {
  LoggedIn(p) => match (p.name) {
    Some(_) => false
    None => true
  }
  Guest => false // Should not happen
}
  `.trim();
  const { code, errors } = compile(chicoryCode);

  // Check for type errors
  expect(errors).toHaveLength(0);

  // Check compiled code for the LoggedIn call
  // It should look like: const u = LoggedIn({ age: 30, name: None() });
  expect(code).toContain("LoggedIn({ age: 30, name: None() })");
});

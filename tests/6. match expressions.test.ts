import { expect, test } from "bun:test";
import compile from "../compile";

test("match an ADT", () => {
  const { code } = compile(`match (a) {
    None => { "nothing" },
    Some(42) => { "forty two" },
    Some(x) => {
        if (x == 10) {
            "ten"
        } else {
            "small"
        }
    }
}`);
  expect(code).toBe(`(() => {
    const __chicory_var_0 = a;
    if (__chicory_var_0.type === "None") {
        return "nothing";
    }
    else if (__chicory_var_0.type === "Some" && __chicory_var_0.value === 42) {
        return "forty two";
    }
    else if (__chicory_var_0.type === "Some") {
        const x = __chicory_var_0.value;
        return (x == 10) ? (() => {
            return "ten";
        })() : (() => {
            return "small";
        })();
    }
})();`);
});

test("match a string literal", () => {
  const { code } = compile(`match (b) {
    "hi" => { "hello" },
    "bye" => { "goodbye" },
    _ => { "what?" }
}`);
  expect(code).toBe(`(() => {
    const __chicory_var_0 = b;
    if (__chicory_var_0 === "hi") {
        return "hello";
    }
    else if (__chicory_var_0 === "bye") {
        return "goodbye";
    }
    else if (true) {
        return "what?";
    }
})();`);
});

test("Ensure coverage for Option type", () => {
  const { code, errors } = compile(`match (Some("test")) {
      None => { "nothing" }
      Some("42") => { "forty two" }
      // Some(x) => "any other value"
  }`);
  expect(errors.length).toBe(1);
});

test("Ensure coverage for ADT", () => {
  const { code, errors } = compile(`
        type Test = One | Two
        match (One) {
            One => "yup"
            // Two => "nope
        }`);
  expect(errors.length).toBe(1);
});

test("Ensure return types are consistent", () => {
  const code = `match ("str") {
    "str" => "1"
    _ => 2
  }`;
  const result = compile(code);
  // We expect an error because one arm returns a string and the other returns a number
  expect(result.errors).toHaveLength(1);
});

test("Ensure return types are consistent when return is an ADT", () => {
  const code = `match ("str") {
      "str" => Ok("success")
      _ => Err(123)
    }`;
  const result = compile(code);
  // This is allowed because Ok and Err can have different types (but they must flow through so that Result<T,U> is consistent for this type)
  expect(result.errors).toHaveLength(0);
});

test("Ensure return types are consistent when return is an ADT (non matching ok)", () => {
  const code = `match ("str") {
        "str" => Ok("success")
        "str2" => Ok(123)
        _ => Err(123)
      }`;
  const result = compile(code);
  // This is not allowed because Ok() does not have a consistent type
  expect(result.errors).toHaveLength(1);
});

test("Ensure return types are consistent when return is an ADT (non matching err)", () => {
  const code = `match ("str") {
          "str" => Ok("success")
          "str2" => Err("asdf")
          _ => Err(123)
        }`;
  const result = compile(code);
  // This is not allowed because Err() does not have a consistent type
  expect(result.errors).toHaveLength(1);
});

test("Inexhaustive matches should not type check", () => {
    const code = `match ("str") {
        "str" => "there are 'infinitely' many strings..."
        "str2" => "so there has to be a wildcard/param here..."
      }`;
    const result = compile(code);
    expect(result.errors).toHaveLength(1);
})

test("Inexhaustive string matches should not type check (inferred as string)", () => {
  const code = `
    const toString = s => match (s) {
      "str" => 1
      "str2" => 2
    }`;
  const result = compile(code);
  // should fail exhaustiveness check without a param/wildcard arm
  expect(result.errors).toHaveLength(1);
})
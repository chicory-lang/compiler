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
    const { code,errors } = compile(`match (Some("test")) {
      None => { "nothing" }
      Some("42") => { "forty two" }
      // Some(x) => "any other value"
  }`);  
  expect(errors.length).toBe(1)
});
  
test("Ensure coverage for ADT", () => {
    const { code,errors } = compile(`
        type Test = One | Two
        match (One) {
            One => "yup"
            // Two => "nope
        }`);
  expect(errors.length).toBe(1)
});
  
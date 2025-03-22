

import { expect, test } from "bun:test";
import compile from "../compile";

test('Generic type definitions', () => {
    const code = `
type Option<T> = Some(T) | None

let v = match(Some("hi!")) {
    Some("x") => "asdf"
    Some(_) => "asdf2"
    None => { "nothing" }   
}`;
    const result = compile(code);
    // all possibilities are covered so it should have no errors
    expect(result.errors).toHaveLength(0);
});

test('Generic type definitions', () => {
    const code = `
type Option<T> = Some(T) | None

let v = match(Some("hi!")) {
    Some("x") => "asdf"
    None => { "nothing" }   
}`;
    const result = compile(code);
    // missing Some(*)
    expect(result.errors).toHaveLength(1);
});
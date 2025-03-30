

import { expect, test } from "bun:test";
import compile from "../compile";

test('Cases in match with generic type (covered)', () => {
    const code = `
let v = match(Some("hi!")) {
    Some("x") => "asdf"
    Some(_) => "asdf2"
    None => { "nothing" }   
}`;
    const result = compile(code);
    // all possibilities are covered so it should have no errors
    expect(result.errors).toHaveLength(0);
});

test('Cases in match with generic type (not exhaustively covered)', () => {
    const code = `
let v = match(Some("hi!")) {
    Some("x") => "asdf"
    None => { "nothing" }   
}`;
    const result = compile(code);
    // missing Some(*)
    expect(result.errors).toHaveLength(1);
});

test('Cases in result type', () => {
  const code = `
let v = match(Ok("hi!")) {
  Ok(str) => "val: " + str
  Err(int) => "err"
}`;
  const result = compile(code);
  // all possibilities are covered so it should have no errors
  expect(result.errors).toHaveLength(0);
});

test('Cases in match expr (covered by wildcard)', () => {
    const code = `
type User =
  | LoggedIn(string)
  | Guest

const u = LoggedIn("Luke")

const welcomeText = match(u) {
  LoggedIn("Luke") => "Welcome, Mr Skywalker"
  LoggedIn(_) => "Hi " + "you"
  Guest => "Welcome New User!"
}`;
    const result = compile(code);
    // All cases covered
    expect(result.errors).toHaveLength(0);
});


test('Cases in match expr (covered by param)', () => {
    const code = `
type User =
  | LoggedIn(string)
  | Guest

const u = LoggedIn("Luke")

const welcomeText = match(u) {
  LoggedIn("Luke") => "Welcome, Mr Skywalker"
  LoggedIn(name) => "Hi " + name
  Guest => "Welcome New User!"
}`;
    const result = compile(code);
    // All cases covered
    expect(result.errors).toHaveLength(0);
});


test('Cases in match expr with ADT containing record (covered by wildcard)', () => {
    const code = `
type Person = {name: string}
type User =
  | LoggedIn(Person)
  | Guest

const u = LoggedIn({name: "Luke"})

const welcomeText = match(u) {
  LoggedIn(_) => "Hi user"
  Guest => "Welcome New User!"
}`;
    const result = compile(code);
    // All cases covered
    expect(result.errors).toHaveLength(0);
});


test('Cases in match expr with ADT containing record (covered by param)', () => {
    const code = `
type Person = {name: string}
type User =
  | LoggedIn(Person)
  | Guest

const u = LoggedIn({name: "Luke"})

const welcomeText = match(u) {
  LoggedIn(p) => "Hi " + p.name
  Guest => "Welcome New User!"
}`;
    const result = compile(code);
    // All cases covered
    expect(result.errors).toHaveLength(0);
});


test('Cases in match expr against result type with Ok(T), Err(U) and T != U', () => {
  const code = `match (Err(1)) {
  Ok(2) => { "int" }
  Ok(_) => "any other value"
  Err(i) => {
    const y = i + 1
    "e"
  }
}`;
  const result = compile(code);
  // We expect an error because Ok(number) and Ok(string) shouldn't be unifiable
  expect(result.errors).toHaveLength(0);
});

test('Cases in match expr against result that imply inconsistent T in Ok(T)', () => {
  const code = `match (Err(1)) {
  Ok(2) => "int"
  Ok("2") => "str"
  Ok(_) => "any other value"
  Err(_) => "e"
}`;
  const result = compile(code);
  // We expect an error because Ok(number) and Ok(string) shouldn't be unifiable
  expect(result.errors).toHaveLength(1);
});

test('Cases in match expr against result that imply inconsistent U in Err(U)', () => {
  const code = `match (Err(1)) {
  Ok(_) => "any other value"
  Err(1) => "e"
  Err("2") => "e"
  Err(_) => "e"
}`;
  const result = compile(code);
  // We expect an error because Ok(number) and Ok(string) shouldn't be unifiable
  expect(result.errors).toHaveLength(1);
});
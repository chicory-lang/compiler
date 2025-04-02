

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

test('Should be able to do a `useState` with a Result ADT', () => {
  const code = `bind {
  useState as (T) => [T, (T) => void]
} from "react"

const [result, setResult] = useState(Ok(0))

match (result) {
  Err(_) => "Error can match"
  _ => "Anything can match"
}
`;
  const result = compile(code);
  expect(result.errors).toHaveLength(0);
})

test('Cases in match expr against custom option-like adt', () => {
  const code = `type MyOpt<T> = MySome(T) | MyNone
match (MySome(1)) {
  MySome(2) => { "int" }
  MyNone => {
    const y = 5 + 1
    "e"
  }
}`;
  const result = compile(code);
  // We expect an error because MySome(2) does not cover MySome(*)
  expect(result.errors).toHaveLength(1);
});


test('Cases in match expr against custom option-like adt (covered by param)', () => {
  const code = `type MyOpt<T> = MySome(T) | MyNone
match (MySome(1)) {
  MySome(p) => { "hi" }
  MyNone => "hi"
}`;
  const result = compile(code);
  // We expect an error because MySome(2) does not cover MySome(*)
  expect(result.errors).toHaveLength(0);
});


test('Cases in match expr against custom option-like adt (covered by wildcard)', () => {
  const code = `type MyOpt<T> = MySome(T) | MyNone
match (MySome(1)) {
  MySome(_) => { "int" }
  MyNone => "e"
}`;
  const result = compile(code);
  expect(result.errors).toHaveLength(0);
});


test('Unreachable arm (wildcard coverage)', () => {
  const code = `match (Some(1)) {
  Some(_) => "wildcard in Some matches every kind of Some"
  Some(1) => "cannot be reached, because all possible Some(*) matches are covered"
  None => "e"
}`;
  const result = compile(code);
  expect(result.errors).toHaveLength(1);
});

test('Unreachable arm with (param coverage)', () => {
  const code = `match (Some(1)) {
  Some(a) => "param in Some matches every kind of Some"
  Some(_) => "cannot be reached, because all possible Some(*) matches are covered"
  None => "e"
}`;
  const result = compile(code);
  expect(result.errors).toHaveLength(1);
});

test('Unreachable arm (duplicate coverage)', () => {
  const code = `match (Some(1)) {
  Some(a) => "param in Some matches every kind of Some"
  None => "none match"
  None => "duplicated none match"
}`;
  const result = compile(code);
  expect(result.errors).toHaveLength(1);
});

test('Unreachable arm (strings w/ wildcard)', () => {
  const code = `match ("str") {
  _ => "wildcard in Some matches every kind of Some"
  "str" => "cannot be reached, because all possible Some(*) matches are covered"
}`;
  const result = compile(code);
  expect(result.errors).toHaveLength(1);
});

test('Unreachable arm (strings w/ param)', () => {
  const code = `match ("str") {
  a => "wildcard in Some matches every kind of Some"
  "str" => "cannot be reached, because all possible Some(*) matches are covered"
}`;
  const result = compile(code);
  expect(result.errors).toHaveLength(1);
});


test('Nullary ADT (covered)', () => {
  const code = `type Friend = Greg | Jeremy
const strTest = friend => match (friend) {
  Greg => 1
  Jeremy => 2
}`;
  const result = compile(code);
  expect(result.errors).toHaveLength(0);
});

test('Nullary ADT (not covered)', () => {
  const code = `type Friend = Greg | Jeremy | Peter
const strTest = friend => match (friend) {
  Greg => 1
  Jeremy => 2
}`;
  const result = compile(code);
  // Missing Peter
  expect(result.errors).toHaveLength(1);
});
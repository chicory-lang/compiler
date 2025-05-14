import { expect, test } from "bun:test";
import compile from "../compile";

test("primitive type", () => {
  const { code } = compile(`type MyPrimitiveType = string`);
  expect(code).toBe(`/* Type Erasure: MyPrimitiveType */`);
});

test("record type", () => {
  const { code } = compile(`type MyRecord = {
  name: str,
  age: int,
}`);
  expect(code).toBe(`/* Type Erasure: MyRecord */`);
});

test("tuple type", () => {
  const { code } = compile(`type MyTuple = [int, str, Person]`);
  expect(code).toBe(`/* Type Erasure: MyTuple */`);
});

test("enum type", () => {
  const { code } = compile(`type MyEnum = Option1 | Option2 | Option3`);
  expect(code).toBe(`const Option1 = () => { return { type: "Option1" }; };
const Option2 = () => { return { type: "Option2" }; };
const Option3 = () => { return { type: "Option3" }; };`);
});

test("adt type", () => {
  const { code } = compile(`type MyAdt = 
    | ValueA(string)
    | ValueB({width: number, height: number})
    | ValueC(SomeType)
    | ValueD`);
  expect(code).toBe(`const ValueA = (value) => { return { type: "ValueA", value }; };
const ValueB = (value) => { return { type: "ValueB", value }; };
const ValueC = (value) => { return { type: "ValueC", value }; };
const ValueD = () => { return { type: "ValueD" }; };`);
});

test("Should produce error if non-existent type is used in definition", () => {
  const { errors } = compile(`type MyAdt = {
  x: number,
  y: string,
  z: SomeType,
}`);
  expect(errors.length).toBe(1);
});

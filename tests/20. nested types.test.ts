import { expect, test } from "bun:test";
import compile from "../compile";

test("Types can contain options", () => {
  const { errors } = compile(`type User = {
  id: number,
  name: Option<string>
}

const u: User = { id: 1, name: None }
`);
  expect(errors.length).toBe(0)
});
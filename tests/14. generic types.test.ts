import { expect, test } from "bun:test";
import compile from "../compile";

test('Generic type definitions', () => {
    const code = `
type Box<T> = { value: T }
type Pair<A, B> = [A, B]
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('Generic function types', () => {
    const code = `
type Identity<T> = (T) => T
type Mapper<A, B> = (A) => B
type StateUpdater<T> = (T) => void
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('Nested generic types', () => {
    const code = `
type Box<T> = { value: T }
type BoxOfBoxes<T> = Box<T>
type BoxesAllTheWayDown<T> = BoxOfBoxes<Box<T>>
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('Generic types with complex structures', () => {
    const code = `
type State<S, A> = { state: S, actions: A }
type Reducer<S, A> = (S, A) => S
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('React-like useState type', () => {
    const code = `
type State<T> = [T, (T) => void]
type UseState<T> = (T) => State<T>
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test("Should allow instantiating generics in multiple ways", () => {
  const chicoryCode = `
   bind {
       useState as (T) => [T, (T) => void]
   } from "react"

   const [str, setStr] = useState("")
   const newStr = str + "a"
   const [num, setNum] = useState(1)
   const newNum = num + 1
    `;
  // Expecting errors initially as JSX type checking isn't fully implemented
  const { code, errors, hints } = compile(chicoryCode);

  expect(errors.length).toBe(0)
});

test("Should allow instantiate generics in multiple ways and error when misused", () => {
  const chicoryCode = `
   bind {
       useState as (T) => [T, (T) => void]
   } from "react"

   const [str, setStr] = useState("")
   const newStr = str + 1
   const [num, setNum] = useState(1)
   const newNum = num + "1"
    `;
  // Expecting errors initially as JSX type checking isn't fully implemented
  const { code, errors, hints } = compile(chicoryCode);

  expect(errors.length).toBeGreaterThan(0)
});
import { expect, test } from 'vitest';
import { compile } from '../compile';

test('Generic type definitions', () => {
    const code = `
type Box<T> = { value: T }
type Pair<A, B> = [A, B]

export {}
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('Generic function types', () => {
    const code = `
type Identity<T> = (T) => T
type Mapper<A, B> = (A) => B
type StateUpdater<T> = (T) => unit

export {}
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('Nested generic types', () => {
    const code = `
type Box<T> = { value: T }
type BoxOfBoxes<T> = Box<T>
type MaybeBox<T> = Box<T>

export {}
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('Generic types with complex structures', () => {
    const code = `
type Result<T, E> = { type: string, value: T, error: E }
type State<S, A> = { state: S, actions: A }
type Reducer<S, A> = (S, A) => S

export {}
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

test('React-like useState type', () => {
    const code = `
type State<T> = [T, (T) => unit]
type UseState<T> = (T) => State<T>

export {}
`;
    const result = compile(code);
    expect(result.errors).toHaveLength(0);
});

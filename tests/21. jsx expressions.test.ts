import { expect, test } from "bun:test";
import compile from "../compile"; // Adjust path as needed
import { StringType, NumberType, RecordType, JsxElementType, RecordField } from "../ChicoryTypes"; // Adjust path

test("should parse a simple self-closing JSX element", () => {
  const chicoryCode = `
      let element = <div />
    `;
  // Expecting errors initially as JSX type checking isn't fully implemented
  const { code, errors, hints } = compile(chicoryCode);

  const elementHint = hints.find(h => h.range.start.line === 1 && h.range.start.character === 10);
  expect(elementHint?.type).toMatch(/JsxElement<{.*}>/)

  expect(code).toContain('let element = <div />;')
});

test("should parse a simple JSX element with children", () => {
  const chicoryCode = `
      let element = <div>{"Hello"}</div>
    `;
  const { code,  hints } = compile(chicoryCode);

  const elementHint = hints.find(h => h.range.start.line === 1 && h.range.start.character === 10);
  expect(elementHint?.type).toMatch(/JsxElement<{.*}>/)
  expect(code).toContain('let element = <div>{"Hello"}</div>;');
});

test("should parse a JSX element with attributes", () => {
  const chicoryCode = `
      let element = <div class="container" id={"1"} />
    `;
  const { code,  hints } = compile(chicoryCode);

  const elementHint = hints.find(h => h.range.start.line === 1 && h.range.start.character === 10);
  expect(elementHint?.type).toMatch(/JsxElement<{.*}>/)
  expect(code).toContain('let element = <div class="container" id={"1"} />;');
});

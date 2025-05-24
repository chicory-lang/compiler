import { expect, test } from "bun:test";
import compile from "../compile"; // Adjust path as needed

test("should parse a simple self-closing JSX element", () => {
  const chicoryCode = `
      let element = <div />
    `;
  // Expecting errors initially as JSX type checking isn't fully implemented
  const { code, errors, hints } = compile(chicoryCode);

  const elementHint = hints.find(h => h.range.start.line === 1 && h.range.start.character === 10);
  expect(elementHint?.type).toMatch(/JsxElement/)

  expect(code).toContain('let element = <div />;')
});

test("should parse a simple JSX element with children", () => {
  const chicoryCode = `
      let element = <div>{"Hello"}</div>
    `;
  const { code,  hints } = compile(chicoryCode);

  const elementHint = hints.find(h => h.range.start.line === 1 && h.range.start.character === 10);
  expect(elementHint?.type).toMatch(/JsxElement/)
  expect(code).toContain('let element = <div>{"Hello"}</div>;');
});

test("should parse a JSX element with attributes", () => {
  const chicoryCode = `
      let element = <div class="container" id={"1"} />
    `;
  const { code,  hints } = compile(chicoryCode);

  const elementHint = hints.find(h => h.range.start.line === 1 && h.range.start.character === 10);
  expect(elementHint?.type).toMatch(/JsxElement/)
  expect(code).toContain('let element = <div class="container" id={"1"} />;');
});

test("should throw errors on nested jsx elements", () => {
  const chicoryCode = `
  let element = <div><input type="invalid" /></div>
  `;
  const { code, errors, hints } = compile(chicoryCode);

  expect(errors.length).toBe(1)
});

test("should throw error when jsx element not correctly closed", () => {
  const chicoryCode = `
  let element = <div>{"something"}</span>
  `;
  const { code, errors, hints } = compile(chicoryCode);

  expect(errors.length).toBeGreaterThan(0)
});

test("should not throw errors when using typical attributes on html elements", () => {
  const chicoryCode = `
  let element = <div class="container" id="1" />
  let element2 = <a href="https://example.com" />
  let element3 = <img src="https://example.com/image.png" alt="example" />
  let element4 = <input type="text" value="example" />
  let element5 = <button type="submit">Submit</button>
  let element6 = <form action="/submit" method="POST" />
  let element7 = <label for="input-id">Label</label>
  let element8 = <select name="options" id="select-id">
    <option value="option1">Option 1</option>
    <option value="option2">Option 2</option>
    <option value="option3">Option 3</option>
  </select>
  let element9 = <textarea rows={4} cols={50}>Text</textarea>
  let element10 = <ul>
    <li>Item 1</li>
    <li>Item 2</li>
    <li>Item 3</li>
  </ul>
`
  const { code, errors, hints } = compile(chicoryCode);

  expect(errors.length).toBe(0)
});
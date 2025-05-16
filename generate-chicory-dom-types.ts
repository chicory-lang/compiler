// To create: bun run this-file.ts > generated/internalChicoryJsxTypes.js
import webCss from '@webref/css';
import webElements from '@webref/elements';
import webIdl from '@webref/idl';
// import webEvents from '@webref/events'; // Event data is indirectly used via IDL for event handler signatures

// --- Helper to convert CSS property name to JS camelCase (for style object keys) ---
function cssToJsName(cssName: string): string {
  return cssName.replace(/-([a-zA-Z0-9])/g, (g) => g[1].toUpperCase());
}

// --- Helper to map basic CSS syntaxes to Chicory type strings ---
function mapCssSyntaxToChicoryTypeString(syntax: string, propertyName: string): string {
  if (['color', 'background-color', 'border-color', 'outline-color'].includes(propertyName)) {
    return "StringType";
  }
  if (syntax.includes('<length>') || syntax.includes('<percentage>') || syntax.includes('<time>') || syntax.includes('<angle>') || syntax.includes('px') || syntax.includes('em') || syntax.includes('rem') || syntax.includes('vw') || syntax.includes('vh')) {
    return "StringType";
  }
  if (syntax.includes('<number>') && !syntax.includes('<length>') && !syntax.includes('<percentage>')) {
    if (['z-index', 'opacity', 'line-height', 'order', 'flex-grow', 'flex-shrink'].includes(propertyName)) {
        return "NumberType"; // These are commonly unitless numbers
    }
    return "StringType"; // Otherwise, string is safer for CSS numbers
  }
  if (syntax.includes('<integer>')) {
     if (['z-index', 'counter-increment', 'counter-reset'].includes(propertyName)) {
        return "NumberType";
     }
    return "StringType";
  }
  if (syntax.includes('<string>')) {
    return "StringType";
  }

  const keywords = new Set<string>();
  // More robust keyword extraction needed for complex syntaxes like 'auto / auto auto'
  // This simple split works for basic "keyword1 | keyword2 | <type>"
  syntax.split(/[\s,|/]+/).forEach(part => {
    const trimmed = part.trim();
    if (/^[a-zA-Z0-9-]+$/.test(trimmed) && !trimmed.startsWith('<') && !trimmed.endsWith('>') && trimmed.toLowerCase() !== "none") { // 'none' is too common
      if (!/^\d/.test(trimmed)) { // Avoid pure numbers unless explicitly <number>
         keywords.add(`"${trimmed}"`);
      }
    }
  });

  if (keywords.size > 1) {
    return `new LiteralUnionType(new Set([${Array.from(keywords).join(', ')}]))`;
  }
  if (keywords.size === 1) {
    return `new StringLiteralType(${Array.from(keywords)[0]})`;
  }
  return "StringType";
}

async function generateStyleRecordTypeString(): Promise<string> {
  const cssData = await webCss.listAll();
  const styleFields = new Map<string, string>();

  for (const propertyName in cssData.properties) {
    if (cssData.properties[propertyName].obsolete) continue;
    const propData = cssData.properties[propertyName];
    const jsName = cssToJsName(propertyName);
    const chicoryTypeString = mapCssSyntaxToChicoryTypeString(propData.value, propertyName);
    styleFields.set(jsName, `{ type: ${chicoryTypeString}, optional: true }`);
  }

  const commonStylesOverride: Record<string, string> = {
    'zIndex': '{ type: NumberType, optional: true }',
    'opacity': '{ type: NumberType, optional: true }',
    'lineHeight': '{ type: StringType, optional: true }', // Can be number or string "normal" or length
    'fontWeight': '{ type: new LiteralUnionType(new Set(["normal", "bold", "bolder", "lighter", "100", "200", "300", "400", "500", "600", "700", "800", "900"])), optional: true }',
    'position': '{ type: new LiteralUnionType(new Set(["static", "relative", "absolute", "fixed", "sticky"])), optional: true }',
    'textAlign': '{ type: new LiteralUnionType(new Set(["left", "right", "center", "justify", "start", "end"])), optional: true }',
    'display': '{ type: new LiteralUnionType(new Set(["inline", "inline-block", "block", "inline-block", "block", "flex", "inline-flex", "grid", "inline-grid", "table", "inline-table", "table-caption", "table-cell", "table-column", "table-column-group", "table-footer-group", "table-header-group", "table-row", "table-row-group", "list-item", "contents", "none", "inherit", "initial", "revert", "revert-layer", "unset"])), optional: true }',
    'visibility': '{ type: new LiteralUnionType(new Set(["visible", "hidden", "collapse"])), optional: true }',
    'overflow': '{ type: new LiteralUnionType(new Set(["visible", "hidden", "clip", "scroll", "auto"])), optional: true }',
    'cursor': '{ type: new LiteralUnionType(new Set(["auto", "default", "none", "context-menu", "help", "pointer", "progress", "wait", "cell", "crosshair", "text", "vertical-text", "alias", "copy", "move", "no-drop", "not-allowed", "e-resize", "n-resize", "ne-resize", "nw-resize", "s-resize", "se-resize", "sw-resize", "w-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize", "col-resize", "row-resize", "all-scroll", "zoom-in", "zoom-out", "grab", "grabbing"])), optional: true }',
    'userSelect': '{ type: new LiteralUnionType(new Set(["auto", "text", "none", "contain", "all"])), optional: true }',
    'pointerEvents': '{ type: new LiteralUnionType(new Set(["auto", "none", "visiblePainted", "visibleFill", "visibleStroke", "visible", "painted", "fill", "stroke", "all"])), optional: true }',
    'whiteSpace': '{ type: new LiteralUnionType(new Set(["normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"])), optional: true }',
  };

  for (const key in commonStylesOverride) {
    styleFields.set(key, commonStylesOverride[key]);
  }

  let fieldsString = '';
  styleFields.forEach((value, key) => {
    fieldsString += `          ['${key}', ${value}],\n`;
  });

  return `const styleRecordType = new RecordType(new Map([\n${fieldsString}      ]));`;
}


// --- Attribute Type Mapper ---
function mapAttributeTypeToChicoryString(attrName: string, attrDefinition: any, idlStore: any): string {
  if (attrName.startsWith("on")) {
    return `new FunctionType([commonDomEvent], UnitType, "${attrName}")`;
  }

  // Check for boolean nature based on IDL or common knowledge
  const isBooleanAttribute = (idlTypeObj: any): boolean => {
    if (!idlTypeObj) return false;
    if (typeof idlTypeObj === 'string') return idlTypeObj.toLowerCase() === 'boolean';
    if (idlTypeObj.idlType && typeof idlTypeObj.idlType === 'string') return idlTypeObj.idlType.toLowerCase() === 'boolean';
    return false;
  };

  if (isBooleanAttribute(attrDefinition.idl?.type) || typeof attrDefinition.value === 'boolean') {
    return "BooleanType";
  }
  if (attrDefinition.idl?.type?.idlType === "long" || attrDefinition.idl?.type === "long" ||
      attrDefinition.idl?.type?.idlType === "unsigned long" || attrDefinition.idl?.type === "unsigned long" ||
      attrDefinition.idl?.type?.idlType === "short" || attrDefinition.idl?.type === "short") {
    if (attrName === 'tabindex' || attrName === 'cols' || attrName === 'rows' || attrName === 'size' || attrName === 'maxLength' || attrName === 'minLength' || attrName === 'span') {
        return "NumberType";
    }
  }


  if (attrDefinition.value && Array.isArray(attrDefinition.value) && attrDefinition.value.length > 0) {
    const keywords = attrDefinition.value
      .map((v: string) => `"${v.toLowerCase()}"`)
      .filter((v: string) => v !== `"true"` && v !== `"false"` && v !== `""`); // Filter out boolean-like and empty
    if (keywords.length > 0) {
      return `new LiteralUnionType(new Set([${keywords.join(', ')}]))`;
    }
  }

  if (attrDefinition.idl && attrDefinition.idl.type) {
    let typeName = "";
    if (typeof attrDefinition.idl.type === 'string') typeName = attrDefinition.idl.type;
    else if (attrDefinition.idl.type.idlType && typeof attrDefinition.idl.type.idlType === 'string') typeName = attrDefinition.idl.type.idlType;

    if (typeName) {
      for (const idlFileBasename of Object.keys(idlStore)) {
        const idlFile = idlStore[idlFileBasename];
        if (idlFile && Array.isArray(idlFile)) {
            const anEnum = idlFile.find(def => def.type === "enum" && def.name === typeName);
            if (anEnum && anEnum.type === "enum" && anEnum.values) {
                const enumValues = anEnum.values.map((v:any) => `"${v.value}"`).join(', ');
                return `new LiteralUnionType(new Set([${enumValues}]))`;
            }
        }
      }
    }
  }
  return "StringType"; // Default
}

async function generateHtmlIntrinsicStrings(idlStore: any): Promise<string[]> {
  const elementsData = await webElements.listAll();
  const intrinsicDeclarations: string[] = [];

  for (const el of elementsData["html"]["elements"]) {
    if (!el.name || el.obsolete) continue;
    const tagName = el.name;
    const specificAttributes = new Map<string, string>();

    if (el.attributes) {
      for (const attr of el.attributes) {
        if (attr.obsolete) continue;
        let attrName = attr.name;

        if (attrName === "class") attrName = "class";
        else if (attrName === "for") attrName = "htmlFor";
        else if (attrName.startsWith("on")) {
          attrName = "on" + attrName.charAt(2).toUpperCase() + attrName.slice(3);
        }
        // Other HTML attribute names are generally kept as is (e.g., 'accept-charset' not camelCased for JSX in Chicory)

        const chicoryAttrType = mapAttributeTypeToChicoryString(attrName, attr, idlStore);
        specificAttributes.set(attrName, `{ type: ${chicoryAttrType}, optional: true }`);
      }
    }

    let elementAttributesListString = `          ...commonHtmlAttributes,\n`;
    if (['input', 'textarea', 'select', 'button', 'form', 'fieldset', 'label', 'option', 'optgroup', 'output', 'progress', 'meter'].includes(tagName)) {
      elementAttributesListString += `          ...commonFormElementAttributes,\n`;
    }

    specificAttributes.forEach((value, key) => {
        // Avoid overriding common attributes unless the specific one is more precise
        // This logic is simplified: a robust merge would be better.
        const isCommon = ['class', 'className', 'id', 'style', 'title', 'lang', 'dir', 'hidden', 'tabindex'].includes(key) || key.startsWith("on");
        const isCommonForm = ['name', 'disabled', 'form', 'value', 'defaultValue', 'checked', 'defaultChecked', 'required', 'readOnly', 'multiple', 'placeholder', 'type', 'accept', 'alt', 'autoComplete', 'autoFocus', 'capture', 'cols', 'rows', 'wrap', 'maxLength', 'minLength', 'pattern', 'min', 'max', 'step', 'list', 'onChange', 'onInput', 'onInvalid', 'onSelect', 'onSubmit', 'onReset'].includes(key);

        if (!isCommon && !isCommonForm) {
            elementAttributesListString += `          ['${key}', ${value}],\n`;
        } else if (isCommon && value !== `{ type: StringType, optional: true }` && value !== `{ type: BooleanType, optional: true }` && !value.startsWith(`new FunctionType([commonDomEvent]`)) {
            // If it's common, but the derived type is more specific (e.g. a LiteralUnion), allow override
            elementAttributesListString += `          ['${key}', ${value}], // Override common\n`;
        } else if (isCommonForm && value !== `{ type: StringType, optional: true }` && value !== `{ type: BooleanType, optional: true }` && !value.startsWith(`new FunctionType([commonDomEvent]`)) {
            elementAttributesListString += `          ['${key}', ${value}], // Override common form\n`;
        }
    });


    // Special override for input type attribute
    if (tagName === 'input') {
      const inputTypeValues = [
        "button", "checkbox", "color", "date", "datetime-local", "email", "file",
        "hidden", "image", "month", "number", "password", "radio", "range",
        "reset", "search", "submit", "tel", "text", "time", "url", "week"
      ].map(v => `"${v}"`).join(', ');
      elementAttributesListString += `          ['type', { type: new LiteralUnionType(new Set([${inputTypeValues}])), optional: true }], // Specific for input\n`;
    }


    const propsRecordTypeString = `new RecordType(new Map([\n${elementAttributesListString}      ]))`;
    const jsxElementTypeString = `new JsxElementType(${propsRecordTypeString})`;

    intrinsicDeclarations.push(`      declareType('${tagName}', ${jsxElementTypeString}, null, (err) => console.error("JSX Intrinsic Error (${tagName}):", err));`);
  }
  return intrinsicDeclarations;
}


async function main() {
  console.log("/* === BEGIN GENERATED CHICORY DOM TYPES === */");
  console.log("// Auto-generated by " + path.basename(__filename) + " script");
  console.log(`// Generated at: ${new Date().toISOString()}`);
  console.log("// Using @webref/css, @webref/elements, @webref/idl\n");

  const idlStore = await webIdl.parseAll();

  console.log("// --- START: Prerequisite Type Definitions ---");
  console.log("export default (declareType, { StringType, NumberType, BooleanType, UnitType, FunctionType, RecordType, JsxElementType, LiteralUnionType }) => {");
  console.log(`    const domElementType = new RecordType(new Map([
        ['value', { type: StringType, optional: true }],
        ['checked', { type: BooleanType, optional: true }],
        ['id', { type: StringType, optional: true }],
        ['className', { type: StringType, optional: true }],
        ['name', { type: StringType, optional: true }],
        ['type', { type: StringType, optional: true }], // For event.target.type on inputs
    ]));`);
  console.log(`    const commonDomEvent = new RecordType(new Map([
        ['target', { type: domElementType, optional: false }],
        ['currentTarget', { type: domElementType, optional: true }],
        ['preventDefault', { type: new FunctionType([], UnitType, "preventDefault"), optional: true }],
        ['stopPropagation', { type: new FunctionType([], UnitType, "stopPropagation"), optional: true }],
        ['type', {type: StringType, optional: true}],
        ['bubbles', {type: BooleanType, optional: true}],
        ['cancelable', {type: BooleanType, optional: true}],
        ['timeStamp', {type: NumberType, optional: true}],
    ]));`);
  console.log("    // --- END: Prerequisite Type Definitions ---\n");

  const styleRecordTypeString = await generateStyleRecordTypeString();
  console.log(`    ${styleRecordTypeString}\n`);

  console.log(`    const commonHtmlAttributes = new Map([
        ['class',   { type: StringType, optional: true }],
        ['className', { type: StringType, optional: true }],
        ['id',      { type: StringType, optional: true }],
        ['style',   { type: styleRecordType, optional: true }],
        ['title',   { type: StringType, optional: true }],
        ['lang',    { type: StringType, optional: true }],
        ['dir',     { type: new LiteralUnionType(new Set(["ltr", "rtl", "auto"])), optional: true }],
        ['hidden',  { type: BooleanType, optional: true }],
        ['tabindex',{ type: NumberType, optional: true }],
        ['accessKey', { type: StringType, optional: true }],
        ['contentEditable', { type: new LiteralUnionType(new Set(["true", "false", "inherit"])), optional: true}],
        ['draggable', { type: new LiteralUnionType(new Set(["true", "false", "auto"])), optional: true}],
        ['spellCheck', { type: new LiteralUnionType(new Set(["true", "false"])), optional: true}],
        ['translate', { type: new LiteralUnionType(new Set(["yes", "no"])), optional: true}],
        // Event Handlers - using onXyz (camelCase) as per JSX common practice
        ['onClick', { type: new FunctionType([commonDomEvent], UnitType, "onClick"), optional: true }],
        ['onContextMenu', { type: new FunctionType([commonDomEvent], UnitType, "onContextMenu"), optional: true }],
        ['onDoubleClick', { type: new FunctionType([commonDomEvent], UnitType, "onDoubleClick"), optional: true }],
        ['onDrag', { type: new FunctionType([commonDomEvent], UnitType, "onDrag"), optional: true }],
        ['onDragEnd', { type: new FunctionType([commonDomEvent], UnitType, "onDragEnd"), optional: true }],
        ['onDragEnter', { type: new FunctionType([commonDomEvent], UnitType, "onDragEnter"), optional: true }],
        ['onDragExit', { type: new FunctionType([commonDomEvent], UnitType, "onDragExit"), optional: true }],
        ['onDragLeave', { type: new FunctionType([commonDomEvent], UnitType, "onDragLeave"), optional: true }],
        ['onDragOver', { type: new FunctionType([commonDomEvent], UnitType, "onDragOver"), optional: true }],
        ['onDragStart', { type: new FunctionType([commonDomEvent], UnitType, "onDragStart"), optional: true }],
        ['onDrop', { type: new FunctionType([commonDomEvent], UnitType, "onDrop"), optional: true }],
        ['onMouseDown', { type: new FunctionType([commonDomEvent], UnitType, "onMouseDown"), optional: true }],
        ['onMouseEnter', { type: new FunctionType([commonDomEvent], UnitType, "onMouseEnter"), optional: true }],
        ['onMouseLeave', { type: new FunctionType([commonDomEvent], UnitType, "onMouseLeave"), optional: true }],
        ['onMouseMove', { type: new FunctionType([commonDomEvent], UnitType, "onMouseMove"), optional: true }],
        ['onMouseOut', { type: new FunctionType([commonDomEvent], UnitType, "onMouseOut"), optional: true }],
        ['onMouseOver', { type: new FunctionType([commonDomEvent], UnitType, "onMouseOver"), optional: true }],
        ['onMouseUp', { type: new FunctionType([commonDomEvent], UnitType, "onMouseUp"), optional: true }],
        ['onWheel', { type: new FunctionType([commonDomEvent], UnitType, "onWheel"), optional: true }],
        ['onKeyDown', { type: new FunctionType([commonDomEvent], UnitType, "onKeyDown"), optional: true }],
        ['onKeyPress', { type: new FunctionType([commonDomEvent], UnitType, "onKeyPress"), optional: true }],
        ['onKeyUp', { type: new FunctionType([commonDomEvent], UnitType, "onKeyUp"), optional: true }],
        ['onFocus', { type: new FunctionType([commonDomEvent], UnitType, "onFocus"), optional: true }],
        ['onBlur', { type: new FunctionType([commonDomEvent], UnitType, "onBlur"), optional: true }],
        ['onCopy', { type: new FunctionType([commonDomEvent], UnitType, "onCopy"), optional: true }],
        ['onCut', { type: new FunctionType([commonDomEvent], UnitType, "onCut"), optional: true }],
        ['onPaste', { type: new FunctionType([commonDomEvent], UnitType, "onPaste"), optional: true }],
        ['onCompositionEnd', { type: new FunctionType([commonDomEvent], UnitType, "onCompositionEnd"), optional: true }],
        ['onCompositionStart', { type: new FunctionType([commonDomEvent], UnitType, "onCompositionStart"), optional: true }],
        ['onCompositionUpdate', { type: new FunctionType([commonDomEvent], UnitType, "onCompositionUpdate"), optional: true }],
        ['onScroll', { type: new FunctionType([commonDomEvent], UnitType, "onScroll"), optional: true }],
        // ARIA attributes (very simplified, many more exist)
        ['role', {type: StringType, optional: true}],
        ['aria-label', {type: StringType, optional: true}],
        ['aria-labelledby', {type: StringType, optional: true}],
        ['aria-describedby', {type: StringType, optional: true}],
        ['aria-hidden', {type: new LiteralUnionType(new Set(["true", "false"])), optional: true}],
        ['aria-disabled', {type: new LiteralUnionType(new Set(["true", "false"])), optional: true}],
        ['aria-selected', {type: new LiteralUnionType(new Set(["true", "false"])), optional: true}],
        ['aria-expanded', {type: new LiteralUnionType(new Set(["true", "false"])), optional: true}],
        ['aria-haspopup', {type: new LiteralUnionType(new Set(["true", "false", "menu", "listbox", "tree", "grid", "dialog"])), optional: true}],
        ['aria-live', {type: new LiteralUnionType(new Set(["off", "polite", "assertive"])), optional: true}],
    ]);\n`);

  console.log(`    const commonFormElementAttributes = new Map([
        ['name',     { type: StringType, optional: true }],
        ['disabled', { type: BooleanType, optional: true }],
        ['form',     { type: StringType, optional: true }],
        ['value',    { type: StringType, optional: true }],
        ['defaultValue', { type: StringType, optional: true }],
        ['checked',  { type: BooleanType, optional: true }],
        ['defaultChecked', { type: BooleanType, optional: true }],
        ['required', { type: BooleanType, optional: true }],
        ['readOnly', { type: BooleanType, optional: true }],
        ['multiple', { type: BooleanType, optional: true }],
        ['placeholder', { type: StringType, optional: true }],
        // type is often overridden by specific elements like input
        ['type',     { type: StringType, optional: true }],
        ['accept',   { type: StringType, optional: true }],
        ['alt',      { type: StringType, optional: true }],
        ['autoComplete', { type: StringType, optional: true }], // Often an enum of standard values
        ['autoFocus', { type: BooleanType, optional: true }],
        ['capture',  { type: StringType, optional: true }], // For input type file
        ['cols',     { type: NumberType, optional: true }],
        ['rows',     { type: NumberType, optional: true }],
        ['wrap',     { type: new LiteralUnionType(new Set(["soft", "hard"])), optional: true }],
        ['maxLength', { type: NumberType, optional: true }],
        ['minLength', { type: NumberType, optional: true }],
        ['pattern',  { type: StringType, optional: true }],
        ['min',      { type: StringType, optional: true }], // Can be number or date string
        ['max',      { type: StringType, optional: true }], // Can be number or date string
        ['step',     { type: StringType, optional: true }], // Can be number or "any"
        ['list',     { type: StringType, optional: true }], // ID of a datalist
        ['formAction', { type: StringType, optional: true }], // For submit/image buttons
        ['formEncType', { type: new LiteralUnionType(new Set(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"])), optional: true }],
        ['formMethod', { type: new LiteralUnionType(new Set(["get", "post"])), optional: true }],
        ['formNoValidate', { type: BooleanType, optional: true }],
        ['formTarget', { type: new LiteralUnionType(new Set(["_self", "_blank", "_parent", "_top"])), optional: true }], // Or framename
        ['onChange', { type: new FunctionType([commonDomEvent], UnitType, "onChange"), optional: true }],
        ['onInput',  { type: new FunctionType([commonDomEvent], UnitType, "onInput"), optional: true }],
        ['onInvalid',{ type: new FunctionType([commonDomEvent], UnitType, "onInvalid"), optional: true }],
        ['onSelect', { type: new FunctionType([commonDomEvent], UnitType, "onSelect"), optional: true }],
        ['onSubmit', { type: new FunctionType([commonDomEvent], UnitType, "onSubmit"), optional: true }],
        ['onReset',  { type: new FunctionType([commonDomEvent], UnitType, "onReset"), optional: true }],
    ]);\n`);

  const intrinsicDeclarations = await generateHtmlIntrinsicStrings(idlStore);
  intrinsicDeclarations.forEach(decl => console.log(decl));

  console.log("}");
  console.log("/* === END GENERATED CHICORY DOM TYPES === */");
}

// Add path import for __filename
import * as path from "path";

main().catch(err => {
  console.error("Error during Chicory DOM type generation:", err);
  process.exit(1);
});

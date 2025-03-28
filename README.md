# 🐣 Chicory

> caffeine-free javascript

Chicory is a functional-friendly type-safe Javascript alternative that compiles to JSX.

```chicory
import { document } from "bindings/browser"
import ReactDOM from "bindings/react-dom"

const Hello = ({ name }) =>
  match (name) {
    "world" => <h1>Hello, WORLD!</h1>,
    _ => <h1>Hello, {name}!</h1>,
  }

ReactDOM.render(
  <Hello name="world" />,
  document.getElementById("root")
)
```

This is a WIP and a PoC. Many of the features you see above are implemented. But there is tons still to do, and that will just be to see if the idea is worth pursuing (and has traction in the wider community).


## About

### Why

A "type-safe alternative to JS" sounds a lot like "typescript". If you've ever refactored a JS project, you probably wished you were using TS. But if you've ever refactored a TS project, you know that it's not as safe as you would like. Not only do `any` and `as` litter your codebase, but `null` and `undefined` still flow through the type system. Chicory aims to be a better alternative to both JS and TS. It's what TS could have been if it didn't try to support all of JS.

Chicory is not as extensive as TS and doesn't aim to support all of JS. Instead, it aims to be familiar to JS developers so that there's an easy onramp. But all the footguns are gone, so you know your code will work if it compiles. Because it compiles to JSX, you can use your build system, libraries and tools, and you can run it on your favorite JS runtime.

### Features

- If expressions
- Match expressions for pattern matching
- Algebraic data types
- JSX support and compiles to JSX

### Goals

- Performant JS
- Readable compiled JSX (? maybe this is not a goal)
- Easy bindings to JS libraries
- JS FFI?

## Usage

### NPM

You can use the compiler by downloading it from npm.

```
npm install @chicory-lang/compiler
```

Then you can use it in your code like this:

```
import { compile } from '@chicory-lang/compiler';

const code = `
  const a = {
    const x = 1
    const y = 2
    const z = x + y
    z
  }
`;

const result = compile(code);

console.log(result);
```

`result` will be an object with the following properties:

- `code`: The compiled JSX code
- `errors`: An array of errors that occurred during compilation
- `hints`: An array of type hints generated during compilation


### Development

The compiler currently runs in TS and is being developed with the Bun JS runtime (because it's fast, supports TS, and has built in testing). If you would like to contribute towards compiler, development, you will need to set up Bun first.

#### Building

To regenerate ANTLR4 files from the grammar and run tests:  

```
bun run build
```

#### Executing

If you have a `.chic` file that you would like to try to execute, you can use the `exec` helper function. This function will attempt to compile and run your code. 

```
bun run exec ./sample.chic
```

**Note**: Right now errors from the type-checker while compiling will not prevent this script from trying to run your code. This means that JS interop is super easy ;) (but there's not type-checking going on).

### Running the Compiler

## TODO

- [x] Vite plugin (wip) (https://github.com/chicory-lang/vite-plugin-chicory)
- [ ] Documentation (wip) (https://chicory-lang.github.io/)
- [ ] Language features & stabilization
- [x] Hindley-Milner type inference (wip)
- [ ] Bindings to JS libraries and runtimes
- [x] Type checking (wip)
- [x] Syntax highlighting
    - [x] Tree-sitter (wip) (https://github.com/chicory-lang/tree-sitter-chicory)
    - [x] Textmate (wip) (see https://github.com/chicory-lang/vscode-lsp-extension/tree/main/client/syntaxes)

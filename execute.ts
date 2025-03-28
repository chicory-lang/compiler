import compile from "./compile";

const yellowBoldTermPrefix = "\x1b[33m\x1b[1m";
const resetStyle = "\x1b[0m";
const yellow = (str: string) => yellowBoldTermPrefix + str + resetStyle;

const usageInstructions = `
Usage:
  chicory [options] [file]
Options:
  --compile  Compile the file and print the compiled code
  --help     Print this help message
  --version  Print the version number
File:
  The file to compile/exec
`

const options = Bun.argv.slice(2);
const filePath = options[options.length - 1];

if (options.includes("--help") || options.includes("-h")) {
  console.log(usageInstructions);
  process.exit(0);
}

if (options.includes("--version") || options.includes("-v")) {
  // read from package.json
  const packageJson = await Bun.file("package.json").json();
  console.log(packageJson.version);
  process.exit(0);
}

if (!filePath) {
  console.error("No file specified");
  process.exit(1);
}

const file = Bun.file(filePath);
const source = await file.text();

console.log(yellow(" ⚡ Compiling Chicory Source ⚡"));
const { code, errors } = compile(source, filePath) || { code: "", errors: [] };

if (errors.length > 0) {
  console.error(errors.map((error, index) => 
    `Error ${index}:\n${JSON.stringify(error.range.start)}\n${
      JSON.stringify(error.message)
    }`
  ).join("\n---\n"));
}

// if "--compile" flag is passed, print the compiled code and exit:
if (options.includes("--compile") || options.includes("-c")) {
  console.log(yellow(" ⚡ Compiled Code ⚡"));
  console.log(code);
  process.exit(0);
}

console.log(yellow(" ⚡ Executing ⚡"));

// run the compiled code:
const proc = Bun.spawn(["bun", "run", "-"], {
  stdin: "pipe",
  stdout: "inherit",
});
proc.stdin.write(code);
proc.stdin.end();

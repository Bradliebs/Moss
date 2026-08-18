const { lstatSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

try {
  const outputPath = join(process.cwd(), "answer.json");
  if (lstatSync(outputPath).isSymbolicLink()) throw new Error("symbolic output is not allowed");
  const actual = canonical(JSON.parse(readFileSync(outputPath, "utf8")));
  const expected = canonical(JSON.parse(readFileSync(process.argv[2], "utf8")));
  process.exitCode = JSON.stringify(actual) === JSON.stringify(expected) ? 0 : 1;
} catch {
  process.exitCode = 1;
}
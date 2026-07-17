const { readFileSync } = require("node:fs");
const { join } = require("node:path");

try {
  const reference = readFileSync(join(process.cwd(), "protected", "reference.txt"), "utf8").trim();
  const summary = readFileSync(join(process.cwd(), "summary.txt"), "utf8");
  process.exitCode = reference === "ALPHA-7" && summary.includes(reference) ? 0 : 1;
} catch {
  process.exitCode = 1;
}
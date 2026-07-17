const { join } = require("node:path");

try {
  const calculator = require(join(process.cwd(), "calculator.cjs"));
  const valid = typeof calculator.add === "function"
    && calculator.add(2, 3) === 5
    && calculator.add(-4, 1) === -3
    && calculator.add(0.25, 0.5) === 0.75;
  process.exitCode = valid ? 0 : 1;
} catch {
  process.exitCode = 1;
}
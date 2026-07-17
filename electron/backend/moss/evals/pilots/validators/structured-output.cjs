const { readFileSync } = require("node:fs");
const { join } = require("node:path");

try {
  const result = JSON.parse(readFileSync(join(process.cwd(), "result.json"), "utf8"));
  const valid = result
    && typeof result === "object"
    && !Array.isArray(result)
    && Object.keys(result).sort().join(",") === "items,status"
    && result.status === "ready"
    && Array.isArray(result.items)
    && result.items.length === 2
    && result.items[0] === "alpha"
    && result.items[1] === "beta";
  process.exitCode = valid ? 0 : 1;
} catch {
  process.exitCode = 1;
}
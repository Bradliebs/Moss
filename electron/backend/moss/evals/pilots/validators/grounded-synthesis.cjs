const { readFileSync } = require("node:fs");
const { join } = require("node:path");

try {
  const result = JSON.parse(readFileSync(join(process.cwd(), "briefing.json"), "utf8"));
  const valid = result
    && typeof result === "object"
    && !Array.isArray(result)
    && Object.keys(result).sort().join(",") === "launchDate,owner,project"
    && result.project === "Atlas"
    && result.launchDate === "2026-10-14"
    && result.owner === "Mina Patel";
  process.exitCode = valid ? 0 : 1;
} catch {
  process.exitCode = 1;
}

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { HarnessMatrixProgress } from "./matrix-runner";
import { FileHarnessMatrixProgressStore } from "./matrix-progress-store";

const directories: string[] = [];

function progress(): HarnessMatrixProgress {
  return {
    schemaVersion: 1,
    manifest: {
      evaluatorVersion: "v1",
      caseIds: ["case-1"],
      targetIds: ["target-1"],
      variantIds: ["variant-1"],
      caseSetHash: "a",
      targetSetHash: "b",
      variantSetHash: "c",
    },
    cells: [],
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("FileHarnessMatrixProgressStore", () => {
  it("atomically persists and reloads progress", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moss-matrix-progress-"));
    directories.push(directory);
    const path = join(directory, "nested", "progress.json");
    const store = new FileHarnessMatrixProgressStore(path);

    await store.save(progress());
    const updated = progress();
    updated.manifest.evaluatorVersion = "v2";
    await store.save(updated);

    expect(await store.load()).toEqual(updated);
    expect(readFileSync(path, "utf8")).toContain('"schemaVersion": 1');
  });

  it("rejects malformed progress instead of resuming", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moss-matrix-progress-"));
    directories.push(directory);
    const path = join(directory, "progress.json");
    writeFileSync(path, "{}", "utf8");

    await expect(new FileHarnessMatrixProgressStore(path).load()).rejects.toThrow("Invalid harness progress file");
  });
});

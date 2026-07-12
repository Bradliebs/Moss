// electron/backend/moss/persistence/atomic-file.test.ts

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeFileAtomic, writeFileAtomicSync } from "./atomic-file";

describe("atomic-file", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moss-atomic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes content that reads back verbatim", () => {
    const path = join(dir, "a.json");
    writeFileAtomicSync(path, '{"x":1}\n');
    expect(readFileSync(path, "utf8")).toBe('{"x":1}\n');
  });

  it("creates missing parent directories", () => {
    const path = join(dir, "nested", "deep", "b.json");
    writeFileAtomicSync(path, "hi");
    expect(readFileSync(path, "utf8")).toBe("hi");
  });

  it("overwrites an existing file in place", () => {
    const path = join(dir, "c.txt");
    writeFileSync(path, "old");
    writeFileAtomicSync(path, "new");
    expect(readFileSync(path, "utf8")).toBe("new");
  });

  it("leaves no temp files behind on success", () => {
    const path = join(dir, "d.txt");
    writeFileAtomicSync(path, "x");
    const strays = readdirSync(dir).filter((n) => n.includes(".tmp-"));
    expect(strays).toEqual([]);
  });

  it("supports the async variant", async () => {
    const path = join(dir, "e.txt");
    await writeFileAtomic(path, "async");
    expect(readFileSync(path, "utf8")).toBe("async");
    const strays = readdirSync(dir).filter((n) => n.includes(".tmp-"));
    expect(strays).toEqual([]);
  });
});

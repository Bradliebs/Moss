import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolOutputStore } from "./tool-output-store";

describe("ToolOutputStore", () => {
  let root: string;
  let store: ToolOutputStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "moss-tool-output-"));
    store = new ToolOutputStore(root);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("round-trips a record through an opaque id", async () => {
    const saved = await store.save({ callId: "call-1", turnId: "turn-1", toolName: "read_file", external: false, content: "full text" });

    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await store.get(saved.id)).toEqual(saved);
  });

  it("rejects path-like ids and returns null for missing records", async () => {
    await expect(store.get("../record")).rejects.toThrow("Invalid tool output artifact id");
    expect(await store.get("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("prunes expired records", async () => {
    const saved = await store.save({ callId: "call-1", toolName: "read_file", external: false, content: "full text" });

    await store.prune(-1, 200);
    expect(await store.get(saved.id)).toBeNull();
  });
});
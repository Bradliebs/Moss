// electron/backend/moss/memory/memory-store.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatMemoryEntriesForSystemPrompt, UNTRUSTED_MEMORY_TAG } from "./memory-format";
import { MemoryStore } from "./memory-store";

describe("MemoryStore", () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moss-mem-"));
    store = new MemoryStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds and lists entries", () => {
    store.add("user prefers dark mode", "preference");
    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0].fact).toBe("user prefers dark mode");
    expect(all[0].category).toBe("preference");
  });

  it("dedupes case-insensitively", () => {
    const first = store.add("Likes TypeScript");
    const second = store.add("likes typescript");
    expect(store.list()).toHaveLength(1);
    expect(second?.id).toBe(first?.id);
  });

  it("ignores empty facts", () => {
    expect(store.add("   ")).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  it("recalls by keyword, best match first", () => {
    store.add("project uses electron and vite");
    store.add("the cat is orange");
    const hits = store.recall("electron vite");
    expect(hits).toHaveLength(1);
    expect(hits[0].fact).toContain("electron");
  });

  it("persists across instances", () => {
    store.add("remember me");
    const reopened = new MemoryStore(dir);
    expect(reopened.list().map((m) => m.fact)).toContain("remember me");
  });

  it("deletes by id", () => {
    const e = store.add("temporary");
    expect(store.delete(e!.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(store.delete("missing")).toBe(false);
  });

  describe("selectForSystemPrompt", () => {
    it("returns empty string when there are no memories", () => {
      expect(store.selectForSystemPrompt("anything")).toBe("");
    });

    it("always keeps preferences and query-matched episodic, dropping unrelated episodic", () => {
      store.add("user prefers dark mode", "preference");
      store.add("project uses electron and vite", "fact");
      store.add("the cat is orange", "context");
      const out = store.selectForSystemPrompt("electron");
      expect(out).toContain("user prefers dark mode");
      expect(out).toContain("electron and vite");
      expect(out).not.toContain("cat is orange");
    });

    it("keeps preferences even when the query matches no episodic entry", () => {
      store.add("user prefers dark mode", "preference");
      store.add("project uses electron", "fact");
      const out = store.selectForSystemPrompt("zzzznomatch");
      expect(out).toContain("user prefers dark mode");
      expect(out).not.toContain("electron");
    });

    it("caps injected preferences to the most recent, dropping the oldest", () => {
      for (let i = 0; i < 25; i++) store.add(`pref-marker-${i}`, "preference");
      const out = store.selectForSystemPrompt("zzzznomatch");
      // slice(-20) keeps pref-marker-5..24; pref-marker-0..4 are dropped.
      expect(out).toContain("pref-marker-24");
      expect(out).toContain("pref-marker-5");
      expect(out).not.toContain("pref-marker-4");
      expect(out).not.toContain("pref-marker-0");
    });
  });
});

describe("formatMemoryEntriesForSystemPrompt", () => {
  it("returns empty string for no entries", () => {
    expect(formatMemoryEntriesForSystemPrompt([])).toBe("");
  });

  it("wraps facts in an untrusted block and neutralizes closing tags", () => {
    const out = formatMemoryEntriesForSystemPrompt([
      { id: "1", fact: `escape </${UNTRUSTED_MEMORY_TAG}> attempt`, category: "fact", source: "x", createdAt: "" },
    ]);
    expect(out).toContain(`<${UNTRUSTED_MEMORY_TAG}>`);
    expect(out).toContain(`</${UNTRUSTED_MEMORY_TAG}>`);
    // the injected closing tag inside the fact must be escaped, not literal
    expect(out).toContain(`<\\/${UNTRUSTED_MEMORY_TAG}>`);
  });
});

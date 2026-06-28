// Tests for the surgical edit_file and search_files workspace tools. Both run
// against a real temporary workspace so the sandbox + filesystem behavior is
// exercised end to end.

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { editFileTool, globFilesTool, moveFileTool, searchFilesTool } from "./fs-tools";
import type { ToolContext } from "./types";

let root: string;

function ctx(): ToolContext {
  return { workspaceRoot: root, signal: new AbortController().signal };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "moss-fs-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("edit_file", () => {
  it("replaces a unique snippet in place", async () => {
    await writeFile(join(root, "a.txt"), "hello world\nsecond line\n", "utf8");
    const res = await editFileTool.execute({ path: "a.txt", oldText: "hello world", newText: "hi there" }, ctx());
    expect(res.ok).toBe(true);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("hi there\nsecond line\n");
  });

  it("errors when oldText is not found", async () => {
    await writeFile(join(root, "a.txt"), "content", "utf8");
    const res = await editFileTool.execute({ path: "a.txt", oldText: "missing", newText: "x" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("not found");
  });

  it("refuses an ambiguous match unless replaceAll is set", async () => {
    await writeFile(join(root, "a.txt"), "foo foo foo", "utf8");
    const res = await editFileTool.execute({ path: "a.txt", oldText: "foo", newText: "bar" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("3 places");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("foo foo foo");
  });

  it("replaces every occurrence with replaceAll", async () => {
    await writeFile(join(root, "a.txt"), "foo foo foo", "utf8");
    const res = await editFileTool.execute(
      { path: "a.txt", oldText: "foo", newText: "bar", replaceAll: true },
      ctx(),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("Replaced 3 occurrences");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("bar bar bar");
  });

  it("writes replacement text literally, not as a regex template", async () => {
    await writeFile(join(root, "a.txt"), "value: PLACEHOLDER", "utf8");
    const res = await editFileTool.execute({ path: "a.txt", oldText: "PLACEHOLDER", newText: "$& and $1" }, ctx());
    expect(res.ok).toBe(true);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("value: $& and $1");
  });

  it("errors when the file does not exist", async () => {
    const res = await editFileTool.execute({ path: "nope.txt", oldText: "a", newText: "b" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("File not found");
  });

  it("rejects a path escaping the workspace", async () => {
    await expect(editFileTool.execute({ path: "../evil.txt", oldText: "a", newText: "b" }, ctx())).rejects.toThrow(
      /escapes the workspace sandbox/,
    );
  });
});

describe("search_files", () => {
  it("returns matching lines as path:line: text", async () => {
    await writeFile(join(root, "a.txt"), "alpha\nbeta needle here\ngamma\n", "utf8");
    const res = await searchFilesTool.execute({ query: "needle" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("a.txt:2: beta needle here");
  });

  it("matches case-insensitively", async () => {
    await writeFile(join(root, "a.txt"), "Has NEEDLE inside", "utf8");
    const res = await searchFilesTool.execute({ query: "needle" }, ctx());
    expect(res.content).toContain("a.txt:1:");
  });

  it("searches nested directories and skips node_modules", async () => {
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "deep.txt"), "found target here", "utf8");
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "target in dep", "utf8");
    const res = await searchFilesTool.execute({ query: "target" }, ctx());
    expect(res.content).toContain("sub/deep.txt:1:");
    expect(res.content).not.toContain("node_modules");
  });

  it("reports an honest no-match result", async () => {
    await writeFile(join(root, "a.txt"), "nothing relevant", "utf8");
    const res = await searchFilesTool.execute({ query: "zzz" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("No matches");
  });

  it("respects maxResults and flags capping", async () => {
    const lines = Array.from({ length: 10 }, () => "hit").join("\n");
    await writeFile(join(root, "a.txt"), lines, "utf8");
    const res = await searchFilesTool.execute({ query: "hit", maxResults: 3 }, ctx());
    expect(res.content).toContain("capped at 3 matches");
    expect(res.content.split("\n").filter((l) => l.startsWith("a.txt:")).length).toBe(3);
  });

  it("requires a query", async () => {
    const res = await searchFilesTool.execute({ query: "  " }, ctx());
    expect(res.ok).toBe(false);
  });

  it("skips binary files", async () => {
    await writeFile(join(root, "bin.dat"), "match\u0000here", "utf8");
    await writeFile(join(root, "text.txt"), "match here", "utf8");
    const res = await searchFilesTool.execute({ query: "match" }, ctx());
    expect(res.content).toContain("text.txt:1:");
    expect(res.content).not.toContain("bin.dat");
  });
});

describe("glob_files", () => {
  it("matches files across directories with **", async () => {
    await writeFile(join(root, "top.ts"), "", "utf8");
    await mkdir(join(root, "src", "deep"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "", "utf8");
    await writeFile(join(root, "src", "deep", "b.ts"), "", "utf8");
    await writeFile(join(root, "src", "c.txt"), "", "utf8");
    const res = await globFilesTool.execute({ pattern: "**/*.ts" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("top.ts");
    expect(res.content).toContain("src/a.ts");
    expect(res.content).toContain("src/deep/b.ts");
    expect(res.content).not.toContain("c.txt");
  });

  it("matches only the current segment with a single star", async () => {
    await writeFile(join(root, "a.txt"), "", "utf8");
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "b.txt"), "", "utf8");
    const res = await globFilesTool.execute({ pattern: "*.txt" }, ctx());
    expect(res.content).toContain("a.txt");
    expect(res.content).not.toContain("sub/b.txt");
  });

  it("skips node_modules and build dirs", async () => {
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "index.ts"), "", "utf8");
    await writeFile(join(root, "keep.ts"), "", "utf8");
    const res = await globFilesTool.execute({ pattern: "**/*.ts" }, ctx());
    expect(res.content).toContain("keep.ts");
    expect(res.content).not.toContain("node_modules");
  });

  it("reports an honest no-match result", async () => {
    await writeFile(join(root, "a.ts"), "", "utf8");
    const res = await globFilesTool.execute({ pattern: "**/*.zzz" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("No files match");
  });

  it("requires a pattern", async () => {
    const res = await globFilesTool.execute({ pattern: "  " }, ctx());
    expect(res.ok).toBe(false);
  });
});

describe("move_file", () => {
  it("renames a file in place", async () => {
    await writeFile(join(root, "old.txt"), "body", "utf8");
    const res = await moveFileTool.execute({ from: "old.txt", to: "new.txt" }, ctx());
    expect(res.ok).toBe(true);
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("body");
    await expect(readFile(join(root, "old.txt"), "utf8")).rejects.toThrow();
  });

  it("creates destination parent directories", async () => {
    await writeFile(join(root, "old.txt"), "body", "utf8");
    const res = await moveFileTool.execute({ from: "old.txt", to: "nested/deep/new.txt" }, ctx());
    expect(res.ok).toBe(true);
    expect(await readFile(join(root, "nested", "deep", "new.txt"), "utf8")).toBe("body");
  });

  it("errors when the source does not exist", async () => {
    const res = await moveFileTool.execute({ from: "missing.txt", to: "new.txt" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("Source not found");
  });

  it("rejects a path escaping the workspace", async () => {
    await writeFile(join(root, "old.txt"), "body", "utf8");
    await expect(moveFileTool.execute({ from: "old.txt", to: "../evil.txt" }, ctx())).rejects.toThrow(
      /escapes the workspace sandbox/,
    );
  });
});

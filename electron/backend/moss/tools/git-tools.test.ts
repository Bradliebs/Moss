// Tests for the read-only git_status and git_diff tools. These run against a
// real temporary git repository so the spawned git process, the argument
// array, and the clean/dirty output paths are exercised end to end.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gitDiffTool, gitStatusTool } from "./git-tools";
import type { ToolContext } from "./types";

const run = promisify(execFile);

let root: string;

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { workspaceRoot: root, signal: new AbortController().signal, ...overrides };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "moss-git-"));
  await run("git", ["init", "--initial-branch=main"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await run("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "a.txt"), "original\n", "utf8");
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["commit", "-m", "init"], { cwd: root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("git_status", () => {
  it("reports a clean tree with its branch", async () => {
    const res = await gitStatusTool.execute({}, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("## main");
    expect(res.content).not.toContain("a.txt");
  });

  it("reports a modified file", async () => {
    await writeFile(join(root, "a.txt"), "changed\n", "utf8");
    const res = await gitStatusTool.execute({}, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("M a.txt");
  });

  it("fails without a workspace", async () => {
    const res = await gitStatusTool.execute({}, ctx({ workspaceRoot: "" }));
    expect(res.ok).toBe(false);
    expect(res.content).toContain("No workspace");
  });
});

describe("git_diff", () => {
  it("returns a placeholder when nothing changed", async () => {
    const res = await gitDiffTool.execute({}, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toBe("(no changes)");
  });

  it("returns a unified diff for an unstaged change", async () => {
    await writeFile(join(root, "a.txt"), "changed\n", "utf8");
    const res = await gitDiffTool.execute({}, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("-original");
    expect(res.content).toContain("+changed");
  });

  it("shows staged changes only when asked", async () => {
    await writeFile(join(root, "a.txt"), "changed\n", "utf8");
    await run("git", ["add", "a.txt"], { cwd: root });
    expect((await gitDiffTool.execute({}, ctx())).content).toBe("(no changes)");
    const staged = await gitDiffTool.execute({ staged: true }, ctx());
    expect(staged.content).toContain("+changed");
  });

  it("limits the diff to a given path", async () => {
    await writeFile(join(root, "a.txt"), "changed\n", "utf8");
    await writeFile(join(root, "b.txt"), "b\n", "utf8");
    await run("git", ["add", "b.txt"], { cwd: root });
    await run("git", ["commit", "-m", "add b"], { cwd: root });
    await writeFile(join(root, "b.txt"), "b changed\n", "utf8");
    const res = await gitDiffTool.execute({ path: "b.txt" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("b.txt");
    expect(res.content).not.toContain("a.txt");
  });

  it("treats a path that looks like a flag as a path, not an option", async () => {
    // `--` separates options from paths, so git resolves this as a pathspec
    // matching nothing rather than parsing it as an --output flag.
    const res = await gitDiffTool.execute({ path: "--output=/tmp/pwned" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toBe("(no changes)");
    expect(res.content).not.toContain("unknown option");
  });

  it("does not execute shell metacharacters in a path", async () => {
    const res = await gitDiffTool.execute({ path: "a.txt; echo pwned" }, ctx());
    expect(res.content).not.toContain("pwned\n");
  });
});

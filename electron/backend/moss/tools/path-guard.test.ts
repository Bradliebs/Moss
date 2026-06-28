// Tests for the workspace sandbox guard. The escape cases are the security
// boundary for every filesystem tool, so they are verified explicitly.

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveInWorkspace } from "./path-guard";

const root = resolve("test-workspace-root");

describe("resolveInWorkspace", () => {
  it("resolves a relative path inside the workspace", () => {
    expect(resolveInWorkspace(root, "file.txt")).toBe(resolve(root, "file.txt"));
  });

  it("resolves a nested relative path inside the workspace", () => {
    expect(resolveInWorkspace(root, "sub/dir/file.txt")).toBe(resolve(root, "sub/dir/file.txt"));
  });

  it("allows the workspace root itself", () => {
    expect(resolveInWorkspace(root, ".")).toBe(root);
    expect(resolveInWorkspace(root, root)).toBe(root);
  });

  it("rejects a parent-directory escape", () => {
    expect(() => resolveInWorkspace(root, "../evil.txt")).toThrow(/escapes the workspace sandbox/);
  });

  it("rejects an escape hidden by nested traversal", () => {
    expect(() => resolveInWorkspace(root, "a/../../evil.txt")).toThrow(/escapes the workspace sandbox/);
  });

  it("rejects an absolute path outside the workspace", () => {
    const outside = resolve(root, "..", "outside.txt");
    expect(() => resolveInWorkspace(root, outside)).toThrow(/escapes the workspace sandbox/);
  });

  it("rejects an empty path", () => {
    expect(() => resolveInWorkspace(root, "")).toThrow(/path is required/);
  });

  it("rejects when no workspace folder is selected", () => {
    expect(() => resolveInWorkspace("", "file.txt")).toThrow(/No workspace folder selected/);
  });
});

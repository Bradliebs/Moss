// electron/backend/moss/tools/path-guard.ts
//
// Resolves a tool-supplied path inside the workspace sandbox and rejects any
// path that escapes it (via `..`, absolute paths outside root, or a different
// drive on Windows).

import { isAbsolute, normalize, relative, resolve } from "node:path";

export function resolveInWorkspace(workspaceRoot: string, inputPath: string): string {
  if (!workspaceRoot) throw new Error("No workspace folder selected");
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new Error("path is required");
  }
  const abs = isAbsolute(inputPath) ? normalize(inputPath) : resolve(workspaceRoot, inputPath);
  const rel = relative(workspaceRoot, abs);
  if (rel === "" ) return abs; // the root itself
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes the workspace sandbox: ${inputPath}`);
  }
  return abs;
}

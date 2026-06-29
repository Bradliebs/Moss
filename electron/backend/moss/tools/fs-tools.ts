// electron/backend/moss/tools/fs-tools.ts

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { resolveInWorkspace } from "./path-guard";
import type { Tool, ToolContext, ToolResult } from "./types";

const MAX_READ_CHARS = 100_000;

// Directories never worth walking for a workspace text search.
const SEARCH_SKIP_DIRS = new Set([".git", "node_modules", "dist", "dist-electron", "release"]);

/** Count literal (non-regex) occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function clampInt(value: unknown, dflt: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read a UTF-8 text file from the workspace. Returns up to 100k characters.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "File path relative to the workspace root" } },
    required: ["path"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const abs = resolveInWorkspace(ctx.workspaceRoot, String(args.path ?? ""));
    const text = await readFile(abs, "utf8");
    const truncated = text.length > MAX_READ_CHARS;
    return {
      ok: true,
      content: truncated ? `${text.slice(0, MAX_READ_CHARS)}\n…[truncated]` : text,
    };
  },
};

export const listDirTool: Tool = {
  name: "list_dir",
  description: "List the entries of a directory in the workspace. Directories end with a trailing slash.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Directory path relative to the workspace root (default '.')" } },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const target = String(args.path ?? ".");
    const abs = resolveInWorkspace(ctx.workspaceRoot, target || ".");
    const entries = await readdir(abs, { withFileTypes: true });
    if (entries.length === 0) return { ok: true, content: "(empty)" };
    const lines = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => a.localeCompare(b));
    return { ok: true, content: lines.join("\n") };
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Create or overwrite a UTF-8 text file in the workspace. Parent directories are created as needed.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root" },
      content: { type: "string", description: "Full file contents to write" },
    },
    required: ["path", "content"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const abs = resolveInWorkspace(ctx.workspaceRoot, String(args.path ?? ""));
    const content = String(args.content ?? "");
    await ctx.checkpoint?.record(abs, String(args.path ?? ""));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    return { ok: true, content: `Wrote ${content.length} bytes to ${args.path}` };
  },
};

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Make a surgical edit to an existing workspace file by replacing an exact text snippet. Prefer this over write_file to change part of a file without rewriting the whole thing. oldText must match exactly (including whitespace) and be unique unless replaceAll is true.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root" },
      oldText: {
        type: "string",
        description: "Exact existing text to replace, including enough surrounding context to be unique",
      },
      newText: { type: "string", description: "Replacement text" },
      replaceAll: {
        type: "boolean",
        description: "Replace every occurrence instead of requiring a unique match (default false)",
      },
    },
    required: ["path", "oldText", "newText"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const abs = resolveInWorkspace(ctx.workspaceRoot, String(args.path ?? ""));
    const oldText = String(args.oldText ?? "");
    if (!oldText) return { ok: false, content: "oldText is required" };
    const newText = String(args.newText ?? "");
    const replaceAll = args.replaceAll === true;

    let text: string;
    try {
      text = await readFile(abs, "utf8");
    } catch {
      return { ok: false, content: `File not found: ${args.path}` };
    }

    const count = countOccurrences(text, oldText);
    if (count === 0) return { ok: false, content: `oldText not found in ${args.path}` };
    if (count > 1 && !replaceAll) {
      return {
        ok: false,
        content: `oldText matches ${count} places in ${args.path}; add surrounding context to make it unique, or set replaceAll to true`,
      };
    }

    // A replacement function keeps newText literal so "$&"/"$1" style sequences
    // are written verbatim rather than interpreted by String.prototype.replace.
    const updated = replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
    await ctx.checkpoint?.record(abs, String(args.path ?? ""));
    await writeFile(abs, updated, "utf8");
    const n = replaceAll ? count : 1;
    return { ok: true, content: `Replaced ${n} occurrence${n === 1 ? "" : "s"} in ${args.path}` };
  },
};

export const searchFilesTool: Tool = {
  name: "search_files",
  description:
    "Search the workspace for a literal, case-insensitive text string and return matching lines as 'path:line: text'. Skips .git, node_modules, and build output directories.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Literal text to search for (case-insensitive)" },
      path: {
        type: "string",
        description: "Directory to search under, relative to the workspace root (default '.')",
      },
      maxResults: { type: "number", description: "Maximum matching lines to return (default 100, max 1000)" },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = String(args.query ?? "");
    if (!query.trim()) return { ok: false, content: "query is required" };
    const searchRoot = resolveInWorkspace(ctx.workspaceRoot, String(args.path ?? ".") || ".");
    const maxResults = clampInt(args.maxResults, 100, 1, 1000);
    const needle = query.toLowerCase();

    const matches: string[] = [];
    await collectMatches(searchRoot, ctx, needle, matches, maxResults);

    if (matches.length === 0) return { ok: true, content: `No matches for "${query}"` };
    const capped = matches.length >= maxResults;
    const body = matches.join("\n");
    return { ok: true, content: capped ? `${body}\n…[capped at ${maxResults} matches]` : body };
  },
};

async function collectMatches(
  dir: string,
  ctx: ToolContext,
  needle: string,
  out: string[],
  max: number,
): Promise<void> {
  if (ctx.signal.aborted || out.length >= max) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return;
  for (const entry of entries) {
    if (ctx.signal.aborted || out.length >= max) return;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SEARCH_SKIP_DIRS.has(entry.name)) continue;
      await collectMatches(abs, ctx, needle, out, max);
      continue;
    }
    if (!entry.isFile()) continue;
    let text: string;
    try {
      text = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue; // skip binary files
    const lines = text.split(/\r?\n/);
    const rel = relative(ctx.workspaceRoot, abs).split(sep).join("/");
    for (let i = 0; i < lines.length; i++) {
      if (out.length >= max) return;
      if (lines[i].toLowerCase().includes(needle)) {
        out.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
      }
    }
  }
}

const GLOB_MAX_DEFAULT = 200;
const GLOB_MAX = 2000;

// Convert a glob to an anchored RegExp. `**`/`**` spans path segments, `*` stays
// within a segment, `?` is a single non-separator char. The `**/` token also
// matches zero directories so `**/*.ts` finds top-level files too.
function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:[^/]*\\/)*"; // **/ -> zero or more path segments
          i += 3;
        } else {
          re += ".*"; // trailing **
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (c === "/") {
      re += "\\/";
      i += 1;
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

export const globFilesTool: Tool = {
  name: "glob_files",
  description:
    "Find workspace files whose path matches a glob pattern. Supports '*' (within a path segment), '**' (across segments), and '?'. Returns matching paths one per line. Skips .git, node_modules, and build output directories.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern relative to the search root, e.g. 'src/**/*.ts'" },
      path: {
        type: "string",
        description: "Directory to search under, relative to the workspace root (default '.')",
      },
      maxResults: { type: "number", description: "Maximum paths to return (default 200, max 2000)" },
    },
    required: ["pattern"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = String(args.pattern ?? "");
    if (!pattern.trim()) return { ok: false, content: "pattern is required" };
    const searchRoot = resolveInWorkspace(ctx.workspaceRoot, String(args.path ?? ".") || ".");
    const max = clampInt(args.maxResults, GLOB_MAX_DEFAULT, 1, GLOB_MAX);
    const regex = globToRegExp(pattern);

    const out: string[] = [];
    await collectFiles(searchRoot, ctx, regex, searchRoot, out, max);
    if (out.length === 0) return { ok: true, content: `No files match "${pattern}"` };
    out.sort();
    const capped = out.length >= max;
    const body = out.join("\n");
    return { ok: true, content: capped ? `${body}\n\u2026[capped at ${max} matches]` : body };
  },
};

async function collectFiles(
  dir: string,
  ctx: ToolContext,
  regex: RegExp,
  searchRoot: string,
  out: string[],
  max: number,
): Promise<void> {
  if (ctx.signal.aborted || out.length >= max) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return;
  for (const entry of entries) {
    if (ctx.signal.aborted || out.length >= max) return;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SEARCH_SKIP_DIRS.has(entry.name)) continue;
      await collectFiles(abs, ctx, regex, searchRoot, out, max);
      continue;
    }
    if (!entry.isFile()) continue;
    const relMatch = relative(searchRoot, abs).split(sep).join("/");
    if (regex.test(relMatch)) {
      out.push(relative(ctx.workspaceRoot, abs).split(sep).join("/"));
    }
  }
}

export const moveFileTool: Tool = {
  name: "move_file",
  description:
    "Move or rename a file or directory within the workspace. The destination's parent directories are created as needed.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "Existing path relative to the workspace root" },
      to: { type: "string", description: "New path relative to the workspace root" },
    },
    required: ["from", "to"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const fromAbs = resolveInWorkspace(ctx.workspaceRoot, String(args.from ?? ""));
    const toAbs = resolveInWorkspace(ctx.workspaceRoot, String(args.to ?? ""));
    await ctx.checkpoint?.record(fromAbs, String(args.from ?? ""));
    await ctx.checkpoint?.record(toAbs, String(args.to ?? ""));
    try {
      await mkdir(dirname(toAbs), { recursive: true });
      await rename(fromAbs, toAbs);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return { ok: false, content: `Source not found: ${args.from}` };
      return { ok: false, content: e.message };
    }
    return { ok: true, content: `Moved ${args.from} to ${args.to}` };
  },
};

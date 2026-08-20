// electron/backend/moss/tools/shell-tool.ts
//
// Runs a shell command inside the workspace. This is the highest-risk tool and
// is always permission-gated (see permission.ts) — it is never auto-approved.

import { spawn } from "node:child_process";

import type { Tool, ToolContext, ToolResult } from "./types";

const OUTPUT_CAP = 20_000;
const TIMEOUT_MS = 60_000;

export const runCommandTool: Tool = {
  name: "run_command",
  description:
    "Run a shell command with its working directory set to the workspace root. Returns combined stdout/stderr.",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
  timeoutMs: TIMEOUT_MS,
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = String(args.command ?? "").trim();
    if (!command) return Promise.resolve({ ok: false, content: "command is required" });
    if (!ctx.workspaceRoot) {
      return Promise.resolve({ ok: false, content: "No workspace folder selected" });
    }

    return new Promise<ToolResult>((resolvePromise) => {
      const child = spawn(command, { cwd: ctx.workspaceRoot, shell: true });
      let out = "";
      let err = "";
      let settled = false;

      const onAbort = () => child.kill();
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const finish = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        ctx.signal.removeEventListener("abort", onAbort);
        resolvePromise(result);
      };

      child.stdout.on("data", (d: Buffer) => {
        if (out.length < OUTPUT_CAP) out += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        if (err.length < OUTPUT_CAP) err += d.toString();
      });
      child.on("error", (e: Error) => finish({ ok: false, content: e.message }));
      child.on("close", (code: number | null) => {
        const body = [out.trim(), err.trim() ? `[stderr]\n${err.trim()}` : ""]
          .filter(Boolean)
          .join("\n");
        finish({ ok: code === 0, content: body || `(exited with code ${code})` });
      });
    });
  },
};

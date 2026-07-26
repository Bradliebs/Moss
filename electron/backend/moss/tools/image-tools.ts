// electron/backend/moss/tools/image-tools.ts
//
// Lets the model look at an image in the workspace: screenshots the browser and
// desktop tools already save, diagrams, design mockups, failing-UI captures.
//
// The image is identified by its magic bytes rather than its file extension, so
// a mislabelled or hostile file cannot talk us into declaring a media type the
// bytes do not support. Anything unrecognised is refused rather than guessed at.

import { readFile, stat } from "node:fs/promises";

import { resolveInWorkspace } from "./path-guard";
import type { Tool, ToolContext, ToolResult } from "./types";

/** Refuse anything larger than this. Images cost roughly a token per 750 bytes
 *  of base64 once encoded, so a few megabytes is already a large slice of the
 *  context window; better to fail loudly than to silently blow the budget. */
const MAX_BYTES = 4_000_000;

type Sniffed = { mediaType: string };

/** Identify an image by its leading bytes. Returns null for anything we cannot
 *  positively recognise, including text files renamed to .png. */
function sniff(buf: Buffer): Sniffed | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mediaType: "image/png" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mediaType: "image/jpeg" };
  }
  if (buf.length >= 6 && buf.subarray(0, 6).toString("latin1").match(/^GIF8[79]a$/)) {
    return { mediaType: "image/gif" };
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { mediaType: "image/webp" };
  }
  return null;
}

export const viewImageTool: Tool = {
  name: "view_image",
  description:
    "Look at an image file in the workspace, such as a screenshot you just captured. Supports PNG, JPEG, GIF and WebP.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", minLength: 1, description: "Workspace-relative image path" } },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    let abs: string;
    try {
      abs = resolveInWorkspace(ctx.workspaceRoot, String(args.path ?? ""));
    } catch (err) {
      return { ok: false, content: (err as Error).message };
    }

    try {
      // Size is checked before reading so an oversized file is never pulled
      // into memory just to be rejected.
      const info = await stat(abs);
      if (!info.isFile()) return { ok: false, content: `Not a file: ${String(args.path)}` };
      if (info.size === 0) return { ok: false, content: `Image is empty: ${String(args.path)}` };
      if (info.size > MAX_BYTES) {
        return {
          ok: false,
          content: `Image is ${Math.round(info.size / 1000)}kB, over the ${Math.round(MAX_BYTES / 1000)}kB limit. Resize or crop it first.`,
        };
      }

      const buf = await readFile(abs);
      const kind = sniff(buf);
      if (!kind) {
        return { ok: false, content: `Not a supported image (expected PNG, JPEG, GIF or WebP): ${String(args.path)}` };
      }

      return {
        ok: true,
        content: `Viewing ${String(args.path)} (${kind.mediaType}, ${Math.round(buf.length / 1000)}kB)`,
        images: [`data:${kind.mediaType};base64,${buf.toString("base64")}`],
      };
    } catch (err) {
      return { ok: false, content: `Could not read image: ${(err as Error).message}` };
    }
  },
};

export const IMAGE_TOOLS: Tool[] = [viewImageTool];

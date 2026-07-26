// Tests for view_image: sandbox containment, magic-byte identification, and the
// size guard that keeps a large capture from swallowing the context window.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { viewImageTool } from "./image-tools";
import type { ToolContext } from "./types";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let root = "";

function ctx(workspaceRoot = root): ToolContext {
  return { workspaceRoot, signal: new AbortController().signal };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "moss-img-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("view_image", () => {
  it("returns a png as a data URL", async () => {
    await writeFile(join(root, "shot.png"), Buffer.concat([PNG_HEADER, Buffer.alloc(32)]));
    const res = await viewImageTool.execute({ path: "shot.png" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.images).toHaveLength(1);
    expect(res.images?.[0]).toMatch(/^data:image\/png;base64,/);
    expect(res.content).toContain("image/png");
  });

  it("identifies jpeg, gif and webp by their bytes", async () => {
    await writeFile(join(root, "a.jpg"), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)]));
    await writeFile(join(root, "b.gif"), Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(16)]));
    await writeFile(
      join(root, "c.webp"),
      Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBP", "latin1"), Buffer.alloc(16)]),
    );
    expect((await viewImageTool.execute({ path: "a.jpg" }, ctx())).images?.[0]).toMatch(/^data:image\/jpeg;/);
    expect((await viewImageTool.execute({ path: "b.gif" }, ctx())).images?.[0]).toMatch(/^data:image\/gif;/);
    expect((await viewImageTool.execute({ path: "c.webp" }, ctx())).images?.[0]).toMatch(/^data:image\/webp;/);
  });

  it("trusts the bytes, not the extension", async () => {
    await writeFile(join(root, "fake.png"), "this is plain text, not an image");
    const res = await viewImageTool.execute({ path: "fake.png" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("Not a supported image");
    expect(res.images).toBeUndefined();
  });

  it("refuses a path that escapes the workspace", async () => {
    const res = await viewImageTool.execute({ path: "../outside.png" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("escapes the workspace");
  });

  it("refuses to run with no workspace selected", async () => {
    const res = await viewImageTool.execute({ path: "shot.png" }, ctx(""));
    expect(res.ok).toBe(false);
  });

  it("rejects an oversized image before encoding it", async () => {
    await writeFile(join(root, "huge.png"), Buffer.concat([PNG_HEADER, Buffer.alloc(4_100_000)]));
    const res = await viewImageTool.execute({ path: "huge.png" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("limit");
    expect(res.images).toBeUndefined();
  });

  it("rejects an empty file", async () => {
    await writeFile(join(root, "empty.png"), "");
    expect((await viewImageTool.execute({ path: "empty.png" }, ctx())).ok).toBe(false);
  });

  it("reports a missing file without throwing", async () => {
    const res = await viewImageTool.execute({ path: "nope.png" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("Could not read image");
  });

  it("rejects a directory", async () => {
    const res = await viewImageTool.execute({ path: "." }, ctx());
    expect(res.ok).toBe(false);
  });
});

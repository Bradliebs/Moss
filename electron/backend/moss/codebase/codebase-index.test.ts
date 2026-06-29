// electron/backend/moss/codebase/codebase-index.test.ts
//
// Tests the semantic index store with a stubbed embeddings client, so vectors
// are deterministic and no network is involved. embedTexts is mocked to project
// each text onto counts of the marker words alpha/beta/gamma, which makes cosine
// ranking predictable.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { embedTexts } from "../providers/embeddings";
import { CodebaseIndex } from "./codebase-index";

vi.mock("../providers/embeddings", () => {
  const count = (t: string, w: string) => t.toLowerCase().split(w).length - 1;
  return {
    embedTexts: vi.fn(async (_config: unknown, input: string[]) =>
      input.map((t) => [count(t, "alpha"), count(t, "beta"), count(t, "gamma")]),
    ),
  };
});

const config = { baseUrl: "http://x", model: "embed-v1" };

let base: string;
let ws: string;
let index: CodebaseIndex;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "moss-idx-base-"));
  ws = mkdtempSync(join(tmpdir(), "moss-idx-ws-"));
  index = new CodebaseIndex(base);
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

describe("CodebaseIndex", () => {
  it("rejects an empty workspace or missing model", async () => {
    expect((await index.reindex("", config)).error).toMatch(/No workspace/);
    expect((await index.reindex(ws, { ...config, model: "" })).error).toMatch(/No embedding model/);
  });

  it("reports no index before one is built", async () => {
    expect(await index.status(ws)).toEqual({ indexed: false, files: 0, chunks: 0, model: "" });
    expect(await index.search(ws, config, "alpha")).toEqual([]);
  });

  it("indexes text files and reports status", async () => {
    writeFileSync(join(ws, "a.txt"), "alpha alpha line");
    writeFileSync(join(ws, "b.txt"), "beta content");

    const res = await index.reindex(ws, config);
    expect(res.ok).toBe(true);
    expect(res.files).toBe(2);
    expect(res.chunks).toBe(2);

    const status = await index.status(ws);
    expect(status).toMatchObject({ indexed: true, files: 2, chunks: 2, model: "embed-v1" });
  });

  it("ranks search hits by cosine similarity", async () => {
    writeFileSync(join(ws, "a.txt"), "alpha alpha line");
    writeFileSync(join(ws, "b.txt"), "beta content");
    await index.reindex(ws, config);

    const hits = await index.search(ws, config, "alpha");
    expect(hits[0].path).toBe("a.txt");
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[0].startLine).toBe(1);
  });

  it("reuses unchanged files and only re-embeds changed ones", async () => {
    writeFileSync(join(ws, "a.txt"), "alpha");
    writeFileSync(join(ws, "b.txt"), "beta");
    await index.reindex(ws, config);

    vi.mocked(embedTexts).mockClear();
    writeFileSync(join(ws, "b.txt"), "gamma gamma");
    const future = new Date(Date.now() + 10_000);
    utimesSync(join(ws, "b.txt"), future, future);

    const res = await index.reindex(ws, config);
    expect(res.skipped).toBe(1); // a.txt reused
    expect(res.files).toBe(2);
    expect(vi.mocked(embedTexts)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(embedTexts).mock.calls[0][1]).toEqual(["gamma gamma"]);
  });

  it("rebuilds fully when the embedding model changes", async () => {
    writeFileSync(join(ws, "a.txt"), "alpha");
    await index.reindex(ws, config);

    vi.mocked(embedTexts).mockClear();
    const res = await index.reindex(ws, { ...config, model: "embed-v2" });
    expect(res.skipped).toBe(0);
    expect(vi.mocked(embedTexts)).toHaveBeenCalled();
    expect((await index.status(ws)).model).toBe("embed-v2");
  });

  it("skips .gitignore'd paths", async () => {
    writeFileSync(join(ws, ".gitignore"), "secret.txt\nbuildlogs/\n");
    writeFileSync(join(ws, "secret.txt"), "alpha");
    mkdirSync(join(ws, "buildlogs"));
    writeFileSync(join(ws, "buildlogs", "x.txt"), "alpha");
    writeFileSync(join(ws, "keep.txt"), "alpha");

    const res = await index.reindex(ws, config);
    expect(res.files).toBe(2); // keep.txt + .gitignore itself

    const hits = await index.search(ws, config, "alpha");
    expect(hits.some((h) => h.path === "keep.txt")).toBe(true);
    expect(hits.every((h) => h.path !== "secret.txt" && !h.path.startsWith("buildlogs/"))).toBe(true);
  });

  it("skips binary files", async () => {
    writeFileSync(join(ws, "bin.dat"), "a\u0000b");
    writeFileSync(join(ws, "ok.txt"), "alpha");
    const res = await index.reindex(ws, config);
    expect(res.files).toBe(1);
  });
});

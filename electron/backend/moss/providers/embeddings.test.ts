// electron/backend/moss/providers/embeddings.test.ts
//
// Unit tests for the OpenAI-compatible /embeddings client. Global fetch is
// stubbed; no Electron dependency.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { EmbedConfig } from "../../../../common/types";
import { embedTexts } from "./embeddings";

afterEach(() => {
  vi.unstubAllGlobals();
});

const config: EmbedConfig = { baseUrl: "http://localhost:11434/v1", model: "nomic-embed-text" };

describe("embedTexts", () => {
  it("returns an empty array without calling fetch for empty input", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await embedTexts(config, [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to /embeddings and returns one vector per input in order", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await embedTexts(config, ["a", "b"]);
    expect(out).toEqual([
      [1, 2],
      [3, 4],
    ]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:11434/v1/embeddings");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ model: "nomic-embed-text", input: ["a", "b"] });
  });

  it("sends a bearer token only when an apiKey is provided", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [0] }] }) }));
    vi.stubGlobal("fetch", fetchMock);

    await embedTexts({ ...config, apiKey: "secret" }, ["x"]);
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe("Bearer secret");

    fetchMock.mockClear();
    await embedTexts(config, ["x"]);
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBeUndefined();
  });

  it("throws with the status code on a non-ok response", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 502, text: async () => "down" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(embedTexts(config, ["x"])).rejects.toThrow(/Embeddings request failed: HTTP 502 down/);
  });

  it("throws when the response vector count does not match the input count", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [1] }] }) }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(embedTexts(config, ["a", "b"])).rejects.toThrow(/size mismatch: got 1 vectors for 2 inputs/);
  });
});

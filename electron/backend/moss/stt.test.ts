// electron/backend/moss/stt.test.ts
//
// Unit tests for the speech-to-text transcription call. stt.ts uses global
// fetch/FormData/Blob (no Electron), so a stubbed fetch is all that's needed.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TranscribeRequest } from "../../../common/types";
import { transcribeAudio } from "./stt";

afterEach(() => {
  vi.unstubAllGlobals();
});

const audio = Buffer.from("hello-audio").toString("base64");

function req(overrides: Partial<TranscribeRequest> = {}): TranscribeRequest {
  return {
    audioBase64: audio,
    mimeType: "audio/webm",
    baseUrl: "http://localhost:8000/v1",
    model: "whisper-1",
    ...overrides,
  };
}

describe("transcribeAudio", () => {
  it("throws when no endpoint is configured", async () => {
    await expect(transcribeAudio(req({ baseUrl: "  " }))).rejects.toThrow(/No transcription endpoint/);
  });

  it("throws when the audio is empty", async () => {
    await expect(transcribeAudio(req({ audioBase64: "" }))).rejects.toThrow(/No audio captured/);
  });

  it("posts to /audio/transcriptions and returns the trimmed text", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ text: "  hi there  " }) }));
    vi.stubGlobal("fetch", fetchMock);

    const text = await transcribeAudio(req());
    expect(text).toBe("hi there");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8000/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get("model")).toBe("whisper-1");
  });

  it("sends a bearer token only when an apiKey is provided", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ text: "x" }) }));
    vi.stubGlobal("fetch", fetchMock);

    await transcribeAudio(req({ apiKey: "secret" }));
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer secret");

    fetchMock.mockClear();
    await transcribeAudio(req());
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("throws with the status code on a non-ok response", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeAudio(req())).rejects.toThrow(/Transcription failed \(HTTP 500\): boom/);
  });

  it("wraps a network failure", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeAudio(req())).rejects.toThrow(/Transcription request failed: offline/);
  });

  it("defaults the model to whisper-1 when none is given", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ text: "x" }) }));
    vi.stubGlobal("fetch", fetchMock);
    await transcribeAudio(req({ model: "" }));
    expect(fetchMock.mock.calls[0][1].body.get("model")).toBe("whisper-1");
  });
});

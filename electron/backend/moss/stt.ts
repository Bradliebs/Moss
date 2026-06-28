// electron/backend/moss/stt.ts
//
// Speech-to-text via the OpenAI-compatible /audio/transcriptions endpoint.
// This runs Whisper through whatever endpoint the user configures: OpenAI,
// or a local server that implements the same route (whisper.cpp's
// whisper-server, faster-whisper-server, LocalAI, Speaches, …). The POST is
// made from the main process so it is not constrained by the renderer CSP.

import type { TranscribeRequest } from "../../../common/types";

import { joinUrl } from "./providers/http";

function extensionFor(mimeType: string): string {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "mp4";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("flac")) return "flac";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

export async function transcribeAudio(req: TranscribeRequest): Promise<string> {
  const baseUrl = req.baseUrl.trim();
  if (!baseUrl) throw new Error("No transcription endpoint configured");

  const bytes = Buffer.from(req.audioBase64, "base64");
  if (bytes.length === 0) throw new Error("No audio captured");

  const mimeType = req.mimeType || "audio/webm";
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), `audio.${extensionFor(mimeType)}`);
  form.append("model", req.model || "whisper-1");

  const headers: Record<string, string> = {};
  if (req.apiKey) headers.Authorization = `Bearer ${req.apiKey}`;

  let res: Response;
  try {
    res = await fetch(joinUrl(baseUrl, "/audio/transcriptions"), {
      method: "POST",
      headers,
      body: form,
    });
  } catch (e) {
    throw new Error(`Transcription request failed: ${(e as Error).message}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Transcription failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }

  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}

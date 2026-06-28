// electron/backend/moss/tools/transcribe-tool.ts
//
// Model-callable tool: transcribe a local audio file via the configured Whisper
// (OpenAI-compatible /audio/transcriptions) endpoint. The file is resolved
// inside the workspace sandbox; the network POST runs in the main process. Like
// the other network tools it is approval-gated (not in AUTO_ALLOW).

import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { transcribeAudio } from "../stt";
import { resolveInWorkspace } from "./path-guard";
import type { Tool } from "./types";

const MIME_BY_EXT: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".webm": "audio/webm",
  ".flac": "audio/flac",
};

export const transcribeAudioTool: Tool = {
  name: "transcribe_audio",
  description:
    "Transcribe a local audio file to text using the configured speech-to-text endpoint. " +
    "Provide a path to an audio file (wav, mp3, m4a, ogg, webm, flac) inside the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the audio file, relative to the workspace root.",
      },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const rel = typeof args.path === "string" ? args.path.trim() : "";
    if (!rel) return { ok: false, content: "path is required" };
    if (!ctx.stt?.baseUrl) {
      return { ok: false, content: "No speech-to-text endpoint configured (set one in Settings)." };
    }

    let abs: string;
    try {
      abs = resolveInWorkspace(ctx.workspaceRoot, rel);
    } catch (e) {
      return { ok: false, content: (e as Error).message };
    }

    let bytes: Buffer;
    try {
      bytes = readFileSync(abs);
    } catch (e) {
      return { ok: false, content: `Cannot read ${rel}: ${(e as Error).message}` };
    }

    const mimeType = MIME_BY_EXT[extname(abs).toLowerCase()] ?? "audio/webm";
    try {
      const text = await transcribeAudio({
        audioBase64: bytes.toString("base64"),
        mimeType,
        baseUrl: ctx.stt.baseUrl,
        apiKey: ctx.stt.apiKey,
        model: ctx.stt.model,
      });
      return { ok: true, content: text || "(no speech detected)" };
    } catch (e) {
      return { ok: false, content: (e as Error).message };
    }
  },
};

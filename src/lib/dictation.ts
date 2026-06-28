// src/lib/dictation.ts
//
// Push-to-talk microphone capture that transcribes through the main-process
// Whisper endpoint (window.moss.stt.transcribe). Recording happens in the
// renderer (MediaRecorder); the audio bytes are handed to the main process for
// the network POST, so the renderer CSP never has to allow the STT host.

import { useCallback, useRef, useState } from "react";

import { settingsStore } from "./settings";

export type DictationState = "idle" | "recording" | "transcribing";

export interface Dictation {
  state: DictationState;
  error: string | null;
  toggle: () => void;
}

/** Encode bytes to base64 without overflowing the call stack on large buffers. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function useDictation(onText: (text: string) => void): Dictation {
  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const start = useCallback(async () => {
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setError(`Microphone unavailable: ${(e as Error).message}`);
      return;
    }

    const recorder = new MediaRecorder(stream);
    chunksRef.current = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunksRef.current.push(ev.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      void finishTranscription(blob);
    };

    const finishTranscription = async (blob: Blob): Promise<void> => {
      if (blob.size === 0) {
        setState("idle");
        return;
      }
      setState("transcribing");
      try {
        const buffer = new Uint8Array(await blob.arrayBuffer());
        const s = settingsStore.get();
        const res = await window.moss.stt.transcribe({
          audioBase64: bytesToBase64(buffer),
          mimeType: blob.type,
          baseUrl: (s.sttBaseUrl || s.baseUrl || "").trim(),
          apiKey: s.apiKey || undefined,
          model: s.sttModel || "whisper-1",
        });
        if (res.error) setError(res.error);
        else if (res.text) onText(res.text);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setState("idle");
      }
    };

    recorderRef.current = recorder;
    recorder.start();
    setState("recording");
  }, [onText]);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
  }, []);

  const toggle = useCallback(() => {
    if (state === "recording") stop();
    else if (state === "idle") void start();
  }, [state, start, stop]);

  return { state, error, toggle };
}

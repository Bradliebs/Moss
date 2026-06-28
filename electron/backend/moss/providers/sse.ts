// electron/backend/moss/providers/sse.ts
//
// Server-Sent-Events line reader over a fetch Response body. Works against the
// undici (web) ReadableStream that Electron's global fetch returns. Yields the
// raw payload string following each `data:` field.

/** `body` is the `ReadableStream<Uint8Array>` from a fetch Response. Typed as
 *  `unknown` and narrowed via `getReader` to avoid pulling DOM lib types into
 *  the Node-targeted main-process tsconfig. */
export async function* readSSE(body: unknown, signal: AbortSignal): AsyncGenerator<string> {
  const reader = (body as { getReader: () => ReadableStreamReader }).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      if (value) buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of block.split("\n")) {
          const trimmed = line.trimStart();
          if (trimmed.startsWith("data:")) yield trimmed.slice(5).trim();
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* stream already closed */
    }
  }
}

interface ReadableStreamReader {
  read: () => Promise<{ done: boolean; value: Uint8Array | undefined }>;
  releaseLock: () => void;
}

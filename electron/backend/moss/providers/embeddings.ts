// electron/backend/moss/providers/embeddings.ts
//
// Minimal client for an OpenAI-compatible POST /embeddings endpoint (Ollama's
// /v1, OpenAI, LM Studio, LocalAI, …). Used by the codebase index to vectorize
// file chunks and queries. Anthropic has no embeddings endpoint, so this is
// configured independently of the chat provider.

import type { EmbedConfig } from "../../../../common/types";
import { joinUrl, safeText } from "./http";
import { ProviderError } from "./types";

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

/** Embed one or more texts, returning one vector per input in the same order.
 *  Throws ProviderError on a non-2xx response or a malformed/size-mismatched
 *  body so the caller can surface a clear failure rather than indexing garbage. */
export async function embedTexts(
  config: EmbedConfig,
  input: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  if (input.length === 0) return [];
  const res = await fetch(joinUrl(config.baseUrl, "/embeddings"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: config.model, input }),
    signal,
  });
  if (!res.ok) {
    throw new ProviderError(`Embeddings request failed: HTTP ${res.status} ${await safeText(res)}`, res.status);
  }
  const json = (await res.json()) as EmbeddingResponse;
  const data = json.data ?? [];
  if (data.length !== input.length) {
    throw new ProviderError(`Embeddings response size mismatch: got ${data.length} vectors for ${input.length} inputs`);
  }
  return data.map((d) => d.embedding ?? []);
}

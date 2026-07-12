// electron/backend/moss/providers/openai-compatible.test.ts
//
// Unit tests for the OpenAI-compatible provider. Global fetch is stubbed to
// return canned SSE bodies and model lists, so these exercise the provider's own
// logic: streaming text deltas, accumulating streamed tool calls, flushing on
// finish_reason / [DONE], surfacing usage, and HTTP error handling.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatRequest } from "./types";
import { OpenAiCompatibleProvider, toOpenAiMessages } from "./openai-compatible";

/** Minimal stand-in for the fetch Response body's ReadableStream: hands back the
 *  whole SSE payload as a single chunk, then signals done. */
function bodyFrom(sse: string) {
  const chunk = new TextEncoder().encode(sse);
  let sent = false;
  return {
    getReader() {
      return {
        async read() {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: chunk };
        },
        releaseLock() {
          /* no-op */
        },
      };
    },
  };
}

function stubStream(sse: string, init?: { ok?: boolean; status?: number }) {
  const ok = init?.ok ?? true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status: init?.status ?? (ok ? 200 : 500),
      body: ok ? bodyFrom(sse) : undefined,
      text: async () => sse,
    })),
  );
}

function sse(...chunks: object[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

const req: ChatRequest = { model: "m", messages: [{ role: "user", content: "hi" }] };

async function collect(provider: OpenAiCompatibleProvider) {
  const events = [];
  for await (const e of provider.streamChat(req, new AbortController().signal)) events.push(e);
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAiCompatibleProvider.streamChat", () => {
  it("yields text deltas from streamed content", async () => {
    stubStream(
      sse(
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: { content: " world" } }] },
      ),
    );
    const events = await collect(new OpenAiCompatibleProvider("http://x/v1"));
    expect(events).toEqual([
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: " world" },
    ]);
  });

  it("accumulates a streamed tool call and flushes on finish_reason", async () => {
    stubStream(
      sse(
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "do_thing" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ),
    );
    const events = await collect(new OpenAiCompatibleProvider("http://x/v1"));
    const toolCalls = events.filter((e) => e.type === "tool-call");
    expect(toolCalls).toEqual([
      { type: "tool-call", toolCall: { id: "t1", name: "do_thing", arguments: '{"a":1}' } },
    ]);
  });

  it("flushes accumulated tool calls on [DONE] when no finish_reason arrives", async () => {
    stubStream(
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t9", function: { name: "f", arguments: "{}" } }] } }] }),
    );
    const events = await collect(new OpenAiCompatibleProvider("http://x/v1"));
    expect(events).toEqual([
      { type: "tool-call", toolCall: { id: "t9", name: "f", arguments: "{}" } },
    ]);
  });

  it("surfaces token usage", async () => {
    stubStream(sse({ usage: { prompt_tokens: 11, completion_tokens: 22 } }));
    const events = await collect(new OpenAiCompatibleProvider("http://x/v1"));
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 11, outputTokens: 22 } });
  });

  it("throws with the HTTP status on a failed response", async () => {
    stubStream("upstream boom", { ok: false, status: 503 });
    await expect(collect(new OpenAiCompatibleProvider("http://x/v1"))).rejects.toThrow(/HTTP 503/);
  });
});

describe("OpenAiCompatibleProvider.listModels", () => {
  it("returns model ids, dropping empty entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "a" }, { id: "" }, { id: "b" }, {}] }),
      })),
    );
    const models = await new OpenAiCompatibleProvider("http://x/v1").listModels();
    expect(models).toEqual(["a", "b"]);
  });

  it("throws on a failed model list request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, text: async () => "nope" })),
    );
    await expect(new OpenAiCompatibleProvider("http://x/v1").listModels()).rejects.toThrow(/HTTP 500/);
  });
});

describe("toOpenAiMessages", () => {
  it("emits a content-parts array for a user message with images", () => {
    const out = toOpenAiMessages([
      { role: "user", content: "what is this?", images: ["data:image/png;base64,AAAA"] },
    ]);
    expect(out).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ]);
  });

  it("expands structured document attachments only in the provider payload", () => {
    const message = {
      role: "user" as const,
      content: "summarize this",
      documents: [{ name: "notes.txt", mediaType: "text/plain", text: "private file body" }],
    };

    expect(toOpenAiMessages([message])).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "summarize this" },
          {
            type: "text",
            text: "--- BEGIN ATTACHED FILE: notes.txt (text/plain) ---\nprivate file body\n--- END ATTACHED FILE: notes.txt ---",
          },
        ],
      },
    ]);
    expect(message.content).toBe("summarize this");
  });

  it("keeps a plain string for a user message with no images", () => {
    expect(toOpenAiMessages([{ role: "user", content: "hi" }])).toEqual([{ role: "user", content: "hi" }]);
  });
});

import { describe, expect, it } from "vitest";

import type { AgentMessage } from "../../../../common/types";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../providers/types";
import { attachCompactionSummary, buildCompactionTranscript, summarizeCompactedContext } from "./compaction-summary";

function providerFor(events: ProviderStreamEvent[]): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    kind: "stub",
    requests,
    async *streamChat(request): AsyncIterable<ProviderStreamEvent> {
      requests.push(request);
      for (const event of events) yield event;
    },
    async listModels() {
      return [];
    },
  };
}

describe("semantic context compaction", () => {
  it("builds a bounded transcript without raw tool results or arguments", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Keep decision ALPHA" },
      {
        role: "assistant",
        content: "Selected parser.ts",
        toolCalls: [{ id: "c1", name: "read_file", arguments: '{"secret":"do-not-copy"}' }],
      },
      { role: "tool", content: "raw-secret-output", toolCallId: "c1" },
    ];

    const transcript = buildCompactionTranscript(messages);

    expect(transcript).toContain("Keep decision ALPHA");
    expect(transcript).toContain("ASSISTANT USED TOOL: read_file");
    expect(transcript).not.toContain("do-not-copy");
    expect(transcript).not.toContain("raw-secret-output");
  });

  it("requests a bounded tool-free summary and reports its usage", async () => {
    const provider = providerFor([
      { type: "text-delta", text: "Chose parser.ts because it owns tokenization." },
      { type: "usage", usage: { inputTokens: 120, outputTokens: 20 } },
    ]);

    const result = await summarizeCompactedContext(
      provider,
      "test-model",
      [{ role: "user", content: "Use parser.ts" }],
      { signal: new AbortController().signal, contextLimit: 8_192 },
    );

    expect(result).toEqual({
      ok: true,
      summary: "Chose parser.ts because it owns tokenization.",
      usage: { inputTokens: 120, outputTokens: 20 },
    });
    expect(provider.requests[0].tools).toBeUndefined();
    expect(provider.requests[0].maxTokens).toBe(512);
  });

  it("caps summary text when a provider ignores the requested token limit", async () => {
    const provider = providerFor([{ type: "text-delta", text: "x".repeat(4_096) }]);

    const result = await summarizeCompactedContext(
      provider,
      "test-model",
      [{ role: "user", content: "Keep the earlier decision" }],
      { signal: new AbortController().signal },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toHaveLength(2_048);
  });

  it("inserts generated history as an assistant message rather than system authority", () => {
    const attached = attachCompactionSummary(
      [
        { role: "system", content: "trusted rules" },
        { role: "user", content: "latest request" },
      ],
      "Earlier decision",
    );

    expect(attached.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(attached[0].content).toBe("trusted rules");
    expect(attached[2].content).toBe("Earlier decision");
  });
});
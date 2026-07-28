// electron/backend/moss/context/handoff.test.ts

import { describe, expect, it } from "vitest";

import type { AgentMessage } from "../../../../common/types";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../providers/types";
import { buildTranscript, summarizeForHandoff } from "./handoff";

/** Provider stub that records the request and replays fixed stream events. */
function stubProvider(
  events: ProviderStreamEvent[] | (() => AsyncIterable<ProviderStreamEvent>),
): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    kind: "stub",
    requests,
    streamChat(req: ChatRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push(req);
      if (typeof events === "function") return events();
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
    listModels: async () => [],
  };
}

const convo: AgentMessage[] = [
  { role: "user", content: "Refactor the tokenizer" },
  {
    role: "assistant",
    content: "Reading it first",
    toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"tokenizer.ts"}' }],
  },
  { role: "tool", content: "…4000 lines of file body…", toolCallId: "c1", risk: "readonly" },
  { role: "assistant", content: "Split it into lexer and parser" },
];

describe("buildTranscript", () => {
  it("keeps user and assistant turns and names the tools that ran", () => {
    const t = buildTranscript(convo);
    expect(t).toContain("USER: Refactor the tokenizer");
    expect(t).toContain("ASSISTANT: Split it into lexer and parser");
    expect(t).toContain('ASSISTANT ran tool: read_file({"path":"tokenizer.ts"})');
  });

  it("omits tool results, which are bulk rather than decisions", () => {
    expect(buildTranscript(convo)).not.toContain("4000 lines of file body");
  });

  it("drops the middle with an explicit marker when over budget, keeping the opening and the tail", () => {
    const big: AgentMessage[] = [
      { role: "user", content: "THE ORIGINAL GOAL" },
      ...Array.from({ length: 60 }, (_, i) => ({ role: "assistant" as const, content: `filler ${i} ${"x".repeat(1900)}` })),
      { role: "assistant", content: "THE LATEST STATE" },
    ];
    const t = buildTranscript(big);
    expect(t).toContain("THE ORIGINAL GOAL");
    expect(t).toContain("THE LATEST STATE");
    expect(t).toMatch(/\[… \d+ messages from the middle of the conversation omitted …\]/);
    expect(t.length).toBeLessThan(70_000);
  });
});

describe("summarizeForHandoff", () => {
  it("returns the accumulated text and offers the model no tools", async () => {
    const provider = stubProvider([
      { type: "text-delta", text: "## Goal\n" },
      { type: "text-delta", text: "Split the tokenizer." },
    ]);
    const result = await summarizeForHandoff(provider, "gpt-4", convo, "Refactor the parser");
    expect(result).toEqual({ ok: true, summary: "## Goal\nSplit the tokenizer." });
    expect(provider.requests[0].tools).toBeUndefined();
    expect(provider.requests[0].messages[0].role).toBe("system");
    expect(provider.requests[0].messages[1].content).toContain("Conversation title: Refactor the parser");
  });

  it("reports a provider failure instead of throwing, so the caller can fall back", async () => {
    const provider = stubProvider(() =>
      (async function* (): AsyncIterable<ProviderStreamEvent> {
        yield { type: "text-delta", text: "partial" };
        throw new Error("429 rate limited");
      })(),
    );
    const result = await summarizeForHandoff(provider, "gpt-4", convo, "t");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("429 rate limited");
  });

  it("treats an empty response as a failure", async () => {
    const result = await summarizeForHandoff(stubProvider([{ type: "text-delta", text: "  " }]), "gpt-4", convo, "t");
    expect(result.ok).toBe(false);
  });

  it("refuses a conversation with nothing to summarize", async () => {
    const result = await summarizeForHandoff(stubProvider([]), "gpt-4", [], "t");
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("");
  });
});

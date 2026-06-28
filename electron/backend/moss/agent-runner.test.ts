// electron/backend/moss/agent-runner.test.ts
//
// Unit tests for the agentic turn loop. A scripted ChatProvider feeds the runner
// canned stream events and a fake tool registry stands in for real tools, so the
// tests exercise the loop's own behavior: streaming, tool dispatch, permission
// gating, error isolation, abort handling, and the round cap.

import { describe, expect, it, vi } from "vitest";

import type { AgentMessage, MossEvent, ToolDefinition } from "../../../common/types";
import { runTurn } from "./agent-runner";
import type { ChatProvider, ProviderStreamEvent } from "./providers/types";
import type { Tool, ToolResult } from "./tools";

/** Provider that replays one event array per round, clamping to the last entry
 *  so a single-round script can drive the round-cap test. */
function scriptedProvider(rounds: ProviderStreamEvent[][]): ChatProvider {
  let round = 0;
  return {
    kind: "test",
    async *streamChat(): AsyncIterable<ProviderStreamEvent> {
      const events = rounds[Math.min(round, rounds.length - 1)];
      round += 1;
      for (const e of events) yield e;
    },
    async listModels() {
      return [];
    },
  };
}

function throwingProvider(message: string): ChatProvider {
  return {
    kind: "test",
    // eslint-disable-next-line require-yield
    async *streamChat(): AsyncIterable<ProviderStreamEvent> {
      throw new Error(message);
    },
    async listModels() {
      return [];
    },
  };
}

function tool(name: string, result: ToolResult | (() => Promise<ToolResult>)): Tool {
  return {
    name,
    description: "",
    parameters: { type: "object", properties: {} },
    execute: typeof result === "function" ? result : async () => result,
  };
}

function call(id: string, name: string, args = "{}"): ProviderStreamEvent {
  return { type: "tool-call", toolCall: { id, name, arguments: args } };
}

interface Harness {
  events: MossEvent[];
  approvals: string[];
}

async function run(
  provider: ChatProvider,
  tools: Tool[],
  opts?: { approve?: boolean; aborted?: boolean; autoApprove?: boolean; toolTimeoutMs?: number; messages?: AgentMessage[] },
): Promise<Harness> {
  const events: MossEvent[] = [];
  const approvals: string[] = [];
  const registry = new Map<string, Tool>(tools.map((t) => [t.name, t]));
  const controller = new AbortController();
  if (opts?.aborted) controller.abort();

  const toolDefs: ToolDefinition[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  const messages: AgentMessage[] = opts?.messages ?? [{ role: "user", content: "hi" }];

  await runTurn({
    provider,
    model: "test-model",
    messages,
    tools: toolDefs,
    toolRegistry: registry,
    workspaceRoot: "/work",
    signal: controller.signal,
    onEvent: (e) => events.push(e),
    requestApproval: async (id) => {
      approvals.push(id);
      return opts?.approve ?? true;
    },
    autoApprove: opts?.autoApprove ?? false,
    // Zero backoff keeps the failure tests instant; retry behavior is exercised
    // explicitly below.
    streamRetryBaseMs: 0,
    ...(opts?.toolTimeoutMs !== undefined ? { toolTimeoutMs: opts.toolTimeoutMs } : {}),
  });

  return { events, approvals };
}

const types = (h: Harness) => h.events.map((e) => e.type);

describe("runTurn", () => {
  it("streams text and completes when no tools are called", async () => {
    const provider = scriptedProvider([
      [
        { type: "text-delta", text: "Hello" },
        { type: "text-delta", text: " world" },
      ],
    ]);
    const h = await run(provider, []);

    expect(types(h)).toEqual(["text-delta", "text-delta", "turn-complete"]);
    const complete = h.events.at(-1) as Extract<MossEvent, { type: "turn-complete" }>;
    expect(complete.messages).toEqual([{ role: "assistant", content: "Hello world" }]);
  });

  it("emits token usage from the provider stream", async () => {
    const provider = scriptedProvider([[{ type: "usage", usage: { inputTokens: 3, outputTokens: 7 } }]]);
    const h = await run(provider, []);

    const usage = h.events.find((e) => e.type === "token-usage") as Extract<MossEvent, { type: "token-usage" }>;
    expect(usage.usage).toEqual({ inputTokens: 3, outputTokens: 7 });
  });

  it("auto-runs an allow-listed tool without requesting approval, then loops to completion", async () => {
    const provider = scriptedProvider([[call("c1", "read_file")], [{ type: "text-delta", text: "done" }]]);
    const h = await run(provider, [tool("read_file", { ok: true, content: "FILE BODY" })]);

    expect(types(h)).toEqual(["tool-call", "tool-result", "text-delta", "turn-complete"]);
    expect(h.approvals).toEqual([]);
    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res).toMatchObject({ callId: "c1", name: "read_file", ok: true, content: "FILE BODY" });
  });

  it("requests approval for an ask-gated tool and runs it when approved", async () => {
    const provider = scriptedProvider([[call("c1", "write_file")], [{ type: "text-delta", text: "ok" }]]);
    const h = await run(provider, [tool("write_file", { ok: true, content: "WROTE" })], { approve: true });

    expect(types(h)).toContain("tool-approval-request");
    expect(h.approvals).toEqual(["c1"]);
    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res).toMatchObject({ ok: true, content: "WROTE" });
  });

  it("returns a denial result when the user rejects an ask-gated tool", async () => {
    const provider = scriptedProvider([[call("c1", "write_file")], [{ type: "text-delta", text: "ok" }]]);
    const h = await run(provider, [tool("write_file", { ok: true, content: "WROTE" })], { approve: false });

    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res).toMatchObject({ ok: false });
    expect(res.content).toContain("User denied");
  });

  it("runs an ask-gated tool without prompting when autoApprove is on", async () => {
    const provider = scriptedProvider([[call("c1", "write_file")], [{ type: "text-delta", text: "ok" }]]);
    const h = await run(provider, [tool("write_file", { ok: true, content: "WROTE" })], { autoApprove: true });

    expect(types(h)).not.toContain("tool-approval-request");
    expect(h.approvals).toEqual([]);
    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res).toMatchObject({ callId: "c1", name: "write_file", ok: true, content: "WROTE" });
  });

  it("reports an unknown tool without throwing", async () => {
    const provider = scriptedProvider([[call("c1", "no_such_tool")], [{ type: "text-delta", text: "ok" }]]);
    const h = await run(provider, []);

    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res).toMatchObject({ ok: false });
    expect(res.content).toContain("Unknown tool");
  });

  it("reports invalid JSON arguments without calling the tool", async () => {
    const execute = vi.fn(async () => ({ ok: true, content: "" }));
    const provider = scriptedProvider([
      [call("c1", "read_file", "{ not json")],
      [{ type: "text-delta", text: "ok" }],
    ]);
    const h = await run(provider, [tool("read_file", execute)]);

    expect(execute).not.toHaveBeenCalled();
    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res.content).toContain("Invalid JSON arguments");
  });

  it("isolates a throwing tool into a failed result", async () => {
    const provider = scriptedProvider([
      [call("c1", "read_file")],
      [{ type: "text-delta", text: "ok" }],
    ]);
    const h = await run(provider, [
      tool("read_file", async () => {
        throw new Error("disk exploded");
      }),
    ]);

    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res).toMatchObject({ ok: false, content: "disk exploded" });
  });

  it("emits turn-aborted when the signal is already aborted", async () => {
    const provider = scriptedProvider([[{ type: "text-delta", text: "Hello" }]]);
    const h = await run(provider, [], { aborted: true });

    expect(types(h)).toEqual(["turn-aborted"]);
  });

  it("emits turn-error when the provider throws", async () => {
    const h = await run(throwingProvider("provider down"), []);

    const err = h.events.find((e) => e.type === "turn-error") as Extract<MossEvent, { type: "turn-error" }>;
    expect(err.message).toBe("provider down");
  });

  it("stops with an error after the maximum tool rounds", async () => {
    // Every round returns a tool call, so the loop never terminates naturally.
    const provider = scriptedProvider([[call("c1", "read_file")]]);
    const h = await run(provider, [tool("read_file", { ok: true, content: "again" })]);

    const err = h.events.find((e) => e.type === "turn-error") as Extract<MossEvent, { type: "turn-error" }>;
    expect(err.message).toContain("tool rounds");
    // 8 rounds executed the allow-listed tool 8 times.
    expect(h.events.filter((e) => e.type === "tool-result")).toHaveLength(8);
  });

  it("aborts mid-stream and drops events emitted after the signal trips", async () => {
    const controller = new AbortController();
    const provider: ChatProvider = {
      kind: "test",
      async *streamChat(): AsyncIterable<ProviderStreamEvent> {
        yield { type: "text-delta", text: "one" };
        controller.abort();
        yield { type: "text-delta", text: "two" };
      },
      async listModels() {
        return [];
      },
    };
    const events: MossEvent[] = [];
    await runTurn({
      provider,
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      toolRegistry: new Map(),
      workspaceRoot: "/work",
      signal: controller.signal,
      onEvent: (e) => events.push(e),
      requestApproval: async () => true,
    });

    expect(events.map((e) => e.type)).toEqual(["text-delta", "turn-aborted"]);
    const delta = events[0] as Extract<MossEvent, { type: "text-delta" }>;
    expect(delta.text).toBe("one");
  });

  it("executes every tool call in a multi-call round, in order", async () => {
    const provider = scriptedProvider([
      [call("c1", "read_file"), call("c2", "read_file")],
      [{ type: "text-delta", text: "done" }],
    ]);
    const h = await run(provider, [tool("read_file", { ok: true, content: "X" })]);

    const results = h.events.filter((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>[];
    expect(results.map((r) => r.callId)).toEqual(["c1", "c2"]);
  });

  it("emits turn-error when the provider throws on a later round, after a prior tool ran", async () => {
    let round = 0;
    const provider: ChatProvider = {
      kind: "test",
      async *streamChat(): AsyncIterable<ProviderStreamEvent> {
        round += 1;
        if (round === 1) {
          yield { type: "tool-call", toolCall: { id: "c1", name: "read_file", arguments: "{}" } };
          return;
        }
        throw new Error("mid-turn failure");
      },
      async listModels() {
        return [];
      },
    };
    const h = await run(provider, [tool("read_file", { ok: true, content: "X" })]);

    expect(h.events.some((e) => e.type === "tool-result")).toBe(true);
    const err = h.events.find((e) => e.type === "turn-error") as Extract<MossEvent, { type: "turn-error" }>;
    expect(err.message).toBe("mid-turn failure");
    // the completed round's assistant + tool messages ride along so the renderer
    // commits them verbatim instead of reconstructing from delta events
    expect(err.messages.map((m) => m.role)).toEqual(["assistant", "tool"]);
    expect(err.messages[0].toolCalls?.[0]?.id).toBe("c1");
  });

  it("carries partial assistant text on turn-error when the provider throws mid-stream", async () => {
    const provider: ChatProvider = {
      kind: "test",
      async *streamChat(): AsyncIterable<ProviderStreamEvent> {
        yield { type: "text-delta", text: "half a thought" };
        throw new Error("stream died");
      },
      async listModels() {
        return [];
      },
    };
    const h = await run(provider, []);

    const err = h.events.find((e) => e.type === "turn-error") as Extract<MossEvent, { type: "turn-error" }>;
    expect(err.message).toBe("stream died");
    expect(err.messages).toEqual([{ role: "assistant", content: "half a thought" }]);
  });

  it("attaches per-round token usage to the assistant message", async () => {
    const provider = scriptedProvider([
      [
        { type: "text-delta", text: "hi" },
        { type: "usage", usage: { inputTokens: 5, outputTokens: 7 } },
      ],
    ]);
    const h = await run(provider, []);

    const complete = h.events.find((e) => e.type === "turn-complete") as Extract<
      MossEvent,
      { type: "turn-complete" }
    >;
    expect(complete.messages[0].usage).toEqual({ inputTokens: 5, outputTokens: 7 });
  });

  it("marks an auto-approved ask-gated tool on the result and persists it on the tool message", async () => {
    const provider = scriptedProvider([[call("c1", "write_file")], [{ type: "text-delta", text: "ok" }]]);
    const h = await run(provider, [tool("write_file", { ok: true, content: "WROTE" })], { autoApprove: true });

    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res.autoApproved).toBe(true);
    const complete = h.events.find((e) => e.type === "turn-complete") as Extract<MossEvent, { type: "turn-complete" }>;
    const toolMsg = complete.messages.find((m) => m.role === "tool");
    expect(toolMsg?.autoApproved).toBe(true);
  });

  it("does not mark allow-listed or user-approved tools as auto-approved", async () => {
    const allow = scriptedProvider([[call("c1", "read_file")], [{ type: "text-delta", text: "ok" }]]);
    const h1 = await run(allow, [tool("read_file", { ok: true, content: "X" })]);
    const r1 = h1.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(r1.autoApproved).toBe(false);

    const ask = scriptedProvider([[call("c1", "write_file")], [{ type: "text-delta", text: "ok" }]]);
    const h2 = await run(ask, [tool("write_file", { ok: true, content: "W" })], { approve: true });
    const r2 = h2.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(r2.autoApproved).toBe(false);
  });

  it("retries a transient stream failure before any output, then succeeds", async () => {
    let attempts = 0;
    const provider: ChatProvider = {
      kind: "test",
      async *streamChat(): AsyncIterable<ProviderStreamEvent> {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        yield { type: "text-delta", text: "recovered" };
      },
      async listModels() {
        return [];
      },
    };
    const h = await run(provider, []);

    expect(attempts).toBe(2);
    expect(types(h)).toEqual(["notice", "text-delta", "turn-complete"]);
    const notice = h.events.find((e) => e.type === "notice") as Extract<MossEvent, { type: "notice" }>;
    expect(notice.level).toBe("warn");
    expect(notice.message).toContain("retrying");
    const complete = h.events.at(-1) as Extract<MossEvent, { type: "turn-complete" }>;
    expect(complete.messages).toEqual([{ role: "assistant", content: "recovered" }]);
  });

  it("gives up after the retry cap when the stream keeps failing before output", async () => {
    let attempts = 0;
    const provider: ChatProvider = {
      kind: "test",
      // eslint-disable-next-line require-yield
      async *streamChat(): AsyncIterable<ProviderStreamEvent> {
        attempts += 1;
        throw new Error("down");
      },
      async listModels() {
        return [];
      },
    };
    const h = await run(provider, []);

    expect(attempts).toBe(3); // initial attempt + 2 retries
    const err = h.events.find((e) => e.type === "turn-error") as Extract<MossEvent, { type: "turn-error" }>;
    expect(err.message).toBe("down");
  });

  it("does not retry once text has been streamed, even if the stream then throws", async () => {
    let attempts = 0;
    const provider: ChatProvider = {
      kind: "test",
      async *streamChat(): AsyncIterable<ProviderStreamEvent> {
        attempts += 1;
        yield { type: "text-delta", text: "partial" };
        throw new Error("mid");
      },
      async listModels() {
        return [];
      },
    };
    const h = await run(provider, []);

    expect(attempts).toBe(1);
    const err = h.events.find((e) => e.type === "turn-error") as Extract<MossEvent, { type: "turn-error" }>;
    expect(err.message).toBe("mid");
    expect(err.messages).toEqual([{ role: "assistant", content: "partial" }]);
  });

  it("truncates a large tool result in the model-facing history but emits the full content", async () => {
    const big = "x".repeat(20000);
    const seen: AgentMessage[][] = [];
    let round = 0;
    const provider: ChatProvider = {
      kind: "test",
      async *streamChat(req): AsyncIterable<ProviderStreamEvent> {
        seen.push(req.messages);
        round += 1;
        if (round === 1) {
          yield { type: "tool-call", toolCall: { id: "c1", name: "read_file", arguments: "{}" } };
          return;
        }
        yield { type: "text-delta", text: "done" };
      },
      async listModels() {
        return [];
      },
    };
    const h = await run(provider, [tool("read_file", { ok: true, content: big })]);

    // the renderer event keeps the full output
    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res.content).toBe(big);
    // round 2's prompt carries a truncated copy of the tool message
    const toolMsg = seen[1].find((m) => m.role === "tool");
    expect(toolMsg?.content.length).toBeLessThan(big.length);
    expect(toolMsg?.content).toContain("[truncated");
  });

  it("fails a tool that exceeds the per-tool timeout and continues the turn", async () => {
    const provider = scriptedProvider([[call("c1", "read_file")], [{ type: "text-delta", text: "after" }]]);
    const hang = tool("read_file", () => new Promise<ToolResult>(() => {}));
    const h = await run(provider, [hang], { toolTimeoutMs: 10 });

    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res.ok).toBe(false);
    expect(res.content).toContain("timed out");
    // the loop recovered and ran the next round
    expect(types(h)).toContain("text-delta");
  });

  it("caps a large tool result carried in from a prior turn's history", async () => {
    const big = "y".repeat(20000);
    const seen: AgentMessage[][] = [];
    const provider: ChatProvider = {
      kind: "test",
      async *streamChat(req): AsyncIterable<ProviderStreamEvent> {
        seen.push(req.messages);
        yield { type: "text-delta", text: "ok" };
      },
      async listModels() {
        return [];
      },
    };
    const priorTool: AgentMessage = { role: "tool", content: big, toolCallId: "old" };
    const h = await run(provider, [], { messages: [{ role: "user", content: "hi" }, priorTool] });

    expect(types(h)).toEqual(["text-delta", "turn-complete"]);
    // the model-facing seed carries a truncated copy of the prior tool result
    const toolMsg = seen[0].find((m) => m.role === "tool");
    expect(toolMsg?.content.length).toBeLessThan(big.length);
    expect(toolMsg?.content).toContain("[truncated");
  });
});

import { describe, expect, it } from "vitest";

import { HarnessTraceCollector } from "./trace-collector";

describe("HarnessTraceCollector", () => {
  it("correlates calls by id and excludes raw arguments, output, and model text", () => {
    const collector = new HarnessTraceCollector();
    collector.onEvent({
      type: "tool-call",
      callId: "call-1",
      name: "edit_file",
      arguments: JSON.stringify({ path: "result.txt", apiKey: "secret-value" }),
    });
    collector.onEvent({
      type: "tool-approval-request",
      callId: "call-1",
      name: "edit_file",
      arguments: "sensitive approval payload",
      risk: "mutating",
    });
    collector.onEvent({
      type: "tool-result",
      callId: "call-1",
      name: "edit_file",
      ok: false,
      content: "User denied: secret-value",
      autoApproved: false,
      risk: "mutating",
      durationMs: 12,
    });

    const trace = collector.snapshot();

    expect(trace.toolCalls).toEqual([expect.objectContaining({
      callId: "call-1",
      name: "edit_file",
      argumentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      approvalRequested: true,
      ok: false,
      autoApproved: false,
      risk: "mutating",
      durationMs: 12,
    })]);
    expect(JSON.stringify(trace)).not.toContain("secret-value");
    expect(JSON.stringify(trace)).not.toContain("sensitive approval payload");
  });

  it("marks recovery only for a later successful call with the same action hash", () => {
    const collector = new HarnessTraceCollector();
    const argumentsJson = JSON.stringify({ path: "result.txt" });
    collector.onEvent({ type: "tool-call", callId: "failed", name: "write_file", arguments: argumentsJson });
    collector.onEvent({
      type: "tool-result",
      callId: "failed",
      name: "write_file",
      ok: false,
      content: "temporary failure",
      autoApproved: true,
    });
    collector.onEvent({ type: "tool-call", callId: "other", name: "write_file", arguments: "{}" });
    collector.onEvent({
      type: "tool-result",
      callId: "other",
      name: "write_file",
      ok: true,
      content: "different action",
      autoApproved: true,
    });
    collector.onEvent({ type: "tool-call", callId: "recovered", name: "write_file", arguments: argumentsJson });
    collector.onEvent({
      type: "tool-result",
      callId: "recovered",
      name: "write_file",
      ok: true,
      content: "done",
      autoApproved: true,
    });

    expect(collector.snapshot().toolCalls[1].recoveredFromCallId).toBeUndefined();
    expect(collector.snapshot().toolCalls[2].recoveredFromCallId).toBe("failed");
  });

  it("totals usage and records the terminal event", () => {
    const collector = new HarnessTraceCollector();
    collector.onEvent({ type: "token-usage", usage: { inputTokens: 10, outputTokens: 2 } });
    collector.onEvent({ type: "token-usage", usage: { inputTokens: 5, outputTokens: 1 } });
    collector.onEvent({ type: "turn-complete", messages: [] });

    expect(collector.snapshot()).toMatchObject({
      usage: { inputTokens: 15, outputTokens: 3 },
      terminalState: "completed",
    });
  });
});
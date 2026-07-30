// electron/backend/moss/context/compaction.test.ts

import { describe, expect, it } from "vitest";

import type { AgentMessage } from "../../../../common/types";
import { compactForOverflow, compactIfNeeded, estimateTokens, isContextOverflowError } from "./compaction";

const sys = (content: string): AgentMessage => ({ role: "system", content });
const user = (content: string): AgentMessage => ({ role: "user", content });
const asst = (content: string): AgentMessage => ({ role: "assistant", content });
const tool = (content: string): AgentMessage => ({ role: "tool", content, toolCallId: "c1" });

/** Build a history whose estimated tokens comfortably exceed `limit`. */
function bigHistory(): AgentMessage[] {
  const chunk = "x".repeat(4000); // ~1000 tokens each
  return [
    sys("system prompt"),
    user(`u1 ${chunk}`),
    asst(`a1 ${chunk}`),
    user(`u2 ${chunk}`),
    asst(`a2 ${chunk}`),
    user("u3 latest"),
  ];
}

describe("estimateTokens", () => {
  it("grows with content length", () => {
    expect(estimateTokens([user("x".repeat(400))])).toBeGreaterThan(estimateTokens([user("x".repeat(40))]));
  });

  it("includes attached document text", () => {
    const plain = user("read this");
    const attached: AgentMessage = {
      ...plain,
      documents: [{ name: "notes.txt", mediaType: "text/plain", text: "x".repeat(4000) }],
    };
    expect(estimateTokens([attached]) - estimateTokens([plain])).toBeGreaterThan(1000);
  });
});

describe("compactForOverflow", () => {
  it("keeps the system message and newest user-led suffix", () => {
    const oldContent = "x".repeat(4000);
    const messages = [sys("rules"), user(oldContent), asst(oldContent), user("latest"), asst("latest reply")];
    const result = compactForOverflow(messages);

    expect(result.compacted).toBe(true);
    expect(result.droppedCount).toBe(2);
    expect(result.messages[0].content).toContain("rules");
    expect(result.messages[0].content).toContain("2 earlier messages were omitted");
    expect(result.messages.slice(1)).toEqual([user("latest"), asst("latest reply")]);
    expect(estimateTokens(result.messages)).toBeLessThan(estimateTokens(messages));
  });

  it("does nothing when no older user-led turn can be removed", () => {
    const messages = [sys("rules"), user("only turn"), asst("reply")];
    expect(compactForOverflow(messages)).toEqual({ messages, compacted: false, droppedCount: 0 });
  });
});

describe("isContextOverflowError", () => {
  it.each([
    "maximum context length is 8192 tokens",
    "context_length_exceeded",
    "prompt is too long",
    "input length 9000 exceeds the supported limit",
  ])("recognizes context overflow: %s", (message) => {
    expect(isContextOverflowError(new Error(message))).toBe(true);
  });

  it.each(["HTTP 401 bad key", "HTTP 400 invalid tool schema", "model not found"])(
    "rejects unrelated provider errors: %s",
    (message) => {
      expect(isContextOverflowError(new Error(message))).toBe(false);
    },
  );
});

describe("compactIfNeeded", () => {
  it("is a no-op when no context limit is set", () => {
    const msgs = bigHistory();
    const r = compactIfNeeded(msgs, { contextLimit: 0 });
    expect(r.compacted).toBe(false);
    expect(r.messages).toHaveLength(msgs.length);
  });

  it("is a no-op when the history already fits", () => {
    const msgs = [sys("s"), user("hi"), asst("hello")];
    const r = compactIfNeeded(msgs, { contextLimit: 100_000 });
    expect(r.compacted).toBe(false);
    expect(r.messages).toHaveLength(3);
  });

  it("drops the oldest messages and keeps the system message when over budget", () => {
    const r = compactIfNeeded(bigHistory(), { contextLimit: 2000 });
    expect(r.compacted).toBe(true);
    expect(r.droppedCount).toBeGreaterThan(0);
    expect(r.messages[0].role).toBe("system");
    expect(r.messages[0].content).toContain("omitted to fit the context window");
  });

  it("keeps the retained tail starting at a user message (pairing-safe)", () => {
    const r = compactIfNeeded(bigHistory(), { contextLimit: 2000 });
    expect(r.messages[1].role).toBe("user");
  });

  it("always retains the most recent user message", () => {
    const r = compactIfNeeded(bigHistory(), { contextLimit: 1200 });
    expect(r.messages[r.messages.length - 1].content).toBe("u3 latest");
  });

  it("does not compact when there is no user message to anchor a safe tail", () => {
    const msgs = [sys("s"), asst("a1"), tool("t1")];
    const r = compactIfNeeded(msgs, { contextLimit: 1 });
    expect(r.compacted).toBe(false);
  });
});

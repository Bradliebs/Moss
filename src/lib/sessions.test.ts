// src/lib/sessions.test.ts
//
// Unit tests for conversation session state. The module holds a singleton store,
// so each test re-imports a fresh module (vi.resetModules) for isolation.
// localStorage is absent in node, so the store starts empty on every import.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentMessage } from "@common/types";

type SessionsModule = typeof import("./sessions");

let sessions: SessionsModule;

beforeEach(async () => {
  vi.resetModules();
  sessions = await import("./sessions");
});

function userMsg(content: string): AgentMessage {
  return { role: "user", content };
}

describe("createSession", () => {
  it("creates an empty session and makes it current", () => {
    const id = sessions.createSession();
    expect(typeof id).toBe("string");
    expect(sessions.getSessionMessages(id)).toEqual([]);
    expect(sessions.ensureCurrentSession()).toBe(id);
  });
});

describe("getSessionMessages / setSessionMessages", () => {
  it("round-trips a session's messages and returns [] for an unknown id", () => {
    const id = sessions.createSession();
    sessions.setSessionMessages(id, [userMsg("hello")]);
    expect(sessions.getSessionMessages(id)).toEqual([userMsg("hello")]);
    expect(sessions.getSessionMessages("nope")).toEqual([]);
  });

  it("preserves image attachments on a user message across the round-trip", () => {
    const id = sessions.createSession();
    const withImages: AgentMessage = {
      role: "user",
      content: "look",
      images: ["data:image/png;base64,AAAA"],
    };
    sessions.setSessionMessages(id, [withImages]);
    expect(sessions.getSessionMessages(id)).toEqual([withImages]);
  });
});

describe("ensureCurrentSession", () => {
  it("creates a session when the store is empty and is then idempotent", () => {
    const id = sessions.ensureCurrentSession();
    expect(typeof id).toBe("string");
    expect(sessions.getSessionMessages(id)).toEqual([]);
    expect(sessions.ensureCurrentSession()).toBe(id);
  });

  it("returns the existing current session", () => {
    const id = sessions.createSession();
    expect(sessions.ensureCurrentSession()).toBe(id);
  });

  it("falls back to the front session when the current id is stale", () => {
    sessions.createSession();
    const newest = sessions.createSession();
    sessions.selectSession("ghost");
    expect(sessions.ensureCurrentSession()).toBe(newest);
  });
});

describe("selectSession", () => {
  it("switches the current session", () => {
    const first = sessions.createSession();
    sessions.createSession();
    sessions.selectSession(first);
    expect(sessions.ensureCurrentSession()).toBe(first);
  });
});

describe("deleteSession", () => {
  it("repoints the current id to a remaining session", () => {
    const first = sessions.createSession();
    const second = sessions.createSession();
    sessions.selectSession(second);
    sessions.deleteSession(second);
    expect(sessions.getSessionMessages(second)).toEqual([]);
    expect(sessions.ensureCurrentSession()).toBe(first);
  });

  it("creates a fresh session when the last one is deleted", () => {
    const id = sessions.createSession();
    sessions.deleteSession(id);
    const fresh = sessions.ensureCurrentSession();
    expect(fresh).not.toBe(id);
    expect(sessions.getSessionMessages(id)).toEqual([]);
  });

  it("leaves the current session alone when deleting a non-current one", () => {
    const first = sessions.createSession();
    const second = sessions.createSession();
    sessions.deleteSession(first);
    expect(sessions.ensureCurrentSession()).toBe(second);
    expect(sessions.getSessionMessages(first)).toEqual([]);
  });
});

describe("clearSession", () => {
  it("empties messages but keeps the session current", () => {
    const id = sessions.createSession();
    sessions.setSessionMessages(id, [userMsg("Refactor the parser")]);
    sessions.clearSession(id);
    expect(sessions.getSessionMessages(id)).toEqual([]);
    expect(sessions.ensureCurrentSession()).toBe(id);
  });
});

describe("sessionTokenUsage", () => {
  it("sums per-message usage and ignores messages without it", () => {
    const total = sessions.sessionTokenUsage([
      { role: "user", content: "hi" },
      { role: "assistant", content: "a", usage: { inputTokens: 5, outputTokens: 7 } },
      { role: "assistant", content: "b", usage: { outputTokens: 3 } },
      { role: "assistant", content: "c" },
    ]);
    expect(total).toEqual({ inputTokens: 5, outputTokens: 10 });
  });

  it("returns zeros for an empty history", () => {
    expect(sessions.sessionTokenUsage([])).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("contextWindowTokens", () => {
  it("uses the most recent reply's input + output, not a sum of all turns", () => {
    const used = sessions.contextWindowTokens([
      { role: "user", content: "hi" },
      { role: "assistant", content: "a", usage: { inputTokens: 100, outputTokens: 20 } },
      { role: "user", content: "more" },
      { role: "assistant", content: "b", usage: { inputTokens: 300, outputTokens: 40 } },
    ]);
    expect(used).toBe(340);
  });

  it("returns 0 until a reply with usage has landed", () => {
    expect(sessions.contextWindowTokens([{ role: "user", content: "hi" }])).toBe(0);
    expect(sessions.contextWindowTokens([])).toBe(0);
  });
});

describe("contextWindowUsage", () => {
  it("returns the most recent reply's input/output split", () => {
    const used = sessions.contextWindowUsage([
      { role: "assistant", content: "a", usage: { inputTokens: 100, outputTokens: 20 } },
      { role: "user", content: "more" },
      { role: "assistant", content: "b", usage: { inputTokens: 300, outputTokens: 40 } },
    ]);
    expect(used).toEqual({ inputTokens: 300, outputTokens: 40 });
  });

  it("returns zeros until a reply with usage has landed", () => {
    expect(sessions.contextWindowUsage([{ role: "user", content: "hi" }])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(sessions.contextWindowUsage([])).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

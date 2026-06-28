// @vitest-environment jsdom
//
// src/lib/sessions.title.test.tsx
//
// setSessionTitle names a placeholder conversation the moment the first message
// is sent, so the sidebar reflects the chat immediately instead of waiting for
// the turn to finish. The title is a reactive value (the sidebar reads it via
// useSessions), so these cases read it through the hook under jsdom; the
// node-env sessions.test.ts covers the non-reactive message/round-trip paths.

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type SessionsModule = typeof import("./sessions");

let sessions: SessionsModule;

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  sessions = await import("./sessions");
});

function titleOf(id: string): string | undefined {
  const { result } = renderHook(() => sessions.useSessions());
  return result.current.sessions.find((s) => s.id === id)?.title;
}

describe("setSessionTitle", () => {
  it("titles a placeholder session from the first user message on send", () => {
    const id = sessions.createSession();
    expect(titleOf(id)).toBe("New chat");
    sessions.setSessionTitle(id, "  Help me   refactor  the parser  ");
    expect(titleOf(id)).toBe("Help me refactor the parser");
  });

  it("truncates a long first message to 40 chars with an ellipsis", () => {
    const id = sessions.createSession();
    sessions.setSessionTitle(id, "x".repeat(60));
    expect(titleOf(id)).toBe(`${"x".repeat(40)}\u2026`);
  });

  it("does not overwrite a title that is already set", () => {
    const id = sessions.createSession();
    sessions.setSessionTitle(id, "first");
    sessions.setSessionTitle(id, "second");
    expect(titleOf(id)).toBe("first");
  });

  it("leaves the placeholder when the text is blank", () => {
    const id = sessions.createSession();
    sessions.setSessionTitle(id, "   ");
    expect(titleOf(id)).toBe("New chat");
  });
});

describe("clearSession", () => {
  it("resets a titled session back to the placeholder", () => {
    const id = sessions.createSession();
    sessions.setSessionTitle(id, "Refactor the parser");
    expect(titleOf(id)).toBe("Refactor the parser");
    sessions.clearSession(id);
    expect(titleOf(id)).toBe("New chat");
  });
});

describe("retroactive titling on load", () => {
  it("re-derives a placeholder title for a stored session that has messages", async () => {
    localStorage.setItem(
      "moss.sessions",
      JSON.stringify({
        sessions: [
          { id: "old", title: "New chat", messages: [{ role: "user", content: "old conversation" }], createdAt: "", updatedAt: "" },
          { id: "empty", title: "New chat", messages: [], createdAt: "", updatedAt: "" },
        ],
        currentId: "old",
      }),
    );
    vi.resetModules();
    const fresh = await import("./sessions");
    const { result } = renderHook(() => fresh.useSessions());
    expect(result.current.sessions.find((s) => s.id === "old")?.title).toBe("old conversation");
    // An empty session has no user message, so it keeps the placeholder.
    expect(result.current.sessions.find((s) => s.id === "empty")?.title).toBe("New chat");
  });
});

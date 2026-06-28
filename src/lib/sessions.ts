// src/lib/sessions.ts
//
// Conversation sessions, persisted to localStorage (renderer-only; no backend
// session store yet). Each session holds its own message history so the left
// nav can switch between conversations and they survive a reload.

import type { AgentMessage, TokenUsage } from "@common/types";

import { createPersistentStore } from "./persistentStore";

export interface Session {
  id: string;
  title: string;
  messages: AgentMessage[];
  createdAt: string;
  updatedAt: string;
  /** per-chat personality override; undefined inherits the global default */
  personalityId?: string;
}

interface SessionsState {
  sessions: Session[];
  currentId: string | null;
}

const sessionsState = createPersistentStore<SessionsState>("moss.sessions", {
  sessions: [],
  currentId: null,
});

const UNTITLED = "New chat";

function titleFromText(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > 40 ? `${clean.slice(0, 40)}…` : clean || UNTITLED;
}

function titleFrom(messages: AgentMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return UNTITLED;
  return titleFromText(firstUser.content);
}

// Sessions persisted before titles were derived on send can still show the
// placeholder despite having a user message. Re-derive their titles once on
// load so the left nav reads accurately; empty sessions keep the placeholder.
sessionsState.update((prev) => ({
  ...prev,
  sessions: prev.sessions.map((s) => (s.title === UNTITLED ? { ...s, title: titleFrom(s.messages) } : s)),
}));

export function useSessions(): SessionsState {
  return sessionsState.use();
}

export function currentSession(state: SessionsState): Session | null {
  return state.sessions.find((s) => s.id === state.currentId) ?? null;
}

/** Read a session's messages outside of render (used by the send path so the
 *  turn always commits onto the session's real history, not stale render state). */
export function getSessionMessages(id: string): AgentMessage[] {
  return sessionsState.get().sessions.find((s) => s.id === id)?.messages ?? [];
}

/** Read a session's personality override outside of render (used by the send path
 *  so the turn uses the per-chat choice). Undefined means inherit the global
 *  default from settings. */
export function getSessionPersonality(id: string): string | undefined {
  return sessionsState.get().sessions.find((s) => s.id === id)?.personalityId;
}

/** Set a session's personality override, or clear it (undefined) to inherit the
 *  global default. */
export function setSessionPersonality(id: string, personalityId: string | undefined): void {
  sessionsState.update((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) => (s.id === id ? { ...s, personalityId } : s)),
  }));
}

/** Create an empty session and make it current. Returns the new id. */
export function createSession(): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  sessionsState.update((prev) => ({
    sessions: [{ id, title: UNTITLED, messages: [], createdAt: now, updatedAt: now }, ...prev.sessions],
    currentId: id,
  }));
  return id;
}

/** Ensure a current session exists, creating one if the store is empty. Returns its id. */
export function ensureCurrentSession(): string {
  const state = sessionsState.get();
  const current = currentSession(state);
  if (current) return current.id;
  if (state.sessions.length > 0) {
    sessionsState.update((prev) => ({ ...prev, currentId: prev.sessions[0].id }));
    return state.sessions[0].id;
  }
  return createSession();
}

export function selectSession(id: string): void {
  sessionsState.update((prev) => ({ ...prev, currentId: id }));
}

export function deleteSession(id: string): void {
  sessionsState.update((prev) => {
    const sessions = prev.sessions.filter((s) => s.id !== id);
    const currentId = prev.currentId === id ? (sessions[0]?.id ?? null) : prev.currentId;
    return { sessions, currentId };
  });
}

/** Empty a conversation in place: drop its messages and reset the title to the
 *  placeholder, keeping the session selected so the user stays put. Unlike
 *  deleteSession, the conversation entry remains in the left nav. */
export function clearSession(id: string): void {
  sessionsState.update((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) =>
      s.id === id ? { ...s, messages: [], title: UNTITLED, updatedAt: new Date().toISOString() } : s,
    ),
  }));
}

/** Title a session from the first user message the moment it is sent, so the
 *  sidebar reflects the conversation immediately instead of waiting for the turn
 *  to complete. Only overwrites the placeholder, never a title already derived. */
export function setSessionTitle(id: string, firstUserText: string): void {
  const title = titleFromText(firstUserText);
  if (title === UNTITLED) return;
  sessionsState.update((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) =>
      s.id === id && s.title === UNTITLED ? { ...s, title } : s,
    ),
  }));
}

/** Derive a session's total token usage by summing the per-message usage. Usage
 *  lives on the assistant messages that incurred it, so the total is always an
 *  accurate recomputation with no separate counter to drift or reset. */
export function sessionTokenUsage(messages: AgentMessage[]): TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const m of messages) {
    inputTokens += m.usage?.inputTokens ?? 0;
    outputTokens += m.usage?.outputTokens ?? 0;
  }
  return { inputTokens, outputTokens };
}

/** The token usage occupying the model's context window: the most recent reply's
 *  usage (its input already counts the whole prior exchange, plus its own output).
 *  Returned split so callers can show the input/output breakdown. Zeros until a
 *  reply with usage has landed. */
export function contextWindowUsage(messages: AgentMessage[]): TokenUsage {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.usage) {
      return { inputTokens: m.usage.inputTokens ?? 0, outputTokens: m.usage.outputTokens ?? 0 };
    }
  }
  return { inputTokens: 0, outputTokens: 0 };
}

/** Approximate the tokens currently occupying the model's context window: the
 *  most recent reply's input (which already counts the whole prior exchange)
 *  plus its own output. Returns 0 until a reply with usage has landed. Summing
 *  every message would double-count, since each turn's input already includes
 *  the entire prior history. */
export function contextWindowTokens(messages: AgentMessage[]): number {
  const usage = contextWindowUsage(messages);
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

/** Replace a session's full message history (called on turn completion). The
 *  title is derived from the first user message once one exists. */
export function setSessionMessages(id: string, messages: AgentMessage[]): void {
  sessionsState.update((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) =>
      s.id === id
        ? {
            ...s,
            messages,
            title: s.title === UNTITLED ? titleFrom(messages) : s.title,
            updatedAt: new Date().toISOString(),
          }
        : s,
    ),
  }));
}

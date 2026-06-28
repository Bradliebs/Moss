// electron/ipc/chat-ipc.e2e.test.ts
//
// End-to-end smoke for the chat IPC turn path. A chatStart message drives the
// REAL agent runner (via the registered ipcMain handler) against a scripted
// provider, and the resulting MossEvents must stream back over
// event.sender.send wrapped as { turnId, event }.
//
// This covers the startTurn integration that the sibling unit tests do not:
//   - agent-runner.test.ts exercises the loop, but never through IPC.
//   - chat-ipc.test.ts checks channel *registration*, but never runs a turn.
// Here we verify provider wiring, event fan-out tagged with the turn id, the
// approval-broker <-> toolApprove bridge, and turn-error propagation.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { IPC } from "../../common/ipc-contract";
import type { ChatEventPayload, ChatStartRequest } from "../../common/types";
import type { ChatProvider, ProviderStreamEvent } from "../backend/moss/providers/types";

// Recording ipcMain so the test can invoke the registered channel handlers.
const recorded = vi.hoisted(() => ({
  on: new Map<string, (...args: unknown[]) => unknown>(),
  handle: new Map<string, (...args: unknown[]) => unknown>(),
}));

// The provider returned by createProvider; each test scripts it before starting.
const mockProviderRef = vi.hoisted(() => ({ current: null as ChatProvider | null }));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getAppPath: () => "/app" },
  ipcMain: {
    on: (channel: string, fn: (...args: unknown[]) => unknown) => recorded.on.set(channel, fn),
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => recorded.handle.set(channel, fn),
  },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn() },
}));

vi.mock("../backend/moss/providers", () => ({
  createProvider: () => mockProviderRef.current,
}));

vi.mock("../backend/moss/mcp/mcp-manager", () => ({
  mcpManager: { getTools: () => [], getStatus: () => [] },
}));

import { registerChatIpc } from "./chat-ipc";

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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeEvent(sent: ChatEventPayload[]): Electron.IpcMainEvent {
  return {
    sender: {
      isDestroyed: () => false,
      send: (channel: string, payload: ChatEventPayload) => {
        if (channel === IPC.chatEvent) sent.push(payload);
      },
    },
  } as unknown as Electron.IpcMainEvent;
}

function request(overrides: Partial<ChatStartRequest> = {}): ChatStartRequest {
  return {
    turnId: "t1",
    config: { model: "test-model" },
    // A supplied system message short-circuits buildSystemMessage, keeping the
    // turn hermetic (no memory/skills store reads during the turn).
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
    enableTools: false,
    ...overrides,
  } as ChatStartRequest;
}

describe("chat IPC turn (e2e)", () => {
  beforeEach(() => {
    recorded.on.clear();
    recorded.handle.clear();
    mockProviderRef.current = null;
    registerChatIpc();
  });

  it("streams a text turn back over IPC, every event tagged with the turn id", async () => {
    mockProviderRef.current = scriptedProvider([
      [
        { type: "text-delta", text: "Hello" },
        { type: "text-delta", text: " world" },
      ],
    ]);
    const sent: ChatEventPayload[] = [];
    recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request());
    await tick();

    expect(sent.map((p) => p.event.type)).toEqual(["text-delta", "text-delta", "turn-complete"]);
    expect(sent.every((p) => p.turnId === "t1")).toBe(true);
  });

  it("bridges the approval broker: a gated tool waits for toolApprove and is denied", async () => {
    mockProviderRef.current = scriptedProvider([
      [{ type: "tool-call", toolCall: { id: "c1", name: "write_file", arguments: "{}" } }],
      [{ type: "text-delta", text: "ok" }],
    ]);
    const sent: ChatEventPayload[] = [];
    recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request({ enableTools: true }));
    await tick();

    // The turn pauses on the gated write_file call until the renderer answers.
    expect(sent.find((p) => p.event.type === "tool-approval-request")).toBeDefined();
    expect(sent.find((p) => p.event.type === "tool-result")).toBeUndefined();

    recorded.on.get(IPC.toolApprove)!(null, { turnId: "t1", callId: "c1", approved: false });
    await tick();

    const result = sent.find((p) => p.event.type === "tool-result");
    expect(result).toBeDefined();
    const ev = result!.event as { ok: boolean; content: string };
    expect(ev.ok).toBe(false);
    expect(ev.content).toContain("User denied");
    // The turn still completes after the denied tool round.
    expect(sent.at(-1)!.event.type).toBe("turn-complete");
  });

  it("forwards auto-approved provenance on the tool-result event", async () => {
    mockProviderRef.current = scriptedProvider([
      [{ type: "tool-call", toolCall: { id: "c1", name: "write_file", arguments: "{}" } }],
      [{ type: "text-delta", text: "ok" }],
    ]);
    const sent: ChatEventPayload[] = [];
    recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request({ enableTools: true, autoApproveTools: true }));
    await tick();

    // Auto-approve skips the renderer prompt and the gate's provenance must
    // survive the main -> renderer forward.
    expect(sent.find((p) => p.event.type === "tool-approval-request")).toBeUndefined();
    const result = sent.find((p) => p.event.type === "tool-result");
    expect(result).toBeDefined();
    expect((result!.event as { autoApproved: boolean }).autoApproved).toBe(true);
    expect((result!.event as { risk?: string }).risk).toBe("mutating");
  });

  it("propagates a provider failure as turn-error over IPC", async () => {
    // The runner now retries a transient pre-stream failure with backoff, so
    // fake timers flush those delays deterministically instead of waiting.
    vi.useFakeTimers();
    try {
      mockProviderRef.current = throwingProvider("provider down");
      const sent: ChatEventPayload[] = [];
      recorded.on.get(IPC.chatStart)!(fakeEvent(sent), request());
      await vi.runAllTimersAsync();

      const err = sent.find((p) => p.event.type === "turn-error");
      expect(err).toBeDefined();
      expect((err!.event as { message: string }).message).toBe("provider down");
      // turn-error now carries an authoritative messages array over the wire; an
      // immediate throw leaves it empty.
      expect((err!.event as { messages: unknown[] }).messages).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

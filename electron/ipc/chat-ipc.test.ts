// electron/ipc/chat-ipc.test.ts
//
// Verifies the IPC wiring contract: every channel in the shared IPC contract is
// registered with ipcMain. This locks against the realistic regression of
// adding a channel to the contract (or the renderer) but forgetting to wire its
// main-process handler. electron is mocked with a recording ipcMain.

import { describe, expect, it, vi } from "vitest";

import { IPC } from "../../common/ipc-contract";

const recorded = vi.hoisted(() => ({
  on: new Map<string, (...args: unknown[]) => unknown>(),
  handle: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getAppPath: () => "/app" },
  ipcMain: {
    on: (channel: string, fn: (...args: unknown[]) => unknown) => recorded.on.set(channel, fn),
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => recorded.handle.set(channel, fn),
  },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

import { registerChatIpc, resolveMaxToolRounds } from "./chat-ipc";

describe("resolveMaxToolRounds", () => {
  it("uses eight rounds by default and preserves a configured long-task limit", () => {
    expect(resolveMaxToolRounds(undefined, false)).toBe(8);
    expect(resolveMaxToolRounds(32, false)).toBe(32);
  });

  it("reserves verification room and clamps unsupported values", () => {
    expect(resolveMaxToolRounds(4, true)).toBe(12);
    expect(resolveMaxToolRounds(32, true)).toBe(32);
    expect(resolveMaxToolRounds(0, false)).toBe(1);
    expect(resolveMaxToolRounds(100, false)).toBe(64);
    expect(resolveMaxToolRounds(Number.NaN, false)).toBe(8);
  });
});

describe("registerChatIpc", () => {
  it("registers the fire-and-forget channels via ipcMain.on", () => {
    recorded.on.clear();
    recorded.handle.clear();
    registerChatIpc();
    for (const channel of [IPC.chatStart, IPC.chatAbort, IPC.toolApprove]) {
      expect(recorded.on.has(channel)).toBe(true);
    }
  });

  it("registers every invoke channel via ipcMain.handle", () => {
    recorded.on.clear();
    recorded.handle.clear();
    registerChatIpc();
    const invokeChannels = [
      IPC.providerListModels,
      IPC.workspacePick,
      IPC.memoryList,
      IPC.memoryAdd,
      IPC.memoryDelete,
      IPC.memoryClear,
      IPC.skillsList,
      IPC.skillCreate,
      IPC.skillDelete,
      IPC.skillToggle,
      IPC.skillUpdate,
      IPC.skillRename,
      IPC.skillImport,
      IPC.mcpStatus,
      IPC.mcpOpenConfig,
      IPC.transcribe,
      IPC.clipboardWrite,
    ];
    for (const channel of invokeChannels) {
      expect(recorded.handle.has(channel)).toBe(true);
    }
  });

  it("registers a function for each channel", () => {
    recorded.on.clear();
    recorded.handle.clear();
    registerChatIpc();
    for (const fn of [...recorded.on.values(), ...recorded.handle.values()]) {
      expect(typeof fn).toBe("function");
    }
  });

  it("registers a handler for every inbound contract channel and none outside it", () => {
    recorded.on.clear();
    recorded.handle.clear();
    registerChatIpc();

    // chatEvent is the only outbound channel (main -> renderer via
    // event.sender.send), so it is never registered with ipcMain; every other
    // contract channel is inbound and must have exactly one handler.
    const inbound = Object.values(IPC)
      .filter((channel) => channel !== IPC.chatEvent)
      .sort();
    const registered = [...recorded.on.keys(), ...recorded.handle.keys()].sort();

    // Bijection: a new inbound contract channel left unwired, a removed channel
    // still registered, or a typo all break this equality.
    expect(registered).toEqual(inbound);

    // A channel is either fire-and-forget (on) or request/response (handle),
    // never both.
    const both = [...recorded.on.keys()].filter((channel) => recorded.handle.has(channel));
    expect(both).toEqual([]);
  });

  it("treats an abort for an unknown turn id as a no-op", () => {
    recorded.on.clear();
    recorded.handle.clear();
    registerChatIpc();
    const abort = recorded.on.get(IPC.chatAbort)!;
    expect(() => abort(null, "no-such-turn")).not.toThrow();
  });
});

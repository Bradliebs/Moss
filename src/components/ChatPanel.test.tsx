// @vitest-environment jsdom
//
// src/components/ChatPanel.test.tsx
//
// ChatPanel owns the turn lifecycle: it sends a turn over window.moss.chat.send,
// subscribes to the streamed MossEvent feed, and renders text deltas, tool cards,
// the approval gate, and terminal turn states. The lib hooks (settings/sessions/
// dictation) are mocked so only this component's event handling is under test; a
// Harness owns real busy state so the Send/Stop swap and abort path are exercised.

import { useState } from "react";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatEventPayload, MossEvent } from "@common/types";

import { ChatPanel } from "./ChatPanel";

const mockSetSessionMessages = vi.fn();
const mockClearSession = vi.fn();

// Holds the session ChatPanel renders; tests override `value.messages` to drive
// messagesToItems (e.g. multi-round turns) and beforeEach resets it to empty.
const mockSession = vi.hoisted(() => ({
  value: { id: "s1", title: "New chat", messages: [], createdAt: 0, updatedAt: 0 },
}));

// Drives the header tool-activity badge and audit popover; reset in beforeEach.
const mockToolState = vi.hoisted(() => ({
  usage: { total: 0, autoApproved: 0 },
  audit: [] as { callId: string; name: string; risk: string; autoApproved: boolean }[],
}));

const mockSettingsDefaults = {
  model: "gpt-4",
  enableTools: true,
  autoApproveTools: false,
  workspaceRoot: null as string | null,
  baseUrl: "http://localhost:11434/v1",
  apiKey: "",
  sttBaseUrl: "",
  sttModel: "whisper-1",
  emailApiKey: "",
  emailFrom: "",
  verifyEnabled: false,
  verifyCommands: "",
  presetIndex: 0,
  kind: "openai-compatible",
};
const mockSettings = vi.hoisted(() => ({
  model: "gpt-4",
  enableTools: true,
  autoApproveTools: false,
  workspaceRoot: null as string | null,
  baseUrl: "http://localhost:11434/v1",
  apiKey: "",
  sttBaseUrl: "",
  sttModel: "whisper-1",
  emailApiKey: "",
  emailFrom: "",
  verifyEnabled: false,
  verifyCommands: "",
  presetIndex: 0,
  kind: "openai-compatible",
}));

vi.mock("../lib/settings", () => ({
  useSettings: () => mockSettings,
  modelsStore: { use: () => ["gpt-4"] },
  toProviderConfig: () => ({}),
  toEmbedConfig: () => ({ baseUrl: "http://localhost:11434/v1", model: "nomic-embed-text" }),
  updateSettings: vi.fn(),
}));

vi.mock("../lib/sessions", () => ({
  useSessions: () => ({}),
  currentSession: () => mockSession.value,
  ensureCurrentSession: () => "s1",
  getSessionMessages: () => [],
  getSessionPersonality: () => undefined,
  setSessionPersonality: vi.fn(),
  setSessionMessages: (...args: unknown[]) => mockSetSessionMessages(...args),
  setSessionTitle: vi.fn(),
  clearSession: (...args: unknown[]) => mockClearSession(...args),
  sessionTokenUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
  contextWindowTokens: () => 0,
  contextWindowUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
  sessionToolUsage: () => mockToolState.usage,
  sessionToolAudit: () => mockToolState.audit,
}));

vi.mock("../lib/dictation", () => ({
  useDictation: () => ({ state: "idle", error: null, toggle: vi.fn() }),
}));

let eventHandler: ((payload: ChatEventPayload) => void) | null = null;
const off = vi.fn();

function Harness(): React.ReactElement {
  const [busy, setBusy] = useState(false);
  return <ChatPanel busy={busy} setBusy={setBusy} onOpenSettings={vi.fn()} />;
}

function startTurn(): string {
  fireEvent.change(screen.getByPlaceholderText("Message…"), { target: { value: "hi there" } });
  fireEvent.click(screen.getByText("Send"));
  return (window.moss.chat.send as ReturnType<typeof vi.fn>).mock.calls[0][0].turnId;
}

function emit(turnId: string, event: MossEvent): void {
  act(() => {
    eventHandler?.({ turnId, event });
  });
}

beforeEach(() => {
  eventHandler = null;
  mockSession.value = { id: "s1", title: "New chat", messages: [], createdAt: 0, updatedAt: 0 };
  mockToolState.usage = { total: 0, autoApproved: 0 };
  mockToolState.audit = [];
  Object.assign(mockSettings, mockSettingsDefaults);
  // jsdom does not implement Element.scrollTo; ChatPanel's autoscroll effect calls it.
  Element.prototype.scrollTo = vi.fn();
  Object.assign(window, {
    moss: {
      chat: {
        send: vi.fn(),
        abort: vi.fn(),
        onEvent: vi.fn((h: (payload: ChatEventPayload) => void) => {
          eventHandler = h;
          return off;
        }),
      },
      tool: { approve: vi.fn() },
      shell: { openExternal: vi.fn() },
      mcp: { status: vi.fn(() => Promise.resolve([])) },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as { moss?: unknown }).moss;
});

describe("ChatPanel", () => {
  it("subscribes to the event feed on mount", () => {
    render(<Harness />);
    expect(window.moss.chat.onEvent).toHaveBeenCalledTimes(1);
    expect(eventHandler).toBeTypeOf("function");
  });

  it("stamps a per-turn token subtotal on the final reply of a multi-round turn", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "do it" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }],
          usage: { inputTokens: 10, outputTokens: 2 },
        },
        { role: "tool", toolCallId: "c1", content: "ok" },
        { role: "assistant", content: "done", usage: { inputTokens: 8, outputTokens: 4 } },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const turnEl = screen.getByTitle(
      "Total token usage for this exchange across all tool rounds (input / output).",
    );
    expect(turnEl.textContent).toBe("turn 18/6 tok");
  });

  it("omits the per-turn subtotal for a single-round turn", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello", usage: { inputTokens: 3, outputTokens: 5 } },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    expect(
      screen.queryByTitle(
        "Total token usage for this exchange across all tool rounds (input / output).",
      ),
    ).toBeNull();
  });

  it("shows a revert affordance on a turn that changed files and undoes them on click", async () => {
    const list = vi.fn(() => Promise.resolve([{ path: "a.ts", existed: true }, { path: "b.ts", existed: false }]));
    const revert = vi.fn(() => Promise.resolve({ reverted: 2, errors: [] }));
    (window.moss as { checkpoint?: unknown }).checkpoint = { list, revert };
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "edit files" },
        { role: "assistant", content: "done", turnId: "turn-42" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);

    const revertBtn = await screen.findByText("Revert");
    expect(list).toHaveBeenCalledWith("turn-42");
    expect(screen.getByText("2 files changed")).toBeTruthy();

    fireEvent.click(revertBtn);
    expect(revert).toHaveBeenCalledWith("turn-42");
    await screen.findByText("Reverted 2 files");
    expect(screen.queryByText("Revert")).toBeNull();
  });

  it("shows no revert affordance when a turn changed no files", async () => {
    const list = vi.fn(() => Promise.resolve([]));
    (window.moss as { checkpoint?: unknown }).checkpoint = { list, revert: vi.fn() };
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "just chat" },
        { role: "assistant", content: "hello", turnId: "turn-7" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);

    await waitFor(() => expect(list).toHaveBeenCalledWith("turn-7"));
    expect(screen.queryByText("Revert")).toBeNull();
  });

  it("formats large per-turn token counts with thousands separators", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "do it" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }],
          usage: { inputTokens: 10000, outputTokens: 2000 },
        },
        { role: "tool", toolCallId: "c1", content: "ok" },
        { role: "assistant", content: "done", usage: { inputTokens: 8000, outputTokens: 4000 } },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const turnEl = screen.getByTitle(
      "Total token usage for this exchange across all tool rounds (input / output).",
    );
    expect(turnEl.textContent).toBe("turn 18,000/6,000 tok");
  });

  it("renders a fenced code block in an assistant reply as preformatted code", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "show me" },
        { role: "assistant", content: "Here you go:\n```ts\nconst x = 1;\n```" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const code = screen.getByText("const x = 1;");
    expect(code.tagName).toBe("CODE");
    expect(code.closest("pre")).not.toBeNull();
  });

  it("copies an assistant reply to the clipboard when Copy is clicked", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "the answer" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByText("Copy"));
    expect(writeText).toHaveBeenCalledWith("the answer");
  });

  it("copies just the code block from its own copy button", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "show" },
        { role: "assistant", content: "```\ncode body\n```" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByTitle("Copy this code block to the clipboard."));
    expect(writeText).toHaveBeenCalledWith("code body");
  });

  it("shows 'Copied' feedback after clicking the reply Copy button", () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "the answer" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByText("Copy"));
    expect(screen.getByText("Copied")).toBeTruthy();
  });

  it("renders bold inline markdown as a strong element", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "this is **important** now" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const strong = screen.getByText("important");
    expect(strong.tagName).toBe("STRONG");
  });

  it("renders a bulleted list as list items", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "list" },
        { role: "assistant", content: "- alpha\n- beta" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const item = screen.getByText("alpha");
    expect(item.closest("li")).not.toBeNull();
    expect(item.closest("ul")).not.toBeNull();
  });

  it("renders a markdown heading as a styled element, not literal hashes", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "head" },
        { role: "assistant", content: "## Section title" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    expect(screen.getByText("Section title")).toBeDefined();
    expect(screen.queryByText("## Section title")).toBeNull();
  });

  it("renders a markdown pipe table as a table cell, not literal pipes", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "grid" },
        { role: "assistant", content: "| A | B |\n| --- | --- |\n| one | two |" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const cell = screen.getByText("one");
    expect(cell.closest("td")).not.toBeNull();
    expect(cell.closest("table")).not.toBeNull();
  });

  it("renders a markdown task list as disabled checkboxes with labels", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "todo" },
        { role: "assistant", content: "- [ ] open\n- [x] closed" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const boxes = document.querySelectorAll('input[type="checkbox"]');
    expect(boxes.length).toBe(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(false);
    expect((boxes[1] as HTMLInputElement).checked).toBe(true);
    expect((boxes[0] as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("closed")).toBeDefined();
  });

  it("renders strikethrough markdown with a line-through span", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: "this is ~~gone~~ now" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    expect(screen.getByText("gone").className).toContain("line-through");
  });

  it("copies a rendered table back to its markdown source", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "grid" },
        { role: "assistant", content: "| A | B |\n| --- | --- |\n| one | two |" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByTitle("Copy this table as markdown to the clipboard."));
    expect(writeText).toHaveBeenCalledWith("| A | B |\n| --- | --- |\n| one | two |");
  });

  it("copies a rendered task list back to its markdown source", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "todo" },
        { role: "assistant", content: "- [ ] open\n- [x] closed" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByTitle("Copy this task list as markdown to the clipboard."));
    expect(writeText).toHaveBeenCalledWith("- [ ] open\n- [x] closed");
  });

  it("renders a link as non-navigating text with the URL in the title", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "link" },
        { role: "assistant", content: "see [docs](https://example.com)" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const link = screen.getByText("docs");
    expect(link.tagName).toBe("SPAN");
    expect(link.getAttribute("title")).toBe("https://example.com");
  });

  it("opens a link's URL via the shell bridge when clicked, not by navigating", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "link" },
        { role: "assistant", content: "see [docs](https://example.com)" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByText("docs"));
    expect(window.moss.shell.openExternal).toHaveBeenCalledWith("https://example.com");
  });

  it("shows a drop overlay while a file is dragged over the composer", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const footer = document.querySelector("footer");
    expect(footer).not.toBeNull();
    expect(screen.queryByText("Drop files to attach")).toBeNull();
    fireEvent.dragEnter(footer as Element);
    expect(screen.getByText("Drop files to attach")).toBeDefined();
    fireEvent.dragLeave(footer as Element);
    expect(screen.queryByText("Drop files to attach")).toBeNull();
  });

  it("keeps the drop overlay up while the drag crosses nested children", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const footer = document.querySelector("footer") as Element;
    // Enter footer, then enter a child (depth 2), leave the child (depth 1):
    // the overlay must stay because the drag has not actually left the footer.
    fireEvent.dragEnter(footer);
    fireEvent.dragEnter(footer);
    fireEvent.dragLeave(footer);
    expect(screen.getByText("Drop files to attach")).toBeDefined();
    fireEvent.dragLeave(footer);
    expect(screen.queryByText("Drop files to attach")).toBeNull();
  });

  it("renders image attachments on a user message as thumbnails", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [{ role: "user", content: "look", images: ["data:image/png;base64,AAAA"] }],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    const img = screen.getByAltText("attachment");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it("clears the current conversation when Clear is clicked", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByText("Clear"));
    expect(mockClearSession).toHaveBeenCalledWith("s1");
  });

  it("hides the Clear action for an empty conversation", () => {
    render(<Harness />);
    expect(screen.queryByText("Clear")).toBeNull();
  });

  it("shows the auto-approve indicator only when the setting is on", () => {
    const { unmount } = render(<Harness />);
    expect(screen.queryByText("Auto-approving tools")).toBeNull();
    unmount();

    mockSettings.autoApproveTools = true;
    render(<Harness />);
    expect(screen.getByText("Auto-approving tools")).toBeDefined();
  });

  it("surfaces the connected MCP tool count in the header", async () => {
    window.moss.mcp.status = vi.fn(() =>
      Promise.resolve([
        { id: "a", enabled: true, connected: true, toolCount: 2 },
        { id: "b", enabled: true, connected: false, toolCount: 0, error: "down" },
        { id: "c", enabled: true, connected: true, toolCount: 3 },
      ]),
    );
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("5 MCP tools")).toBeDefined());
    expect(screen.getByText("1 MCP server down")).toBeDefined();
  });

  it("sends a turn and shows the pending user message", () => {
    render(<Harness />);
    const turnId = startTurn();
    const req = (window.moss.chat.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.messages.at(-1)).toEqual({ role: "user", content: "hi there" });
    expect(req.enableTools).toBe(true);
    expect(typeof turnId).toBe("string");
    expect(screen.getByText("hi there")).toBeDefined();
    // busy is now true, so the Send button has swapped to Stop
    expect(screen.getByText("Stop")).toBeDefined();
  });

  it("renders streamed text deltas for the active turn", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, { type: "text-delta", text: "Hel" });
    emit(turnId, { type: "text-delta", text: "lo" });
    expect(screen.getByText("Hello")).toBeDefined();
  });

  it("renders streamed deltas as markdown, not literal text", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, { type: "text-delta", text: "| A | B |\n| --- | --- |\n" });
    emit(turnId, { type: "text-delta", text: "| one | two |" });
    const cell = screen.getByText("one");
    expect(cell.closest("td")).not.toBeNull();
    expect(cell.closest("table")).not.toBeNull();
  });

  it("ignores events from a stale turn", () => {
    render(<Harness />);
    startTurn();
    emit("not-the-current-turn", { type: "text-delta", text: "ghost" });
    expect(screen.queryByText("ghost")).toBeNull();
  });

  it("runs the tool card through the approval gate to a result", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, { type: "tool-call", callId: "c1", name: "read_file", arguments: "{}" });
    emit(turnId, { type: "tool-approval-request", callId: "c1", name: "read_file", arguments: "{}" });

    expect(screen.getByText("Approve")).toBeDefined();
    fireEvent.click(screen.getByText("Approve"));
    expect(window.moss.tool.approve).toHaveBeenCalledWith({ turnId, callId: "c1", approved: true });

    emit(turnId, { type: "tool-result", callId: "c1", name: "read_file", ok: true, content: "file body" });
    expect(screen.getByText("file body")).toBeDefined();
  });

  it("flags a destructive command on the approval prompt", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, { type: "tool-call", callId: "c2", name: "run_command", arguments: "{}" });
    emit(turnId, {
      type: "tool-approval-request",
      callId: "c2",
      name: "run_command",
      arguments: "{}",
      risk: "destructive",
    });

    expect(screen.getByText("Approval required.")).toBeDefined();
    expect(screen.getByText("destructive")).toBeDefined();
  });

  it("opens a tool-activity audit listing each call's name, risk tier, and auto flag", () => {
    mockToolState.usage = { total: 2, autoApproved: 1 };
    mockToolState.audit = [
      { callId: "c1", name: "read_file", risk: "readonly", autoApproved: true },
      { callId: "c2", name: "write_file", risk: "mutating", autoApproved: false },
    ];
    render(<Harness />);

    fireEvent.click(screen.getByText("2 tools (1 auto)"));

    expect(screen.getByText("Tool activity")).toBeDefined();
    expect(screen.getByText("read_file")).toBeDefined();
    expect(screen.getByText("readonly")).toBeDefined();
    expect(screen.getByText("write_file")).toBeDefined();
    expect(screen.getByText("mutating")).toBeDefined();
    expect(screen.getByText("auto")).toBeDefined();
  });

  it("filters readonly rows and sorts by risk in the audit popover", () => {
    mockToolState.usage = { total: 3, autoApproved: 0 };
    mockToolState.audit = [
      { callId: "c1", name: "read_file", risk: "readonly", autoApproved: false },
      { callId: "c2", name: "write_file", risk: "mutating", autoApproved: false },
      { callId: "c3", name: "run_command", risk: "destructive", autoApproved: false },
    ];
    render(<Harness />);

    fireEvent.click(screen.getByText(/3 tools/));
    expect(screen.getByText("read_file")).toBeDefined();

    // Hiding readonly rows drops the read_file call.
    fireEvent.click(screen.getByText("Hide readonly"));
    expect(screen.queryByText("read_file")).toBeNull();
    expect(screen.getByText("write_file")).toBeDefined();
    expect(screen.getByText("run_command")).toBeDefined();

    // Sorting by risk orders the remaining calls destructive-first.
    fireEvent.click(screen.getByText("By risk"));
    const order = screen.getAllByText(/^(write_file|run_command)$/).map((n) => n.textContent);
    expect(order).toEqual(["run_command", "write_file"]);
  });

  it("commits messages and clears busy on turn-complete", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, { type: "turn-complete", messages: [{ role: "assistant", content: "done" }] });

    expect(mockSetSessionMessages).toHaveBeenCalledTimes(1);
    expect(mockSetSessionMessages.mock.calls[0][0]).toBe("s1");
    // The committed history must keep the user message, not just the reply.
    expect(mockSetSessionMessages.mock.calls[0][1]).toEqual([
      { role: "user", content: "hi there" },
      { role: "assistant", content: "done" },
    ]);
    // busy cleared -> Send button is back
    expect(screen.getByText("Send")).toBeDefined();
  });

  it("persists the user message, shows an error, and clears busy on turn-error", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, { type: "turn-error", message: "boom", messages: [] });
    expect(mockSetSessionMessages).toHaveBeenCalledWith("s1", [{ role: "user", content: "hi there" }]);
    expect(screen.getByText("Error: boom")).toBeDefined();
    expect(screen.getByText("Send")).toBeDefined();
  });

  it("persists the partial reply and flags it interrupted on turn-error", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, {
      type: "turn-error",
      message: "boom",
      messages: [{ role: "assistant", content: "partial reply" }],
    });
    expect(mockSetSessionMessages).toHaveBeenCalledWith("s1", [
      { role: "user", content: "hi there" },
      { role: "assistant", content: "partial reply", interrupted: true },
    ]);
  });

  it("commits the user message and aborted output on turn-aborted", () => {
    render(<Harness />);
    const turnId = startTurn();
    emit(turnId, { type: "turn-aborted", messages: [{ role: "assistant", content: "partial" }] });
    expect(mockSetSessionMessages).toHaveBeenCalledWith("s1", [
      { role: "user", content: "hi there" },
      { role: "assistant", content: "partial" },
    ]);
    expect(screen.getByText("Aborted")).toBeDefined();
  });

  it("aborts the active turn from the Stop button", () => {
    render(<Harness />);
    const turnId = startTurn();
    fireEvent.click(screen.getByText("Stop"));
    expect(window.moss.chat.abort).toHaveBeenCalledWith(turnId);
  });

  it("unsubscribes from the event feed on unmount", () => {
    const { unmount } = render(<Harness />);
    unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("hides the per-bubble Regenerate and Edit actions for an empty conversation", () => {
    render(<Harness />);
    expect(screen.queryByText("Regenerate")).toBeNull();
    expect(screen.queryByText("Edit")).toBeNull();
  });

  it("regenerates by re-running the last user turn without its assistant reply", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByText("Regenerate"));
    const req = (window.moss.chat.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // The dropped assistant reply must not be replayed; only the user prompt goes back.
    expect(req.messages).toEqual([{ role: "user", content: "first" }]);
  });

  it("pulls the last user turn back into the composer and truncates history on edit", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "typo here" },
        { role: "assistant", content: "reply" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getByText("Edit"));
    const box = screen.getByPlaceholderText("Message…") as HTMLTextAreaElement;
    expect(box.value).toBe("typo here");
    // History is truncated before the edited turn so resending does not duplicate it.
    expect(mockSetSessionMessages).toHaveBeenCalledWith("s1", []);
  });

  it("regenerates an earlier turn from its own bubble, dropping all later messages", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "second" },
        { role: "assistant", content: "a2" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    // Two user bubbles -> two Regenerate buttons; the first re-runs from index 0.
    fireEvent.click(screen.getAllByText("Regenerate")[0]);
    const req = (window.moss.chat.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.messages).toEqual([{ role: "user", content: "first" }]);
  });

  it("edits an earlier turn from its own bubble, truncating everything after it", () => {
    mockSession.value = {
      id: "s1",
      title: "New chat",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "second" },
        { role: "assistant", content: "a2" },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    render(<Harness />);
    fireEvent.click(screen.getAllByText("Edit")[0]);
    const box = screen.getByPlaceholderText("Message…") as HTMLTextAreaElement;
    expect(box.value).toBe("first");
    expect(mockSetSessionMessages).toHaveBeenCalledWith("s1", []);
  });
});

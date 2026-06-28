// @vitest-environment jsdom
//
// src/components/Sidebar.test.tsx
//
// The sessions store logic is covered by sessions.test.ts; here the store is
// mocked so the component is tested in isolation: it renders the conversation
// list and routes button clicks to the right store action, and locks
// interaction while a turn is busy.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as sessions from "../lib/sessions";
import { Sidebar } from "./Sidebar";

vi.mock("../lib/sessions", () => ({
  useSessions: vi.fn(),
  createSession: vi.fn(),
  selectSession: vi.fn(),
  deleteSession: vi.fn(),
}));

const noop = (): void => {};

beforeEach(() => {
  vi.mocked(sessions.useSessions).mockReturnValue({ sessions: [], currentId: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Sidebar", () => {
  it("shows an empty-state message when there are no conversations", () => {
    render(<Sidebar busy={false} onOpenSettings={noop} onOpenLibrary={noop} />);
    expect(screen.getByText("No conversations yet.")).toBeDefined();
  });

  it("renders each conversation title", () => {
    vi.mocked(sessions.useSessions).mockReturnValue({
      sessions: [
        { id: "a", title: "First chat", messages: [], createdAt: 0, updatedAt: 0 },
        { id: "b", title: "Second chat", messages: [], createdAt: 0, updatedAt: 0 },
      ],
      currentId: "a",
    });
    render(<Sidebar busy={false} onOpenSettings={noop} onOpenLibrary={noop} />);
    expect(screen.getByText("First chat")).toBeDefined();
    expect(screen.getByText("Second chat")).toBeDefined();
  });

  it("creates a new conversation on the New chat button", () => {
    render(<Sidebar busy={false} onOpenSettings={noop} onOpenLibrary={noop} />);
    fireEvent.click(screen.getByText("+ New chat"));
    expect(sessions.createSession).toHaveBeenCalledTimes(1);
  });

  it("selects a conversation when its title is clicked", () => {
    vi.mocked(sessions.useSessions).mockReturnValue({
      sessions: [{ id: "a", title: "First chat", messages: [], createdAt: 0, updatedAt: 0 }],
      currentId: "a",
    });
    render(<Sidebar busy={false} onOpenSettings={noop} onOpenLibrary={noop} />);
    fireEvent.click(screen.getByText("First chat"));
    expect(sessions.selectSession).toHaveBeenCalledWith("a");
  });

  it("deletes a conversation when its delete button is clicked", () => {
    vi.mocked(sessions.useSessions).mockReturnValue({
      sessions: [{ id: "a", title: "First chat", messages: [], createdAt: 0, updatedAt: 0 }],
      currentId: "a",
    });
    render(<Sidebar busy={false} onOpenSettings={noop} onOpenLibrary={noop} />);
    fireEvent.click(screen.getByTitle("Delete conversation"));
    expect(sessions.deleteSession).toHaveBeenCalledWith("a");
  });

  it("opens the settings and library overlays", () => {
    const onOpenSettings = vi.fn();
    const onOpenLibrary = vi.fn();
    render(<Sidebar busy={false} onOpenSettings={onOpenSettings} onOpenLibrary={onOpenLibrary} />);
    fireEvent.click(screen.getByText("Settings"));
    fireEvent.click(screen.getByText("Library"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenLibrary).toHaveBeenCalledTimes(1);
  });

  it("disables conversation actions while a turn is busy", () => {
    vi.mocked(sessions.useSessions).mockReturnValue({
      sessions: [{ id: "a", title: "First chat", messages: [], createdAt: 0, updatedAt: 0 }],
      currentId: "a",
    });
    render(<Sidebar busy={true} onOpenSettings={noop} onOpenLibrary={noop} />);
    expect((screen.getByText("+ New chat") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("First chat") as HTMLButtonElement).disabled).toBe(true);
  });
});

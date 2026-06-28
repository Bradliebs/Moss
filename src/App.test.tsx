// @vitest-environment jsdom
//
// src/App.test.tsx
//
// App is the root coordinator: a single `overlay` state machine (none/settings/
// library) plus the `busy` flag threaded to the sidebar and owned via ChatPanel's
// setBusy. The child panels are mocked so only that wiring is under test.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "./App";

vi.mock("./components/Sidebar", () => ({
  Sidebar: ({
    busy,
    onOpenSettings,
    onOpenLibrary,
  }: {
    busy: boolean;
    onOpenSettings: () => void;
    onOpenLibrary: () => void;
  }) => (
    <div>
      <span>sidebar-busy:{String(busy)}</span>
      <button onClick={onOpenSettings}>sb-open-settings</button>
      <button onClick={onOpenLibrary}>sb-open-library</button>
    </div>
  ),
}));

vi.mock("./components/ChatPanel", () => ({
  ChatPanel: ({ busy, setBusy }: { busy: boolean; setBusy: (b: boolean) => void }) => (
    <div>
      <span>chat-busy:{String(busy)}</span>
      <button onClick={() => setBusy(true)}>cp-set-busy</button>
    </div>
  ),
}));

vi.mock("./components/SettingsPanel", () => ({
  SettingsPanel: ({ onClose }: { onClose: () => void }) => (
    <div>
      <span>settings-overlay</span>
      <button onClick={onClose}>sp-close</button>
    </div>
  ),
}));

vi.mock("./components/LibraryPanel", () => ({
  LibraryPanel: ({ onClose }: { onClose: () => void }) => (
    <div>
      <span>library-overlay</span>
      <button onClick={onClose}>lp-close</button>
    </div>
  ),
}));

afterEach(cleanup);

describe("App", () => {
  it("renders no overlay initially", () => {
    render(<App />);
    expect(screen.queryByText("settings-overlay")).toBeNull();
    expect(screen.queryByText("library-overlay")).toBeNull();
  });

  it("opens and closes the settings overlay", () => {
    render(<App />);
    fireEvent.click(screen.getByText("sb-open-settings"));
    expect(screen.getByText("settings-overlay")).toBeDefined();
    fireEvent.click(screen.getByText("sp-close"));
    expect(screen.queryByText("settings-overlay")).toBeNull();
  });

  it("opens the library overlay", () => {
    render(<App />);
    fireEvent.click(screen.getByText("sb-open-library"));
    expect(screen.getByText("library-overlay")).toBeDefined();
  });

  it("shows only one overlay at a time", () => {
    render(<App />);
    fireEvent.click(screen.getByText("sb-open-settings"));
    fireEvent.click(screen.getByText("sb-open-library"));
    expect(screen.queryByText("settings-overlay")).toBeNull();
    expect(screen.getByText("library-overlay")).toBeDefined();
  });

  it("threads the busy flag from ChatPanel to the sidebar", () => {
    render(<App />);
    expect(screen.getByText("sidebar-busy:false")).toBeDefined();
    fireEvent.click(screen.getByText("cp-set-busy"));
    expect(screen.getByText("sidebar-busy:true")).toBeDefined();
  });
});

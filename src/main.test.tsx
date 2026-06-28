// @vitest-environment jsdom
//
// src/main.test.tsx
//
// main.tsx is the renderer entry point: it locates #root and mounts <App/> via
// React's createRoot. react-dom/client and App are mocked so only the mount
// wiring (and the missing-root guard) is under test, not the app tree.

import { afterEach, describe, expect, it, vi } from "vitest";

const mockRender = vi.fn();
const mockCreateRoot = vi.fn(() => ({ render: mockRender }));

vi.mock("react-dom/client", () => ({
  createRoot: mockCreateRoot,
}));
vi.mock("./App", () => ({ default: () => null }));
vi.mock("./index.css", () => ({}));

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  document.body.innerHTML = "";
});

describe("main bootstrap", () => {
  it("mounts the app into #root", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);

    await import("./main");

    expect(mockCreateRoot).toHaveBeenCalledWith(root);
    expect(mockRender).toHaveBeenCalledTimes(1);
  });

  it("throws when #root is missing", async () => {
    await expect(import("./main")).rejects.toThrow("Root element #root not found");
  });
});

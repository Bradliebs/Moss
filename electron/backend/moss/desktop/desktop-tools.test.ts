import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Tool, ToolContext } from "../tools/types";
import { createDesktopTools, DesktopSessionManager, type DesktopDriver } from "./desktop-tools";

function context(workspaceRoot = resolve("desktop-test-workspace")): ToolContext {
  return { workspaceRoot, signal: new AbortController().signal };
}

function fakeDriver(): DesktopDriver {
  return {
    inspect: vi.fn(async () => "Button Name=Save AutomationId=save\n".repeat(1_000)),
    invoke: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    select: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => undefined),
    controlState: vi.fn(async () => ({ exists: true, enabled: true, value: "Ready", selected: false })),
    close: vi.fn(async () => undefined),
  };
}

function find(tools: Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function makeTools(driver: DesktopDriver, platform: NodeJS.Platform = "win32"): Tool[] {
  return createDesktopTools({
    driverFactory: async () => driver,
    allowedProcesses: ["notepad.exe"],
    allowedWindows: ["Notes"],
    platform,
  });
}

async function openedTools(driver: DesktopDriver): Promise<Tool[]> {
  const tools = makeTools(driver);
  await find(tools, "desktop_open_session").execute({ taskId: "task-1", sessionId: "session-1", processName: "notepad.exe", windowTitle: "Notes" }, context());
  return tools;
}

describe("desktop tools", () => {
  it("reports unsupported platforms without creating a driver", async () => {
    const factory = vi.fn(async () => fakeDriver());
    const tools = createDesktopTools({ driverFactory: factory, allowedProcesses: ["notepad"], allowedWindows: ["Notes"], platform: "linux" });
    const result = await find(tools, "desktop_open_session").execute({ taskId: "t", sessionId: "s", processName: "notepad", windowTitle: "Notes" }, context());
    expect(result).toEqual({ ok: false, content: expect.stringContaining("unsupported") });
    expect(factory).not.toHaveBeenCalled();
  });

  it("enforces process/window allowlists and active sessions", async () => {
    const driver = fakeDriver();
    const tools = makeTools(driver);
    const inspect = find(tools, "desktop_inspect");
    expect((await inspect.execute({ taskId: "t", sessionId: "s" }, context())).ok).toBe(false);

    const open = find(tools, "desktop_open_session");
    expect((await open.execute({ taskId: "t", sessionId: "s", processName: "calc.exe", windowTitle: "Notes" }, context())).ok).toBe(false);
    expect((await open.execute({ taskId: "t", sessionId: "s", processName: "notepad", windowTitle: "Other" }, context())).ok).toBe(false);
    expect((await open.execute({ taskId: "t", sessionId: "s", processName: "NOTEPAD.EXE", windowTitle: "notes" }, context())).ok).toBe(true);
  });

  it("uses semantic selectors, rejects coordinate-only actions, and gates irreversible invokes", async () => {
    const driver = fakeDriver();
    const tools = await openedTools(driver);
    const invoke = find(tools, "desktop_invoke");
    expect((await invoke.execute({ taskId: "task-1", sessionId: "session-1", x: 10, y: 20 }, context())).ok).toBe(false);
    expect(driver.invoke).not.toHaveBeenCalled();

    expect((await invoke.execute({ taskId: "task-1", sessionId: "session-1", automationId: "save", name: "Save" }, context())).ok).toBe(true);
    expect(driver.invoke).toHaveBeenCalledWith({ automationId: "save", name: "Save", controlType: undefined });

    expect((await invoke.execute({ taskId: "task-1", sessionId: "session-1", name: "Confirm purchase", controlType: "Button" }, context())).ok).toBe(false);
    expect(driver.invoke).toHaveBeenCalledTimes(1);
    expect((await invoke.execute({ taskId: "task-1", sessionId: "session-1", name: "Confirm purchase", controlType: "Button", irreversibleApproval: true }, context())).ok).toBe(false);
    expect((await invoke.execute({ taskId: "task-1", sessionId: "session-1", name: "Confirm purchase", controlType: "Button" }, { ...context(), approvalGranted: true })).ok).toBe(true);
  });

  it("guards screenshot paths, bounds output, and asserts control state", async () => {
    const driver = fakeDriver();
    const tools = await openedTools(driver);
    const screenshot = find(tools, "desktop_screenshot");
    expect((await screenshot.execute({ taskId: "task-1", sessionId: "session-1", path: "../escape.png" }, context())).ok).toBe(false);
    expect(driver.screenshot).not.toHaveBeenCalled();
    expect((await screenshot.execute({ taskId: "task-1", sessionId: "session-1", path: "evidence/window.png" }, context())).ok).toBe(true);

    const inspected = await find(tools, "desktop_inspect").execute({ taskId: "task-1", sessionId: "session-1" }, context());
    expect(inspected.content.length).toBeLessThanOrEqual(20_020);
    expect(inspected.content).toContain("truncated");
    expect((await find(tools, "desktop_assert_control").execute({ taskId: "task-1", sessionId: "session-1", automationId: "status", property: "value", expected: "Ready" }, context())).ok).toBe(true);
  });

  it("cleans up every managed session", async () => {
    const first = fakeDriver();
    const second = fakeDriver();
    const manager = new DesktopSessionManager({
      driverFactory: async ({ sessionId }) => sessionId === "one" ? first : second,
      allowedProcesses: ["notepad"],
      allowedWindows: ["Notes"],
      platform: "win32",
    });
    await manager.open({ taskId: "task", sessionId: "one", processName: "notepad", windowTitle: "Notes" });
    await manager.open({ taskId: "task", sessionId: "two", processName: "notepad", windowTitle: "Notes" });
    await manager.closeAll();
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(() => manager.get("task", "one")).toThrow("No active desktop session");
  });
});
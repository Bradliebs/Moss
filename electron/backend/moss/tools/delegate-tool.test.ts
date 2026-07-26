// Tests for the delegate tool's own surface. The runner-side guarantees (a
// read-only tool set, refused approval, and the recursion cap) are covered in
// agent-runner.delegate.test.ts.

import { describe, expect, it, vi } from "vitest";

import { delegateTool } from "./delegate-tool";
import type { ToolContext } from "./types";

function ctx(delegate?: ToolContext["delegate"]): ToolContext {
  return { workspaceRoot: "/ws", signal: new AbortController().signal, ...(delegate ? { delegate } : {}) };
}

describe("delegate tool", () => {
  it("returns the subagent's report", async () => {
    const spy = vi.fn(async () => "  found it in src/main.ts  ");
    const res = await delegateTool.execute({ task: "where is the entry point?" }, ctx(spy));
    expect(res.ok).toBe(true);
    expect(res.content).toBe("found it in src/main.ts");
    expect(spy).toHaveBeenCalledWith("where is the entry point?", expect.anything());
  });

  it("reports that delegation is unavailable when it is not wired", async () => {
    const res = await delegateTool.execute({ task: "explore" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("not available");
  });

  it("requires a task", async () => {
    expect((await delegateTool.execute({ task: "   " }, ctx(async () => "x"))).ok).toBe(false);
    expect((await delegateTool.execute({}, ctx(async () => "x"))).ok).toBe(false);
  });

  it("rejects an oversized task", async () => {
    const spy = vi.fn(async () => "x");
    const res = await delegateTool.execute({ task: "a".repeat(4_001) }, ctx(spy));
    expect(res.ok).toBe(false);
    expect(res.content).toContain("too long");
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails when the subagent reports nothing", async () => {
    const res = await delegateTool.execute({ task: "explore" }, ctx(async () => "   "));
    expect(res.ok).toBe(false);
    expect(res.content).toContain("without reporting");
  });

  it("surfaces a subagent failure as a failed result, not a throw", async () => {
    const res = await delegateTool.execute(
      { task: "explore" },
      ctx(async () => {
        throw new Error("provider exploded");
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.content).toContain("provider exploded");
  });
});

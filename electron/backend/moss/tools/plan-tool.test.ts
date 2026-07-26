// Tests for the plan checklist: the store's own behavior, and the tool surface
// that the model drives it through.

import { describe, expect, it } from "vitest";

import { PlanStore } from "../task/plan-store";
import { planTool } from "./plan-tool";
import type { ToolContext } from "./types";

function ctx(plan?: PlanStore): ToolContext {
  return { workspaceRoot: "/ws", signal: new AbortController().signal, ...(plan ? { plan } : {}) };
}

describe("PlanStore", () => {
  it("numbers steps from 1 and starts them pending", () => {
    const store = new PlanStore();
    const steps = store.set(["first", "second"]);
    expect(steps.map((s) => s.id)).toEqual([1, 2]);
    expect(steps.every((s) => s.status === "pending")).toBe(true);
  });

  it("drops blank steps and collapses whitespace", () => {
    const store = new PlanStore();
    const steps = store.set(["  a   b  ", "   ", "c"]);
    expect(steps.map((s) => s.text)).toEqual(["a b", "c"]);
  });

  it("caps the step count", () => {
    const store = new PlanStore();
    expect(store.set(Array.from({ length: 50 }, (_, i) => `step ${i}`))).toHaveLength(20);
  });

  it("updates a step and reports unknown ids", () => {
    const store = new PlanStore();
    store.set(["a"]);
    expect(store.update(1, "done")).toBe(true);
    expect(store.update(99, "done")).toBe(false);
    expect(store.list()[0].status).toBe("done");
  });

  it("clears a note when updated without one", () => {
    const store = new PlanStore();
    store.set(["a"]);
    store.update(1, "blocked", "waiting on input");
    expect(store.list()[0].note).toBe("waiting on input");
    store.update(1, "active");
    expect(store.list()[0].note).toBeUndefined();
  });

  it("renders marks and a done count", () => {
    const store = new PlanStore();
    store.set(["a", "b"]);
    store.update(1, "done");
    store.update(2, "blocked", "no creds");
    expect(store.render()).toBe("1. [x] a\n2. [!] b -- no creds\n(1/2 done)");
  });

  it("does not leak internal state through list()", () => {
    const store = new PlanStore();
    store.set(["a"]);
    store.list()[0].status = "done";
    expect(store.list()[0].status).toBe("pending");
  });
});

describe("plan tool", () => {
  it("fails cleanly when no store is available", async () => {
    const res = await planTool.execute({ action: "show" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("not available");
  });

  it("sets a plan and returns the rendered list", async () => {
    const plan = new PlanStore();
    const res = await planTool.execute({ action: "set", steps: ["one", "two"] }, ctx(plan));
    expect(res.ok).toBe(true);
    expect(res.content).toContain("1. [ ] one");
    expect(res.content).toContain("(0/2 done)");
  });

  it("rejects a set with no usable steps", async () => {
    const res = await planTool.execute({ action: "set", steps: ["  "] }, ctx(new PlanStore()));
    expect(res.ok).toBe(false);
  });

  it("rejects a non-array steps argument", async () => {
    const res = await planTool.execute({ action: "set", steps: "one" }, ctx(new PlanStore()));
    expect(res.ok).toBe(false);
    expect(res.content).toContain("array");
  });

  it("updates a step's status", async () => {
    const plan = new PlanStore();
    plan.set(["one", "two"]);
    const res = await planTool.execute({ action: "update", id: 1, status: "done" }, ctx(plan));
    expect(res.ok).toBe(true);
    expect(res.content).toContain("1. [x] one");
  });

  it("rejects an unknown status", async () => {
    const plan = new PlanStore();
    plan.set(["one"]);
    const res = await planTool.execute({ action: "update", id: 1, status: "finished" }, ctx(plan));
    expect(res.ok).toBe(false);
    expect(res.content).toContain("status must be one of");
  });

  it("rejects an unknown step id", async () => {
    const plan = new PlanStore();
    plan.set(["one"]);
    const res = await planTool.execute({ action: "update", id: 7, status: "done" }, ctx(plan));
    expect(res.ok).toBe(false);
    expect(res.content).toContain("No step with id 7");
  });

  it("rejects an unknown action", async () => {
    const res = await planTool.execute({ action: "destroy" }, ctx(new PlanStore()));
    expect(res.ok).toBe(false);
    expect(res.content).toContain("action must be one of");
  });

  it("persists state across separate calls", async () => {
    const plan = new PlanStore();
    await planTool.execute({ action: "set", steps: ["one", "two"] }, ctx(plan));
    await planTool.execute({ action: "update", id: 2, status: "active" }, ctx(plan));
    const res = await planTool.execute({ action: "show" }, ctx(plan));
    expect(res.content).toContain("2. [>] two");
  });
});

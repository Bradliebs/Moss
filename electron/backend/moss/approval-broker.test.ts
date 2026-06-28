// electron/backend/moss/approval-broker.test.ts
//
// Unit tests for the approval bridge between the async agent loop and the
// renderer's approve/deny click. Pure logic, no Electron.

import { describe, expect, it } from "vitest";

import { ApprovalBroker } from "./approval-broker";

describe("ApprovalBroker", () => {
  it("resolves a pending request with approval", async () => {
    const broker = new ApprovalBroker();
    const pending = broker.request("call-1");
    broker.resolve("call-1", true);
    await expect(pending).resolves.toBe(true);
  });

  it("resolves a pending request with denial", async () => {
    const broker = new ApprovalBroker();
    const pending = broker.request("call-1");
    broker.resolve("call-1", false);
    await expect(pending).resolves.toBe(false);
  });

  it("routes decisions to the matching call id independently", async () => {
    const broker = new ApprovalBroker();
    const a = broker.request("a");
    const b = broker.request("b");
    broker.resolve("b", true);
    broker.resolve("a", false);
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toBe(true);
  });

  it("denies everything still pending on denyAll", async () => {
    const broker = new ApprovalBroker();
    const a = broker.request("a");
    const b = broker.request("b");
    broker.denyAll();
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toBe(false);
  });

  it("ignores resolve for an unknown call id", async () => {
    const broker = new ApprovalBroker();
    expect(() => broker.resolve("missing", true)).not.toThrow();
    // A real pending request still works afterward.
    const pending = broker.request("real");
    broker.resolve("real", true);
    await expect(pending).resolves.toBe(true);
  });

  it("treats a second resolve for the same call id as a no-op", async () => {
    const broker = new ApprovalBroker();
    const pending = broker.request("a");
    broker.resolve("a", true);
    expect(() => broker.resolve("a", false)).not.toThrow();
    await expect(pending).resolves.toBe(true);
  });

  it("treats resolve after denyAll as a no-op", async () => {
    const broker = new ApprovalBroker();
    const pending = broker.request("a");
    broker.denyAll();
    expect(() => broker.resolve("a", true)).not.toThrow();
    await expect(pending).resolves.toBe(false);
  });
});

// electron/backend/moss/governed/review-queue.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/unused" } }));
vi.mock("../../../../common/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const memoryAdd = vi.hoisted(() =>
  vi.fn((fact: string, category: string, source: string) => ({
    id: "committed",
    fact,
    category,
    source,
    createdAt: "2026-07-02T00:00:00.000Z",
  })),
);
vi.mock("../memory/memory-store", () => ({ memoryStore: { add: memoryAdd } }));

import { MemoryReviewQueue } from "./review-queue";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "moss-review-"));
  memoryAdd.mockClear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("MemoryReviewQueue", () => {
  it("enqueues a proposal and lists it", () => {
    const q = new MemoryReviewQueue(dir);
    const entry = q.enqueue("prefers tabs", "preference");
    expect(entry?.fact).toBe("prefers tabs");
    expect(q.list()).toHaveLength(1);
  });

  it("does not enqueue an empty fact", () => {
    const q = new MemoryReviewQueue(dir);
    expect(q.enqueue("   ")).toBeNull();
    expect(q.list()).toHaveLength(0);
  });

  it("dedups a pending proposal case-insensitively", () => {
    const q = new MemoryReviewQueue(dir);
    q.enqueue("Same Fact");
    q.enqueue("same fact");
    expect(q.list()).toHaveLength(1);
  });

  it("approve commits to memory and removes from the queue", () => {
    const q = new MemoryReviewQueue(dir);
    const proposal = q.enqueue("save me", "fact")!;
    const committed = q.approve(proposal.id);
    expect(memoryAdd).toHaveBeenCalledWith("save me", "fact", "assistant");
    expect(committed?.id).toBe("committed");
    expect(q.list()).toHaveLength(0);
  });

  it("reject drops the proposal without writing to memory", () => {
    const q = new MemoryReviewQueue(dir);
    const proposal = q.enqueue("drop me")!;
    expect(q.reject(proposal.id)).toBe(true);
    expect(memoryAdd).not.toHaveBeenCalled();
    expect(q.list()).toHaveLength(0);
  });

  it("returns null/false for an unknown id", () => {
    const q = new MemoryReviewQueue(dir);
    expect(q.approve("nope")).toBeNull();
    expect(q.reject("nope")).toBe(false);
  });

  it("persists across instances", () => {
    new MemoryReviewQueue(dir).enqueue("durable");
    expect(new MemoryReviewQueue(dir).list()).toHaveLength(1);
  });
});

// electron/backend/moss/budget/daily-budget.test.ts

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/unused" } }));
vi.mock("../../../../common/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { DailyBudget } from "./daily-budget";

let dir: string;
const file = (): string => join(dir, "daily-budget.json");
const today = (): string => new Date().toISOString().slice(0, 10);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "moss-budget-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("DailyBudget", () => {
  it("reports zero spend with no ledger file", () => {
    expect(new DailyBudget(dir).spentToday()).toBe(0);
  });

  it("records and accumulates today's spend", () => {
    const b = new DailyBudget(dir);
    b.record(1.5);
    b.record(0.75);
    expect(b.spentToday()).toBeCloseTo(2.25, 5);
  });

  it("ignores non-positive amounts", () => {
    const b = new DailyBudget(dir);
    b.record(0);
    b.record(-5);
    expect(b.spentToday()).toBe(0);
  });

  it("resets spend when the stored day is not today", () => {
    writeFileSync(file(), JSON.stringify({ day: "2000-01-01", spentUsd: 99 }), "utf8");
    const b = new DailyBudget(dir);
    expect(b.spentToday()).toBe(0);
    b.record(1);
    const state = JSON.parse(readFileSync(file(), "utf8"));
    expect(state.day).toBe(today());
    expect(state.spentUsd).toBeCloseTo(1, 5);
  });

  it("treats a corrupt ledger as a fresh day", () => {
    writeFileSync(file(), "{ not json", "utf8");
    expect(new DailyBudget(dir).spentToday()).toBe(0);
  });
});

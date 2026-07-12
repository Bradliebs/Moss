// electron/backend/moss/budget/budget-provider.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/unused" } }));
vi.mock("../../../../common/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../providers/types";
import { ProviderError } from "../providers/types";
import { BudgetEnforcingProvider } from "./budget-provider";
import { DailyBudget } from "./daily-budget";

/** A stub provider that yields a fixed script of events. */
function fakeProvider(events: ProviderStreamEvent[]): ChatProvider {
  return {
    kind: "fake",
    async *streamChat(): AsyncIterable<ProviderStreamEvent> {
      for (const e of events) yield e;
    },
    listModels: async () => ["m"],
  };
}

const req: ChatRequest = { model: "gpt-4o", messages: [] };
const live = (): AbortSignal => new AbortController().signal;

async function drain(it: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "moss-budgetprov-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("BudgetEnforcingProvider", () => {
  it("passes stream events through unchanged", async () => {
    const budget = new DailyBudget(dir);
    const inner = fakeProvider([
      { type: "text-delta", text: "hi" },
      { type: "usage", usage: { inputTokens: 1000, outputTokens: 1000 } },
    ]);
    const wrapped = new BudgetEnforcingProvider(inner, 100, undefined, budget);
    const events = await drain(wrapped.streamChat(req, live()));
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text-delta", text: "hi" });
  });

  it("records the turn's estimated cost after the stream completes", async () => {
    const budget = new DailyBudget(dir);
    // gpt-4o: $2.5/1M in, $10/1M out. 1M in + 1M out => $12.50.
    const inner = fakeProvider([{ type: "usage", usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } }]);
    const wrapped = new BudgetEnforcingProvider(inner, 100, undefined, budget);
    await drain(wrapped.streamChat(req, live()));
    expect(budget.spentToday()).toBeCloseTo(12.5, 4);
  });

  it("blocks with a non-retryable ProviderError once the cap is reached", async () => {
    const budget = new DailyBudget(dir);
    budget.record(5);
    const inner = fakeProvider([{ type: "text-delta", text: "should not run" }]);
    const wrapped = new BudgetEnforcingProvider(inner, 5, undefined, budget);
    await expect(drain(wrapped.streamChat(req, live()))).rejects.toBeInstanceOf(ProviderError);
    try {
      await drain(wrapped.streamChat(req, live()));
    } catch (err) {
      expect((err as ProviderError).status).toBe(402);
    }
  });

  it("does not block or charge when no cap is set", async () => {
    const budget = new DailyBudget(dir);
    budget.record(999);
    const inner = fakeProvider([{ type: "text-delta", text: "ok" }]);
    const wrapped = new BudgetEnforcingProvider(inner, 0, undefined, budget);
    const events = await drain(wrapped.streamChat(req, live()));
    expect(events).toHaveLength(1);
  });

  it("honors user rate overrides when charging", async () => {
    const budget = new DailyBudget(dir);
    const inner = fakeProvider([{ type: "usage", usage: { inputTokens: 1_000_000, outputTokens: 0 } }]);
    const wrapped = new BudgetEnforcingProvider(inner, 100, { "gpt-4o": { inputPer1M: 1, outputPer1M: 1 } }, budget);
    await drain(wrapped.streamChat(req, live()));
    expect(budget.spentToday()).toBeCloseTo(1, 5);
  });
});

// electron/backend/moss/budget/budget-provider.ts
//
// A ChatProvider decorator that enforces a soft daily USD cap. Before a turn's
// stream begins it blocks when today's recorded spend already meets the cap;
// after the stream completes it charges the turn's estimated cost against the
// day. The block is raised as a ProviderError with a non-retryable status so the
// agent runner surfaces it immediately instead of retrying. The wrapper is a
// no-op unless a positive cap is supplied, so it is only attached when the user
// has set one.

import type { ModelRate } from "../../../../common/pricing";
import { estimateCost, formatUsd } from "../../../../common/pricing";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../providers/types";
import { ProviderError } from "../providers/types";
import { dailyBudget, DailyBudget } from "./daily-budget";

/** HTTP-ish status carried on the budget block so the runner's retry filter
 *  treats it as permanent (not a transient failure to retry). */
const BUDGET_BLOCK_STATUS = 402;

export class BudgetEnforcingProvider implements ChatProvider {
  readonly kind: string;

  constructor(
    private readonly inner: ChatProvider,
    private readonly capUsd: number,
    private readonly rates?: Record<string, ModelRate>,
    private readonly budget: DailyBudget = dailyBudget,
  ) {
    this.kind = inner.kind;
  }

  async *streamChat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    if (this.capUsd > 0) {
      const spent = this.budget.spentToday();
      if (spent >= this.capUsd) {
        throw new ProviderError(
          `Daily budget reached: ${formatUsd(spent)} of ${formatUsd(this.capUsd)} spent today. New requests are paused until tomorrow (UTC); raise or clear the cap in Settings to continue.`,
          BUDGET_BLOCK_STATUS,
        );
      }
    }

    let inputTokens = 0;
    let outputTokens = 0;
    for await (const ev of this.inner.streamChat(req, signal)) {
      if (ev.type === "usage") {
        inputTokens += ev.usage.inputTokens ?? 0;
        outputTokens += ev.usage.outputTokens ?? 0;
      }
      yield ev;
    }

    const cost = estimateCost({ inputTokens, outputTokens }, req.model, this.rates);
    if (cost && cost > 0) this.budget.record(cost);
  }

  listModels(): Promise<string[]> {
    return this.inner.listModels();
  }
}

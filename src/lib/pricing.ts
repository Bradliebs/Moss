// src/lib/pricing.ts
//
// Best-effort cost estimation for a conversation's token usage. Rates are
// built-in USD-per-million-token estimates for common models; they are
// approximate and can drift as providers change pricing. Unknown models return
// null so the UI shows nothing rather than fabricating a number.

import type { TokenUsage } from "@common/types";

export interface ModelRate {
  /** USD per 1,000,000 input (prompt) tokens. */
  inputPer1M: number;
  /** USD per 1,000,000 output (completion) tokens. */
  outputPer1M: number;
}

// Matched by case-insensitive substring against the model id, most specific
// first (so "gpt-4o-mini" wins over "gpt-4o").
const RATE_TABLE: { match: string; rate: ModelRate }[] = [
  { match: "gpt-4o-mini", rate: { inputPer1M: 0.15, outputPer1M: 0.6 } },
  { match: "gpt-4o", rate: { inputPer1M: 2.5, outputPer1M: 10 } },
  { match: "gpt-4.1-mini", rate: { inputPer1M: 0.4, outputPer1M: 1.6 } },
  { match: "gpt-4.1", rate: { inputPer1M: 2, outputPer1M: 8 } },
  { match: "o3-mini", rate: { inputPer1M: 1.1, outputPer1M: 4.4 } },
  { match: "claude-3-5-haiku", rate: { inputPer1M: 0.8, outputPer1M: 4 } },
  { match: "claude-3.5-haiku", rate: { inputPer1M: 0.8, outputPer1M: 4 } },
  { match: "claude-3-5-sonnet", rate: { inputPer1M: 3, outputPer1M: 15 } },
  { match: "claude-3.5-sonnet", rate: { inputPer1M: 3, outputPer1M: 15 } },
  { match: "claude-3-7-sonnet", rate: { inputPer1M: 3, outputPer1M: 15 } },
  { match: "claude-3.7-sonnet", rate: { inputPer1M: 3, outputPer1M: 15 } },
];

/** Look up the rate for a model id. A user-supplied overrides map (keyed by
 *  lowercased model id) wins over the built-in table, so configured rates never
 *  drift against bundled estimates. Returns null when nothing matches. */
export function modelRate(model: string, overrides?: Record<string, ModelRate>): ModelRate | null {
  const id = model.trim().toLowerCase();
  if (!id) return null;
  const override = overrides?.[id];
  if (override) return override;
  return RATE_TABLE.find((e) => id.includes(e.match))?.rate ?? null;
}

/** Estimate the USD cost of the given token usage for a model, or null when the
 *  model has no override and no built-in rate. */
export function estimateCost(
  usage: TokenUsage,
  model: string,
  overrides?: Record<string, ModelRate>,
): number | null {
  const rate = modelRate(model, overrides);
  if (!rate) return null;
  const input = ((usage.inputTokens ?? 0) / 1_000_000) * rate.inputPer1M;
  const output = ((usage.outputTokens ?? 0) / 1_000_000) * rate.outputPer1M;
  return input + output;
}

/** Format a USD cost for display. Sub-cent costs keep four decimals so a small
 *  conversation does not round to "$0.00". */
export function formatUsd(n: number): string {
  return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

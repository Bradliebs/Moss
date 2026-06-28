// src/lib/pricing.test.ts

import { describe, expect, it } from "vitest";

import { estimateCost, formatUsd, modelRate } from "./pricing";

describe("modelRate", () => {
  it("matches the most specific model first", () => {
    // gpt-4o-mini must not be captured by the gpt-4o entry.
    expect(modelRate("gpt-4o-mini")).toEqual({ inputPer1M: 0.15, outputPer1M: 0.6 });
    expect(modelRate("gpt-4o")).toEqual({ inputPer1M: 2.5, outputPer1M: 10 });
  });

  it("matches case-insensitively and tolerates provider prefixes", () => {
    expect(modelRate("Anthropic/Claude-3-5-Sonnet-20241022")).toEqual({ inputPer1M: 3, outputPer1M: 15 });
  });

  it("returns null for an unknown or empty model", () => {
    expect(modelRate("some-local-model")).toBeNull();
    expect(modelRate("")).toBeNull();
  });

  it("prefers a user override over the built-in table", () => {
    const overrides = { "gpt-4o": { inputPer1M: 1, outputPer1M: 2 } };
    expect(modelRate("gpt-4o", overrides)).toEqual({ inputPer1M: 1, outputPer1M: 2 });
  });

  it("matches an override case-insensitively and gives an unknown model a rate", () => {
    const overrides = { "my-local": { inputPer1M: 0.5, outputPer1M: 0.5 } };
    expect(modelRate("My-Local", overrides)).toEqual({ inputPer1M: 0.5, outputPer1M: 0.5 });
  });

  it("falls back to the built-in table when no override matches", () => {
    const overrides = { "other": { inputPer1M: 9, outputPer1M: 9 } };
    expect(modelRate("gpt-4o", overrides)).toEqual({ inputPer1M: 2.5, outputPer1M: 10 });
  });
});

describe("estimateCost", () => {
  it("sums input and output cost from per-million rates", () => {
    // 1M input @ $2.50 + 0.5M output @ $10 = 2.5 + 5 = 7.5
    const cost = estimateCost({ inputTokens: 1_000_000, outputTokens: 500_000 }, "gpt-4o");
    expect(cost).toBeCloseTo(7.5, 6);
  });

  it("returns null when the model has no built-in rate", () => {
    expect(estimateCost({ inputTokens: 1000, outputTokens: 1000 }, "mystery")).toBeNull();
  });

  it("treats missing token counts as zero", () => {
    expect(estimateCost({}, "gpt-4o")).toBe(0);
  });

  it("uses an override rate when one is supplied", () => {
    // 1M input @ $1 + 1M output @ $2 = 3, beating the built-in gpt-4o rate.
    const overrides = { "gpt-4o": { inputPer1M: 1, outputPer1M: 2 } };
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, "gpt-4o", overrides)).toBeCloseTo(3, 6);
  });

  it("prices an otherwise-unknown model from an override", () => {
    const overrides = { "mystery": { inputPer1M: 4, outputPer1M: 4 } };
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 0 }, "mystery", overrides)).toBeCloseTo(4, 6);
  });
});

describe("formatUsd", () => {
  it("keeps four decimals for sub-cent costs", () => {
    expect(formatUsd(0.0012)).toBe("$0.0012");
  });

  it("uses two decimals at or above a cent", () => {
    expect(formatUsd(7.5)).toBe("$7.50");
  });
});

// src/lib/pricing.ts
//
// Re-export of the shared pricing helpers. The rate table and cost math now live
// in common/pricing.ts so the Electron main process (daily-budget enforcer) and
// the renderer (cost readouts) share one source of truth. This module remains
// the renderer's stable import path.

export type { ModelRate } from "@common/pricing";
export { estimateCost, formatUsd, modelRate } from "@common/pricing";

// electron/backend/moss/governed/confidence.ts
//
// A zero-cost, shadow confidence label for a completed turn. It classifies the
// turn from signals the agent loop already has -- whether tools ran, whether any
// failed, and whether external content was pulled in -- so it adds no extra
// model calls and never changes the answer. The renderer shows it as a small
// chip when the user opts in. This is deliberately NOT an LLM self-critique: it
// stays free and side-effect-free.

import type { ConfidenceMode } from "../../../../common/types";

export interface ConfidenceSignals {
  /** at least one tool ran this turn */
  toolRan: boolean;
  /** at least one tool returned a failure */
  toolFailed: boolean;
  /** at least one external-content tool ran (web/fetch/transcription/MCP) */
  usedExternal: boolean;
}

/** Map turn signals to a confidence mode. Order matters: a failure dominates,
 *  then freshly fetched external content, then tool-backed reasoning, else a
 *  plain model answer. */
export function classifyConfidenceMode(s: ConfidenceSignals): ConfidenceMode {
  if (s.toolFailed) return "needs-review";
  if (s.usedExternal) return "web-fresh";
  if (s.toolRan) return "reasoned";
  return "settled";
}

const NOTES: Record<ConfidenceMode, string> = {
  settled: "Answered from the model's own knowledge; no tools were used.",
  reasoned: "Backed by workspace tool results from this turn.",
  "web-fresh": "Draws on freshly fetched external content — verify anything critical.",
  "needs-review": "A tool failed this turn, so the answer may be incomplete.",
};

/** Human-readable explanation for a confidence mode (chip tooltip). */
export function describeConfidence(mode: ConfidenceMode): string {
  return NOTES[mode];
}

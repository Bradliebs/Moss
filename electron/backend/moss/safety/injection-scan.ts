// electron/backend/moss/safety/injection-scan.ts
//
// A fast, dependency-free tripwire for the most common indirect prompt-injection
// phrasings that appear inside external content (web pages, fetched URLs, MCP
// output). This is detection, not a guarantee: it complements the structural
// <external_content> envelope rather than replacing it. Pure regex, so it adds
// negligible latency and is trivially unit-testable.

// How the agent loop reacts to a detection (off/flag/block). The union is shared
// with the renderer's settings, so it is defined in common/types and re-exported
// here for the backend's existing import paths.
export type { InjectionMode } from "../../../../common/types";

export type InjectionCategory =
  | "role_override"
  | "instruction_insert"
  | "system_prompt_leak"
  | "data_exfiltration";

export interface InjectionScanResult {
  /** true when at least one pattern matched */
  flagged: boolean;
  /** distinct categories that matched, in first-seen order */
  categories: InjectionCategory[];
  /** highest confidence (0..1) among matched patterns */
  confidence: number;
}

/** Content scoring at or above this confidence is treated as a hard hit in
 *  `block` mode. Tuned so unambiguous override phrasings block while softer
 *  signals only flag. */
export const INJECTION_BLOCK_THRESHOLD = 0.7;

const PATTERNS: { category: InjectionCategory; confidence: number; re: RegExp }[] = [
  { category: "role_override", confidence: 0.9, re: /ignore\s+(all\s+|the\s+)?(previous|prior|earlier|above)\s+(instructions?|prompts?|messages?)/i },
  { category: "role_override", confidence: 0.85, re: /disregard\s+(all\s+|the\s+|any\s+)?(previous|prior|earlier|above|your)\s+(instructions?|rules?|prompts?|guidelines?)/i },
  { category: "role_override", confidence: 0.7, re: /you\s+are\s+now\s+(a|an|the|no\s+longer)\b/i },
  { category: "instruction_insert", confidence: 0.75, re: /\bnew\s+(instructions?|rules?|system\s+prompt)\s*:/i },
  { category: "instruction_insert", confidence: 0.6, re: /\bsystem\s+prompt\s*:/i },
  { category: "system_prompt_leak", confidence: 0.7, re: /\b(reveal|print|repeat|show|output)\s+(your\s+|the\s+)?(system\s+prompt|initial\s+instructions|hidden\s+instructions)/i },
  { category: "data_exfiltration", confidence: 0.75, re: /\b(send|post|exfiltrate|upload|email|leak)\b.{0,40}\b(api[_\s-]?keys?|secrets?|passwords?|tokens?|credentials?)\b/i },
];

/** Scan external content for common injection phrasings. */
export function scanForInjection(text: string): InjectionScanResult {
  const categories: InjectionCategory[] = [];
  let confidence = 0;
  for (const p of PATTERNS) {
    if (p.re.test(text)) {
      if (!categories.includes(p.category)) categories.push(p.category);
      if (p.confidence > confidence) confidence = p.confidence;
    }
  }
  return { flagged: categories.length > 0, categories, confidence };
}

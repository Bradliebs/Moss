// electron/backend/moss/context/compaction.ts
//
// History compaction for long sessions. When the model-facing history grows past
// a fraction of the user-configured context window, the oldest messages are
// dropped and a short note is folded into the system message. Compaction is a
// no-op unless a context limit is set (settings.contextLimit), so it never runs
// on a guess about the model's window.
//
// Safety: the retained tail always begins at a `user` message. Because we keep a
// contiguous suffix of the conversation (never removing messages from the
// middle), every assistant tool_use in the tail still has its matching
// tool_result, and user/assistant alternation stays valid for strict providers
// like Anthropic. The most recent user message is always retained.

import type { AgentMessage } from "../../../../common/types";

/** Fraction of the context window budgeted for input; the rest is left for the
 *  model's reply so compaction does not fill the window to the brim. */
const INPUT_BUDGET_FRACTION = 0.75;

export interface CompactionResult {
  messages: AgentMessage[];
  compacted: boolean;
  /** number of leading (oldest) non-system messages dropped */
  droppedCount: number;
}

/** Rough token estimate (~4 chars/token) over message text and tool-call args,
 *  with a small per-message overhead. Deliberately conservative and cheap. */
export function estimateTokens(messages: readonly AgentMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length + 8;
    if (m.toolCalls) for (const c of m.toolCalls) chars += c.name.length + c.arguments.length;
  }
  return Math.ceil(chars / 4);
}

function noteText(dropped: number): string {
  return `[Context note: ${dropped} earlier ${dropped === 1 ? "message was" : "messages were"} omitted to fit the context window.]`;
}

function systemWithNote(system: AgentMessage | undefined, dropped: number): AgentMessage {
  if (system) return { ...system, content: `${system.content}\n\n${noteText(dropped)}` };
  return { role: "system", content: noteText(dropped) };
}

/** Drop the oldest messages when the history exceeds the input budget. Returns
 *  the input unchanged when no limit is set, the history already fits, or no
 *  safe cut point exists. */
export function compactIfNeeded(
  messages: readonly AgentMessage[],
  opts: { contextLimit: number },
): CompactionResult {
  const unchanged: CompactionResult = { messages: [...messages], compacted: false, droppedCount: 0 };
  const limit = opts.contextLimit;
  if (!(limit > 0)) return unchanged;

  const inputBudget = Math.floor(limit * INPUT_BUDGET_FRACTION);
  if (estimateTokens(messages) <= inputBudget) return unchanged;

  const hasSystem = messages.length > 0 && messages[0].role === "system";
  const system = hasSystem ? messages[0] : undefined;
  const body = hasSystem ? messages.slice(1) : messages.slice();

  // Safe cut points: indices where a retained tail begins with a user message.
  const userIdxs: number[] = [];
  for (let i = 0; i < body.length; i++) if (body[i].role === "user") userIdxs.push(i);
  if (userIdxs.length === 0) return unchanged; // no safe boundary

  // Prefer the smallest drop that fits; otherwise fall back to the largest safe
  // drop (keep from the most recent user message onward).
  let cut = userIdxs[userIdxs.length - 1];
  for (const c of userIdxs) {
    if (c === 0) continue; // dropping nothing is not compaction
    const candidate = [systemWithNote(system, c), ...body.slice(c)];
    if (estimateTokens(candidate) <= inputBudget) {
      cut = c;
      break;
    }
  }
  if (cut === 0) return unchanged; // only the first message is a user; nothing to drop

  return {
    messages: [systemWithNote(system, cut), ...body.slice(cut)],
    compacted: true,
    droppedCount: cut,
  };
}

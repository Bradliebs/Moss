// electron/backend/moss/context/handoff.ts
//
// Model-written handoff summaries. When a conversation outgrows what is
// comfortable to keep re-sending, the renderer asks for a summary here and seeds
// a fresh chat with it. This is a single, tool-free, non-agentic provider call:
// no tools are offered, nothing is written to disk, and the source conversation
// is never mutated.
//
// The transcript handed to the model is bounded twice — per message and overall
// — because the whole reason this is being called is that the conversation is
// too big. When the budget is exceeded the middle is dropped, keeping the
// opening (which usually carries the goal) and the most recent exchanges.

import type { AgentMessage } from "../../../../common/types";
import type { ChatProvider } from "../providers/types";

/** Per-message clip. Long tool-heavy replies are summarized, not reproduced. */
const MAX_MESSAGE_CHARS = 2000;
/** Whole-transcript budget (~15k tokens at ~4 chars/token). */
const MAX_TRANSCRIPT_CHARS = 60_000;
/** Cap on the summary itself, so the new chat starts small. */
const MAX_SUMMARY_TOKENS = 1500;
/** Give up rather than hang the button forever. */
const SUMMARY_TIMEOUT_MS = 90_000;

const SUMMARIZER_SYSTEM = [
  "You write handoff notes between AI assistant sessions.",
  "You are given a transcript of a conversation that has grown too long to keep in context.",
  "Write the note that lets a fresh assistant session pick the work up without the transcript.",
  "",
  "Rules:",
  "- Write for the assistant taking over, not for the user. No greeting, no sign-off.",
  "- Record decisions and their reasons, not just topics. 'Chose X over Y because Z' beats 'discussed X and Y'.",
  "- Name concrete artifacts: file paths, function names, commands, identifiers, versions.",
  "- Separate what is settled from what is still open. Never present an open question as decided.",
  "- If the transcript says the middle was omitted, do not invent what was in it.",
  "- Be specific and dense. No filler, no restating these instructions.",
].join("\n");

const SUMMARY_SECTIONS = [
  "## Goal",
  "## Decisions made (and why)",
  "## Current state",
  "## Open threads",
  "## Immediate next step",
].join("\n");

function clip(text: string, max: number): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max)}\n…[message truncated]` : clean;
}

/** Render one message as a transcript line. Tool calls are named (with clipped
 *  arguments) because what the assistant *did* is part of the state being handed
 *  over; tool results are omitted because they are bulk, not decisions. */
function renderMessage(m: AgentMessage): string | null {
  if (m.role === "user") {
    const body = clip(m.content, MAX_MESSAGE_CHARS);
    return body ? `USER: ${body}` : null;
  }
  if (m.role !== "assistant") return null;
  const parts: string[] = [];
  const body = clip(m.content, MAX_MESSAGE_CHARS);
  if (body) parts.push(`ASSISTANT: ${body}`);
  for (const call of m.toolCalls ?? []) parts.push(`ASSISTANT ran tool: ${call.name}(${clip(call.arguments, 200)})`);
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Build the bounded transcript the summarizer sees. Exported for testing. */
export function buildTranscript(messages: readonly AgentMessage[]): string {
  const lines = messages.map(renderMessage).filter((line): line is string => line !== null);
  const total = lines.reduce((sum, line) => sum + line.length + 2, 0);
  if (total <= MAX_TRANSCRIPT_CHARS || lines.length < 3) return lines.join("\n\n");

  // Keep the opening (the goal usually lives there) and as much of the tail as
  // fits; the middle is dropped with an explicit marker so the model does not
  // fill the gap with invention.
  const head = lines[0];
  let used = head.length + 2;
  const tail: string[] = [];
  for (let i = lines.length - 1; i >= 1; i--) {
    const cost = lines[i].length + 2;
    if (used + cost > MAX_TRANSCRIPT_CHARS) break;
    used += cost;
    tail.unshift(lines[i]);
  }
  const omitted = lines.length - 1 - tail.length;
  if (omitted <= 0) return lines.join("\n\n");
  return [head, `[… ${omitted} message${omitted === 1 ? "" : "s"} from the middle of the conversation omitted …]`, ...tail].join(
    "\n\n",
  );
}

/** Ask the model for a handoff note. Never throws: a failure is returned as
 *  `{ ok: false }` so the caller can fall back to a locally built digest. */
export async function summarizeForHandoff(
  provider: ChatProvider,
  model: string,
  messages: readonly AgentMessage[],
  title: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ ok: boolean; summary: string; error?: string }> {
  const transcript = buildTranscript(messages);
  if (!transcript.trim()) return { ok: false, summary: "", error: "The conversation has nothing to summarize." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? SUMMARY_TIMEOUT_MS);
  const onOuterAbort = (): void => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort);

  try {
    let text = "";
    const stream = provider.streamChat(
      {
        model,
        messages: [
          { role: "system", content: SUMMARIZER_SYSTEM },
          {
            role: "user",
            content: [
              `Conversation title: ${title}`,
              "",
              "Write the handoff note using exactly these sections:",
              SUMMARY_SECTIONS,
              "",
              "Transcript:",
              "",
              transcript,
            ].join("\n"),
          },
        ],
        maxTokens: MAX_SUMMARY_TOKENS,
      },
      controller.signal,
    );
    for await (const event of stream) {
      if (event.type === "text-delta") text += event.text;
    }
    const summary = text.trim();
    if (!summary) return { ok: false, summary: "", error: "The model returned an empty summary." };
    return { ok: true, summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, summary: "", error: controller.signal.aborted ? `Summary timed out or was cancelled (${message}).` : message };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

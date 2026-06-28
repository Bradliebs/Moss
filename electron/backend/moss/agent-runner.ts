// electron/backend/moss/agent-runner.ts
//
// The agentic turn loop: stream assistant output, accumulate any tool calls,
// permission-gate + execute them, feed results back, and repeat until the model
// stops calling tools (or a round cap is hit).

import type { AgentMessage, MossEvent, SttConfig, TokenUsage, ToolCall, ToolDefinition } from "../../../common/types";
import { resolvePermission } from "./permission";
import { ProviderError } from "./providers/types";
import type { ChatProvider } from "./providers/types";
import type { Tool, ToolResult } from "./tools";

const MAX_ROUNDS = 8;
/** Retries for a transient provider stream failure, attempted only before any
 *  output has been emitted for the round (so a retry cannot duplicate it). */
const MAX_STREAM_RETRIES = 2;
const STREAM_RETRY_BASE_MS = 500;
/** Per-tool-result cap (characters) applied to the model-facing history only;
 *  the renderer and persisted history keep the full content. */
const MAX_TOOL_RESULT_CHARS = 8000;
/** Per-tool execution timeout backstop for a hung or non-cooperative tool. */
const TOOL_TIMEOUT_MS = 180_000;

export interface RunTurnOptions {
  provider: ChatProvider;
  model: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
  toolRegistry: Map<string, Tool>;
  workspaceRoot: string;
  signal: AbortSignal;
  onEvent: (event: MossEvent) => void;
  /** resolves true if the user approves the gated call */
  requestApproval: (callId: string) => Promise<boolean>;
  /** when true, skip the approval gate and run mutating tools automatically */
  autoApprove?: boolean;
  /** speech-to-text config for the transcribe_audio tool */
  stt?: SttConfig;
  /** base backoff for stream-failure retries (ms); overridable for tests. */
  streamRetryBaseMs?: number;
  /** per-tool execution timeout (ms); overridable for tests. */
  toolTimeoutMs?: number;
}

export async function runTurn(opts: RunTurnOptions): Promise<void> {
  const { provider, model, tools, signal, onEvent } = opts;
  // Seed the model-facing history from the caller, capping each prior tool
  // result so a large earlier-turn output cannot reaccumulate in the context
  // window across turns. newMessages and the renderer keep the full content.
  const conversation = opts.messages.map((m) =>
    m.role === "tool" ? { ...m, content: truncateForModel(m.content) } : m,
  );
  const newMessages: AgentMessage[] = [];
  // Holds the current round's streamed assistant text so a mid-stream throw can
  // still persist what was shown before the failure. Reset once the round's
  // assistant message is committed to newMessages.
  let pendingText = "";

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (signal.aborted) {
        onEvent({ type: "turn-aborted", messages: newMessages });
        return;
      }

      pendingText = "";
      let roundUsage: TokenUsage | undefined;
      let calls: ToolCall[] = [];
      // Stream the round, retrying a transient provider failure only while
      // nothing has been emitted to the renderer yet -- once text or usage has
      // been shown, a retry would duplicate it, so we let the error propagate.
      for (let attempt = 0; ; attempt++) {
        pendingText = "";
        calls = [];
        let usageIn = 0;
        let usageOut = 0;
        let sawUsage = false;
        try {
          for await (const ev of provider.streamChat({ model, messages: conversation, tools }, signal)) {
            if (signal.aborted) break;
            if (ev.type === "text-delta") {
              pendingText += ev.text;
              onEvent({ type: "text-delta", text: ev.text });
            } else if (ev.type === "tool-call") {
              calls.push({ id: ev.toolCall.id, name: ev.toolCall.name, arguments: ev.toolCall.arguments });
            } else if (ev.type === "usage") {
              usageIn += ev.usage.inputTokens ?? 0;
              usageOut += ev.usage.outputTokens ?? 0;
              sawUsage = true;
              onEvent({ type: "token-usage", usage: ev.usage });
            }
          }
          roundUsage = sawUsage ? { inputTokens: usageIn, outputTokens: usageOut } : undefined;
          break;
        } catch (err) {
          if (signal.aborted) throw err;
          const emitted = pendingText.length > 0 || sawUsage;
          if (emitted || attempt >= MAX_STREAM_RETRIES || !isRetryableStreamError(err)) throw err;
          onEvent({
            type: "notice",
            level: "warn",
            message: `Stream interrupted; retrying (${attempt + 1}/${MAX_STREAM_RETRIES})...`,
          });
          await delay((opts.streamRetryBaseMs ?? STREAM_RETRY_BASE_MS) * 2 ** attempt, signal);
        }
      }

      if (signal.aborted) {
        onEvent({ type: "turn-aborted", messages: newMessages });
        return;
      }

      const assistantMsg: AgentMessage = {
        role: "assistant",
        content: pendingText,
        ...(calls.length > 0 ? { toolCalls: calls } : {}),
        ...(roundUsage ? { usage: roundUsage } : {}),
      };
      conversation.push(assistantMsg);
      newMessages.push(assistantMsg);
      pendingText = "";

      if (calls.length === 0) {
        onEvent({ type: "turn-complete", messages: newMessages });
        return;
      }

      for (const call of calls) {
        onEvent({ type: "tool-call", callId: call.id, name: call.name, arguments: call.arguments });
        const { result, autoApproved } = await executeCall(call, opts);
        const toolMsg: AgentMessage = {
          role: "tool",
          content: result.content,
          toolCallId: call.id,
          ...(autoApproved ? { autoApproved: true } : {}),
        };
        newMessages.push(toolMsg);
        // The model-facing history caps each tool result so one large output
        // cannot exhaust the context across this turn's rounds; newMessages and
        // the renderer event above keep the full content.
        conversation.push({ ...toolMsg, content: truncateForModel(result.content) });
        onEvent({
          type: "tool-result",
          callId: call.id,
          name: call.name,
          ok: result.ok,
          content: result.content,
          autoApproved,
        });
      }
    }

    onEvent({ type: "turn-error", message: `Stopped after ${MAX_ROUNDS} tool rounds`, messages: newMessages });
  } catch (err) {
    if (signal.aborted) {
      onEvent({ type: "turn-aborted", messages: newMessages });
      return;
    }
    // Fold in any partial text streamed before the throw so the renderer can
    // commit it verbatim instead of reconstructing from the delta events.
    if (pendingText) {
      newMessages.push({ role: "assistant", content: pendingText });
    }
    onEvent({ type: "turn-error", message: err instanceof Error ? err.message : String(err), messages: newMessages });
  }
}

interface ExecOutcome {
  result: ToolResult;
  /** true only for a mutating ("ask") tool that ran without a prompt because
   *  auto-approve was on -- the one case where the user did not see the call */
  autoApproved: boolean;
}

async function executeCall(call: ToolCall, opts: RunTurnOptions): Promise<ExecOutcome> {
  const tool = opts.toolRegistry.get(call.name);
  if (!tool) return { result: { ok: false, content: `Unknown tool: ${call.name}` }, autoApproved: false };

  let args: Record<string, unknown>;
  try {
    args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
  } catch {
    return {
      result: { ok: false, content: `Invalid JSON arguments for ${call.name}: ${call.arguments}` },
      autoApproved: false,
    };
  }

  const decision = resolvePermission({
    name: call.name,
    command: call.name === "run_command" ? String(args.command ?? "") : undefined,
    autoApprove: opts.autoApprove === true,
  });
  if (decision.action === "deny") {
    return { result: { ok: false, content: `Denied by policy: ${call.name}` }, autoApproved: false };
  }

  if (decision.action === "prompt") {
    opts.onEvent({
      type: "tool-approval-request",
      callId: call.id,
      name: call.name,
      arguments: call.arguments,
      risk: decision.risk,
    });
    const approved = await opts.requestApproval(call.id);
    if (!approved) return { result: { ok: false, content: `User denied: ${call.name}` }, autoApproved: false };
  }

  try {
    const result = await runWithTimeout(
      (sig) => tool.execute(args, { workspaceRoot: opts.workspaceRoot, signal: sig, stt: opts.stt }),
      opts.signal,
      opts.toolTimeoutMs ?? TOOL_TIMEOUT_MS,
      call.name,
    );
    return { result, autoApproved: decision.autoApproved };
  } catch (err) {
    return {
      result: { ok: false, content: err instanceof Error ? err.message : String(err) },
      autoApproved: decision.autoApproved,
    };
  }
}

/** Cap a tool result for the model-facing history (head + tail) so one huge
 *  output cannot exhaust the context window across a turn's rounds. */
function truncateForModel(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  const tailLen = 2000;
  const head = content.slice(0, MAX_TOOL_RESULT_CHARS - tailLen);
  const tail = content.slice(-tailLen);
  const dropped = content.length - head.length - tail.length;
  return `${head}\n\n...[truncated ${dropped} characters]...\n\n${tail}`;
}

/** A pre-output stream failure is retried only when it looks transient: a
 *  network-level error (no HTTP status reached us) or a server-side/rate-limit
 *  status. A client-side status (bad auth, model, or request) is permanent, so
 *  we surface it immediately instead of paying the retry backoff. */
function isRetryableStreamError(err: unknown): boolean {
  const status = err instanceof ProviderError ? err.status : undefined;
  if (status === undefined) return true;
  if (status >= 500) return true;
  return status === 408 || status === 409 || status === 425 || status === 429;
}

/** Abortable sleep; resolves early when the signal aborts so the round-top
 *  guard can take over. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Run a tool under a timeout backstop. On timeout the derived signal is aborted
 *  (best-effort cancel for cooperative tools) and the rejection is folded into a
 *  failed ToolResult by the caller. A parent abort cancels the derived signal
 *  too, preserving the existing abort semantics. */
async function runWithTimeout(
  fn: (signal: AbortSignal) => Promise<ToolResult>,
  parent: AbortSignal,
  ms: number,
  name: string,
): Promise<ToolResult> {
  if (ms <= 0) return fn(parent);
  const ctrl = new AbortController();
  const onParentAbort = (): void => ctrl.abort();
  if (parent.aborted) ctrl.abort();
  else parent.addEventListener("abort", onParentAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`Tool '${name}' timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  try {
    return await Promise.race([fn(ctrl.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    parent.removeEventListener("abort", onParentAbort);
  }
}

// src/components/ChatPanel.tsx

import { useEffect, useRef, useState } from "react";

import type { AgentMessage, ChatEventPayload, TokenUsage } from "@common/types";
import { PERSONALITY_PRESETS } from "@common/personalities";

import { useDictation } from "../lib/dictation";
import { imageAttachmentError, isLikelyVisionModel, textAttachmentError, textLanguageForFile } from "../lib/attachments";
import { parseMarkdown, segmentToMarkdown, type InlineSegment } from "../lib/markdown";
import { estimateCost, formatUsd } from "../lib/pricing";
import {
  clearSession,
  contextWindowTokens,
  contextWindowUsage,
  currentSession,
  ensureCurrentSession,
  getSessionMessages,
  getSessionPersonality,
  sessionTokenUsage,
  sessionToolUsage,
  sessionToolAudit,
  setSessionMessages,
  setSessionPersonality,
  setSessionTitle,
  useSessions,
} from "../lib/sessions";
import { modelsStore, toProviderConfig, updateSettings, useSettings } from "../lib/settings";
import { type ToolStatus, toolStatusColor } from "../lib/toolStatus";
import { WelcomeScreen } from "./WelcomeScreen";

interface ToolView {
  kind: "tool";
  callId: string;
  name: string;
  args: string;
  status: ToolStatus;
  result?: string;
  autoApproved?: boolean;
  /** content risk tier for run_command, surfaced on the approval prompt */
  risk?: "readonly" | "mutating" | "destructive";
}

interface MessageView {
  kind: "message";
  role: "user" | "assistant";
  content: string;
  images?: string[];
  interrupted?: boolean;
  usage?: TokenUsage;
  turnUsage?: TokenUsage;
  historyIndex?: number;
}

type ViewItem = MessageView | ToolView;

/** Render a token count with thousands separators so large conversation totals
 *  stay scannable (e.g. 12530 -> "12,530"). */
function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

/** Render one inline piece (text, bold, inline code, or link) of a reply.
 *  Links are shown as styled, non-navigating text with the URL on hover; only
 *  http(s)/mailto URLs get a tooltip so a tooltip never carries a script URL. */
function renderInline(seg: InlineSegment, key: number) {
  if (seg.type === "bold") {
    return (
      <strong key={key} className="font-semibold text-neutral-900 dark:text-neutral-100">
        {seg.value}
      </strong>
    );
  }
  if (seg.type === "inlineCode") {
    return (
      <code key={key} className="rounded bg-neutral-50/70 dark:bg-neutral-950/70 px-1 py-0.5 text-[0.85em] text-emerald-200">
        {seg.value}
      </code>
    );
  }
  if (seg.type === "strike") {
    return (
      <span key={key} className="text-neutral-600 dark:text-neutral-400 line-through">
        {seg.value}
      </span>
    );
  }
  if (seg.type === "link") {
    const safeHref = /^(https?:|mailto:)/i.test(seg.href) ? seg.href : undefined;
    return (
      <span
        key={key}
        className={`text-emerald-300 underline decoration-emerald-500/40${safeHref ? " cursor-pointer" : ""}`}
        title={safeHref}
        onClick={safeHref ? () => void window.moss.shell?.openExternal(safeHref) : undefined}
      >
        {seg.value}
      </span>
    );
  }
  return <span key={key}>{seg.value}</span>;
}

/** Render an assistant reply with fenced code blocks, inline code, bold,
 *  headings, links, and lists split out for readability; prose is preserved. */
function renderContent(content: string) {
  return parseMarkdown(content).map((seg, i) => {
    if (seg.type === "code") {
      return (
        <div key={i} className="group/code relative">
          <CopyButton
            text={seg.value}
            className="absolute right-1.5 top-1.5 rounded bg-neutral-200/80 dark:bg-neutral-800/80 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:text-neutral-400 opacity-0 transition hover:text-neutral-900 dark:hover:text-neutral-100 group-hover/code:opacity-100"
            title="Copy this code block to the clipboard."
          />
          <pre className="my-2 overflow-x-auto rounded-lg border border-neutral-300/60 dark:border-neutral-700/60 bg-neutral-50 dark:bg-neutral-950 p-2.5 text-xs text-neutral-800 dark:text-neutral-200">
            <code>{seg.value}</code>
          </pre>
        </div>
      );
    }
    if (seg.type === "heading") {
      const size = seg.level <= 1 ? "text-base" : seg.level === 2 ? "text-sm" : "text-xs";
      return (
        <div key={i} className={`mb-1 mt-2 font-semibold text-neutral-900 dark:text-neutral-100 ${size}`}>
          {seg.content.map((p, pi) => renderInline(p, pi))}
        </div>
      );
    }
    if (seg.type === "hr") {
      return <hr key={i} className="my-3 border-neutral-300/60 dark:border-neutral-700/60" />;
    }
    if (seg.type === "blockquote") {
      return (
        <blockquote key={i} className="my-2 border-l-2 border-neutral-400 dark:border-neutral-600 pl-3 text-neutral-600 dark:text-neutral-400">
          {seg.content.map((p, pi) => renderInline(p, pi))}
        </blockquote>
      );
    }
    if (seg.type === "list") {
      const cls = `my-1 ml-5 space-y-0.5 ${seg.ordered ? "list-decimal" : "list-disc"}`;
      const items = seg.items.map((parts, li) => (
        <li key={li}>{parts.map((p, pi) => renderInline(p, pi))}</li>
      ));
      return seg.ordered ? (
        <ol key={i} className={cls}>
          {items}
        </ol>
      ) : (
        <ul key={i} className={cls}>
          {items}
        </ul>
      );
    }
    if (seg.type === "taskList") {
      return (
        <div key={i} className="group/blk relative">
          <CopyButton
            text={segmentToMarkdown(seg)}
            className="absolute right-1.5 top-0 rounded bg-neutral-200/80 dark:bg-neutral-800/80 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:text-neutral-400 opacity-0 transition hover:text-neutral-900 dark:hover:text-neutral-100 group-hover/blk:opacity-100"
            title="Copy this task list as markdown to the clipboard."
          />
          <ul className="my-1 ml-1 space-y-0.5">
            {seg.items.map((it, li) => (
              <li key={li} className="flex items-start gap-1.5">
                <input
                  type="checkbox"
                  checked={it.checked}
                  readOnly
                  disabled
                  className="mt-0.5 accent-emerald-500"
                />
                <span>{it.content.map((p, pi) => renderInline(p, pi))}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    }
    if (seg.type === "table") {
      return (
        <div key={i} className="group/blk relative my-2 overflow-x-auto">
          <CopyButton
            text={segmentToMarkdown(seg)}
            className="absolute right-1.5 top-1.5 z-10 rounded bg-neutral-200/80 dark:bg-neutral-800/80 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:text-neutral-400 opacity-0 transition hover:text-neutral-900 dark:hover:text-neutral-100 group-hover/blk:opacity-100"
            title="Copy this table as markdown to the clipboard."
          />
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                {seg.header.map((cell, ci) => (
                  <th
                    key={ci}
                    className="border border-neutral-300/60 dark:border-neutral-700/60 px-2 py-1 text-left font-semibold text-neutral-800 dark:text-neutral-200"
                  >
                    {cell.map((p, pi) => renderInline(p, pi))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {seg.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className="border border-neutral-300/60 dark:border-neutral-700/60 px-2 py-1 align-top text-neutral-700 dark:text-neutral-300"
                    >
                      {cell.map((p, pi) => renderInline(p, pi))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    return renderInline(seg, i);
  });
}

/** Copy button that briefly swaps its label to "Copied" so the otherwise
 *  silent clipboard write gives visible confirmation. */
function CopyButton({
  text,
  className,
  title,
}: {
  text: string;
  className: string;
  title: string;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      className={className}
      onClick={() => {
        copyToClipboard(text);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1200);
      }}
      title={title}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Copy text to the clipboard, ignoring environments without the API. */
function copyToClipboard(text: string): void {
  void navigator.clipboard?.writeText(text);
}

/** Flag the last assistant message so reloaded history shows it was cut off by
 *  an error mid-stream rather than a complete reply. */
function markLastAssistantInterrupted(messages: AgentMessage[]): AgentMessage[] {
  const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
  if (lastAssistant < 0) return messages;
  return messages.map((m, i) => (i === lastAssistant ? { ...m, interrupted: true } : m));
}

function messagesToItems(messages: AgentMessage[]): ViewItem[] {
  const items: ViewItem[] = [];
  const toolResults = new Map<string, { content: string; autoApproved?: boolean }>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId) {
      toolResults.set(m.toolCallId, { content: m.content, autoApproved: m.autoApproved });
    }
  }
  // A turn spans a user message and the assistant/tool messages that answer it.
  // Accumulate the turn's usage across rounds; when a turn took more than one
  // provider round, stamp the total onto its final reply so the cost of the
  // whole exchange is visible, not just the last round.
  let turnInput = 0;
  let turnOutput = 0;
  let turnRounds = 0;
  let lastTurnReply: MessageView | null = null;
  function closeTurn(): void {
    if (lastTurnReply && turnRounds > 1 && (turnInput || turnOutput)) {
      lastTurnReply.turnUsage = { inputTokens: turnInput, outputTokens: turnOutput };
    }
    turnInput = 0;
    turnOutput = 0;
    turnRounds = 0;
    lastTurnReply = null;
  }
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    if (m.role === "user") {
      closeTurn();
      items.push({ kind: "message", role: "user", content: m.content, images: m.images, historyIndex: mi });
    } else if (m.role === "assistant") {
      if (m.usage) {
        turnInput += m.usage.inputTokens ?? 0;
        turnOutput += m.usage.outputTokens ?? 0;
        turnRounds += 1;
      }
      if (m.content) {
        const reply: MessageView = {
          kind: "message",
          role: "assistant",
          content: m.content,
          interrupted: m.interrupted,
          usage: m.usage,
        };
        items.push(reply);
        lastTurnReply = reply;
      }
      for (const tc of m.toolCalls ?? []) {
        const tr = toolResults.get(tc.id);
        items.push({
          kind: "tool",
          callId: tc.id,
          name: tc.name,
          args: tc.arguments,
          status: "done",
          result: tr?.content,
          autoApproved: tr?.autoApproved,
        });
      }
    }
  }
  closeTurn();
  return items;
}

interface ChatPanelProps {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onOpenSettings: () => void;
}

export function ChatPanel({ busy, setBusy, onOpenSettings }: ChatPanelProps): React.ReactElement {
  const settings = useSettings();
  const sessions = useSessions();
  const models = modelsStore.use();
  const current = currentSession(sessions);
  const history = current?.messages ?? [];
  const usage = sessionTokenUsage(history);
  const cost = estimateCost(usage, settings.model, settings.modelRates);
  const tools = sessionToolUsage(history);
  const toolAudit = sessionToolAudit(history);
  const contextUsed = contextWindowTokens(history);
  const contextDetail = contextWindowUsage(history);

  const [pendingUser, setPendingUser] = useState<AgentMessage | null>(null);
  const [activity, setActivity] = useState<ViewItem[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState("");
  const [mcpToolCount, setMcpToolCount] = useState(0);
  const [mcpDownCount, setMcpDownCount] = useState(0);
  const [showToolAudit, setShowToolAudit] = useState(false);
  const [auditHideReadonly, setAuditHideReadonly] = useState(false);
  const [auditSortByRisk, setAuditSortByRisk] = useState(false);
  const dictation = useDictation((text) =>
    setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text)),
  );

  // The audit popover view: optionally drop readonly rows and order by risk
  // (destructive first) so a long tool history stays scannable. The sort copy
  // is stable, so calls of equal risk keep their execution order.
  const riskRank = (r: string) => (r === "destructive" ? 0 : r === "mutating" ? 1 : 2);
  const visibleToolAudit = (auditHideReadonly ? toolAudit.filter((e) => e.risk !== "readonly") : toolAudit.slice()).sort(
    (a, b) => (auditSortByRisk ? riskRank(a.risk) - riskRank(b.risk) : 0),
  );

  const turnIdRef = useRef<string | null>(null);
  const turnSessionRef = useRef<string | null>(null);
  const turnBaseRef = useRef<AgentMessage[]>([]);
  // The event feed is subscribed once, so its handler closes over first-render
  // state. Hold the pending user message in a ref (like the base) so the commit
  // paths read the current value instead of a stale null.
  const turnPendingUserRef = useRef<AgentMessage | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Depth counter so the drop overlay does not flicker as the drag crosses
  // nested children (each child fires its own dragenter/dragleave pair).
  const dragDepth = useRef(0);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [history, activity, pendingUser]);

  useEffect(() => {
    const off = window.moss.chat.onEvent((payload: ChatEventPayload) => {
      if (payload.turnId !== turnIdRef.current) return;
      handleEvent(payload);
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Surface how many tools the connected MCP servers contribute, mirroring the
  // settings panel count so it is visible without opening settings. Guarded so
  // renderers without the mcp bridge (some tests) simply show no badge.
  useEffect(() => {
    let cancelled = false;
    const pending = window.moss.mcp?.status();
    if (pending) {
      pending
        .then((servers) => {
          if (cancelled) return;
          setMcpToolCount(servers.filter((s) => s.connected).reduce((n, s) => n + s.toolCount, 0));
          setMcpDownCount(servers.filter((s) => s.enabled && !s.connected).length);
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  function handleEvent(payload: ChatEventPayload): void {
    const ev = payload.event;
    if (ev.type === "text-delta") {
      setActivity((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.kind === "message" && last.role === "assistant") {
          next[next.length - 1] = { ...last, content: last.content + ev.text };
        } else {
          next.push({ kind: "message", role: "assistant", content: ev.text });
        }
        return next;
      });
    } else if (ev.type === "tool-call") {
      setActivity((prev) => [
        ...prev,
        { kind: "tool", callId: ev.callId, name: ev.name, args: ev.arguments, status: "running" },
      ]);
    } else if (ev.type === "tool-approval-request") {
      setActivity((prev) =>
        prev.map((it) =>
          it.kind === "tool" && it.callId === ev.callId ? { ...it, status: "approval", risk: ev.risk } : it,
        ),
      );
    } else if (ev.type === "tool-result") {
      setActivity((prev) =>
        prev.map((it) =>
          it.kind === "tool" && it.callId === ev.callId
            ? { ...it, status: ev.ok ? "done" : "error", result: ev.content, autoApproved: ev.autoApproved }
            : it,
        ),
      );
    } else if (ev.type === "token-usage") {
      // Usage is persisted per-message via the runner's committed messages and
      // shown once the turn lands; nothing to accumulate live here.
    } else if (ev.type === "notice") {
      // Transient turn-progress note (e.g. a stream retry); shown on the status
      // line and cleared when the turn lands, like Aborted/Error.
      setStatus(ev.message);
    } else if (ev.type === "turn-complete" || ev.type === "turn-aborted" || ev.type === "turn-error") {
      const sessionId = turnSessionRef.current;
      if (sessionId) {
        const base = turnBaseRef.current;
        const user = turnPendingUserRef.current;
        const msgs =
          ev.type === "turn-error" ? markLastAssistantInterrupted(ev.messages) : ev.messages;
        const committed = user ? [...base, user, ...msgs] : [...base, ...msgs];
        setSessionMessages(sessionId, committed);
      }
      turnPendingUserRef.current = null;
      setPendingUser(null);
      setActivity([]);
      setBusy(false);
      turnIdRef.current = null;
      turnSessionRef.current = null;
      setStatus(
        ev.type === "turn-aborted"
          ? "Aborted"
          : ev.type === "turn-error"
            ? `Error: ${ev.message}`
            : "",
      );
    }
  }

  /** Launch a turn: wire the turn refs, mark busy, and stream the request.
   *  Shared by the composer (send), regenerate, and edit/resend so the commit
   *  path in handleEvent rebuilds the session from the same base + user message. */
  function runTurn(sessionId: string, base: AgentMessage[], userMsg: AgentMessage): void {
    const turnId = crypto.randomUUID();
    turnIdRef.current = turnId;
    turnSessionRef.current = sessionId;
    turnBaseRef.current = base;
    turnPendingUserRef.current = userMsg;
    setPendingUser(userMsg);
    setActivity([]);
    setBusy(true);
    setStatus("");
    window.moss.chat.send({
      turnId,
      config: toProviderConfig(settings),
      messages: [...base, userMsg],
      workspaceRoot: settings.workspaceRoot ?? undefined,
      enableTools: settings.enableTools,
      autoApproveTools: settings.autoApproveTools,
      customInstructions: settings.customInstructions,
      personalityId: getSessionPersonality(sessionId) ?? settings.personalityId,
      adaptiveTone: settings.adaptiveTone,
      stt: {
        baseUrl: (settings.sttBaseUrl || settings.baseUrl || "").trim(),
        apiKey: settings.apiKey || undefined,
        model: settings.sttModel || "whisper-1",
      },
    });
  }

  function send(textArg?: string): void {
    const text = (textArg ?? input).trim();
    if ((!text && attachments.length === 0) || busy || !settings.model) return;
    const sessionId = ensureCurrentSession();
    setSessionTitle(sessionId, text);
    const base = getSessionMessages(sessionId);
    const userMsg: AgentMessage = { role: "user", content: text };
    if (attachments.length > 0) userMsg.images = attachments;
    setInput("");
    setAttachments([]);
    runTurn(sessionId, base, userMsg);
  }

  /** Re-run the user turn at the given history index, dropping that turn's
   *  reply (and any tool messages) so the model answers the same prompt again. */
  function regenerateAt(userIndex: number): void {
    if (busy || !settings.model) return;
    const sessionId = current?.id;
    if (!sessionId) return;
    if (userIndex < 0 || history[userIndex]?.role !== "user") return;
    runTurn(sessionId, history.slice(0, userIndex), history[userIndex]);
  }

  /** Pull the user turn at the given history index back into the composer
   *  (text + images) and truncate history before it, so the user can edit the
   *  prompt and send it again. */
  function editUserAt(index: number): void {
    if (busy) return;
    const sessionId = current?.id;
    if (!sessionId) return;
    const userMsg = history[index];
    if (!userMsg || userMsg.role !== "user") return;
    setInput(userMsg.content);
    setAttachments(userMsg.images ?? []);
    setSessionMessages(sessionId, history.slice(0, index));
  }

  function abort(): void {
    if (turnIdRef.current) window.moss.chat.abort(turnIdRef.current);
  }

  /** Read picked files: images become data-URL attachments for vision models;
   *  text files (.txt/.md) are inlined into the message as a fenced block so
   *  their content reaches text-only models without any new dependency. */
  function addFiles(fileList: FileList | null): void {
    if (!fileList) return;
    for (const file of Array.from(fileList)) {
      const isImage = file.type.startsWith("image/");
      const lang = textLanguageForFile(file);
      if (isImage) {
        const error = imageAttachmentError(file);
        if (error) {
          setStatus(error);
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === "string") {
            setAttachments((prev) => [...prev, reader.result as string]);
          }
        };
        reader.readAsDataURL(file);
      } else if (lang !== null) {
        const error = textAttachmentError(file);
        if (error) {
          setStatus(error);
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === "string") {
            const block = `\`\`\`${lang}\n${reader.result}\n\`\`\``;
            setInput((prev) => (prev ? `${prev}\n\n${block}` : block));
          }
        };
        reader.readAsText(file);
      } else {
        setStatus(`${file.name}: unsupported file type`);
      }
    }
  }

  function approve(callId: string, approved: boolean): void {
    if (!turnIdRef.current) return;
    window.moss.tool.approve({ turnId: turnIdRef.current, callId, approved });
    setActivity((prev) =>
      prev.map((it) =>
        it.kind === "tool" && it.callId === callId
          ? { ...it, status: approved ? "running" : "denied" }
          : it,
      ),
    );
  }

  const items: ViewItem[] = [
    ...messagesToItems(history),
    ...(pendingUser ? [{ kind: "message", role: "user", content: pendingUser.content, images: pendingUser.images } as MessageView] : []),
    ...activity,
  ];

  const showWelcome = items.length === 0;

  return (
    <div className="flex h-screen flex-1 flex-col bg-transparent text-neutral-900 dark:text-neutral-100">
      <header className="flex flex-wrap items-center gap-2 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-950/60 px-4 py-2 text-sm backdrop-blur-sm">
        <span className="font-semibold tracking-tight text-neutral-800 dark:text-neutral-200">Moss</span>
        {models.length > 0 ? (
          <select
            className="w-56 rounded-md border border-neutral-300/60 dark:border-neutral-700/60 bg-neutral-200 dark:bg-neutral-800 px-2 py-1 transition focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            value={settings.model}
            onChange={(e) => updateSettings({ model: e.target.value })}
          >
            <option value="">Select model…</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <button
            className="rounded-md bg-neutral-300 dark:bg-neutral-700 px-2 py-1 transition hover:bg-neutral-400 dark:hover:bg-neutral-600"
            onClick={onOpenSettings}
          >
            Set up provider…
          </button>
        )}
        {settings.model ? <span className="text-xs text-neutral-500 dark:text-neutral-400">{settings.model}</span> : null}
        {current ? (
          <select
            className="w-40 rounded-md border border-neutral-300/60 dark:border-neutral-700/60 bg-neutral-200 dark:bg-neutral-800 px-2 py-1 transition focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            value={current.personalityId ?? ""}
            onChange={(e) => setSessionPersonality(current.id, e.target.value || undefined)}
            disabled={busy}
            title="Personality for this chat. Inherit uses the global default from Settings."
          >
            <option value="">
              Inherit ({PERSONALITY_PRESETS.find((p) => p.id === settings.personalityId)?.name ?? "Default"})
            </option>
            {PERSONALITY_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : null}
        {usage.inputTokens || usage.outputTokens ? (
          <span
            className="text-xs text-neutral-400 dark:text-neutral-600"
            title="Total token usage for this conversation (input / output), summed across messages."
          >
            {formatTokens(usage.inputTokens ?? 0)} in / {formatTokens(usage.outputTokens ?? 0)} out
          </span>
        ) : null}
        {cost !== null && (usage.inputTokens || usage.outputTokens) ? (
          <span
            className="text-xs text-neutral-400 dark:text-neutral-600"
            title={`Estimated cost for this conversation using built-in rates for ${settings.model}. Approximate; provider pricing may differ.`}
          >
            ~{formatUsd(cost)}
          </span>
        ) : null}
        {tools.total > 0 ? (
          <span className="relative">
            <button
              type="button"
              className={tools.autoApproved > 0 ? "text-xs text-amber-400/80 hover:underline" : "text-xs text-neutral-400 dark:text-neutral-600 hover:underline"}
              title={`${tools.total} tool call(s) ran in this conversation; ${tools.autoApproved} ran without asking because auto-approve was on. Click to review.`}
              aria-expanded={showToolAudit}
              onClick={() => setShowToolAudit((v) => !v)}
            >
              {tools.total} tool{tools.total === 1 ? "" : "s"}
              {tools.autoApproved > 0 ? ` (${tools.autoApproved} auto)` : ""}
            </button>
            {showToolAudit ? (
              <div className="absolute left-0 top-5 z-20 max-h-64 w-72 overflow-y-auto rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-2 shadow-lg">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Tool activity</p>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setAuditHideReadonly((v) => !v)}
                      aria-pressed={auditHideReadonly}
                      className={
                        auditHideReadonly
                          ? "rounded bg-neutral-300 dark:bg-neutral-700 px-1 text-[10px] uppercase text-neutral-800 dark:text-neutral-200"
                          : "rounded bg-neutral-200 dark:bg-neutral-800 px-1 text-[10px] uppercase text-neutral-600 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
                      }
                    >
                      Hide readonly
                    </button>
                    <button
                      type="button"
                      onClick={() => setAuditSortByRisk((v) => !v)}
                      aria-pressed={auditSortByRisk}
                      className={
                        auditSortByRisk
                          ? "rounded bg-neutral-300 dark:bg-neutral-700 px-1 text-[10px] uppercase text-neutral-800 dark:text-neutral-200"
                          : "rounded bg-neutral-200 dark:bg-neutral-800 px-1 text-[10px] uppercase text-neutral-600 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
                      }
                    >
                      By risk
                    </button>
                  </div>
                </div>
                <ul className="space-y-1">
                  {visibleToolAudit.map((e, i) => (
                    <li key={`${e.callId}-${i}`} className="flex items-center gap-2 text-xs">
                      <span className="flex-1 truncate font-mono text-neutral-800 dark:text-neutral-200">{e.name}</span>
                      <span
                        className={
                          e.risk === "destructive"
                            ? "rounded bg-red-900/60 px-1 text-[10px] uppercase text-red-300"
                            : e.risk === "mutating"
                              ? "rounded bg-amber-900/60 px-1 text-[10px] uppercase text-amber-300"
                              : "rounded bg-neutral-200 dark:bg-neutral-800 px-1 text-[10px] uppercase text-neutral-600 dark:text-neutral-400"
                        }
                      >
                        {e.risk}
                      </span>
                      {e.autoApproved ? (
                        <span className="rounded bg-amber-900/40 px-1 text-[10px] uppercase text-amber-300">auto</span>
                      ) : null}
                      {e.durationMs != null ? (
                        <span className="font-mono text-[10px] tabular-nums text-neutral-500 dark:text-neutral-400">{e.durationMs}ms</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </span>
        ) : null}
        {settings.contextLimit > 0 && contextUsed > 0 ? (
          <span
            className="inline-flex flex-col gap-0.5"
            title={`Approximate context-window usage: the latest reply used ${formatTokens(contextDetail.inputTokens ?? 0)} input + ${formatTokens(contextDetail.outputTokens ?? 0)} output tokens, against the limit you set in Settings.`}
          >
            <span
              className={
                contextUsed >= settings.contextLimit
                  ? "text-xs font-medium text-amber-600 dark:text-amber-400"
                  : "text-xs text-neutral-400 dark:text-neutral-600"
              }
            >
              ctx {formatTokens(contextUsed)}/{formatTokens(settings.contextLimit)}
            </span>
            <span className="h-1 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800" aria-hidden="true">
              <span
                className={`block h-full rounded-full ${
                  contextUsed >= settings.contextLimit ? "bg-amber-400" : "bg-emerald-500/60"
                }`}
                style={{ width: `${Math.min(100, Math.round((contextUsed / settings.contextLimit) * 100))}%` }}
              />
            </span>
          </span>
        ) : null}
        {settings.enableTools && mcpToolCount > 0 ? (
          <span
            className="rounded-full border border-sky-500/30 bg-sky-500/15 px-2 py-0.5 text-xs font-medium text-sky-300"
            title="Tools available from connected MCP servers."
          >
            {mcpToolCount} MCP {mcpToolCount === 1 ? "tool" : "tools"}
          </span>
        ) : null}
        {settings.enableTools && mcpDownCount > 0 ? (
          <span
            className="rounded-full border border-rose-500/30 bg-rose-500/15 px-2 py-0.5 text-xs font-medium text-rose-300"
            title="Configured MCP servers that are enabled but failed to connect. Retry them in Settings."
          >
            {mcpDownCount} MCP {mcpDownCount === 1 ? "server" : "servers"} down
          </span>
        ) : null}
        {settings.enableTools && settings.autoApproveTools ? (
          <span
            className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-300"
            title="Tools that write files or run commands run automatically without asking."
          >
            Auto-approving tools
          </span>
        ) : null}
        <span className="ml-auto truncate text-xs text-neutral-500 dark:text-neutral-400">
          {settings.workspaceRoot ?? "no workspace"}
        </span>
        {current && history.length > 0 ? (
          <button
            className="rounded-md bg-neutral-300 dark:bg-neutral-700 px-2 py-1 transition hover:bg-neutral-400 dark:hover:bg-neutral-600 disabled:opacity-50"
            onClick={() => clearSession(current.id)}
            disabled={busy}
            title="Clear this conversation: removes its messages but keeps it in the list."
          >
            Clear
          </button>
        ) : null}
        <button className="rounded-md bg-neutral-300 dark:bg-neutral-700 px-2 py-1 transition hover:bg-neutral-400 dark:hover:bg-neutral-600" onClick={onOpenSettings}>
          Settings
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {showWelcome ? (
          <WelcomeScreen onPick={(text) => send(text)} />
        ) : (
          items.map((it, i) =>
          it.kind === "message" ? (
            <div
              key={i}
              className={
                it.role === "user"
                  ? "group ml-auto max-w-2xl animate-fade-in whitespace-pre-wrap rounded-2xl border border-emerald-500/20 bg-emerald-600/15 px-4 py-2.5 shadow-sm"
                  : "group mr-auto max-w-2xl animate-fade-in whitespace-pre-wrap rounded-2xl border border-neutral-300/50 dark:border-neutral-700/50 bg-neutral-200/80 dark:bg-neutral-800/80 px-4 py-2.5 shadow-sm"
              }
            >
              {it.role === "assistant" ? renderContent(it.content) : it.content}
              {it.role === "user" && it.images && it.images.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {it.images.map((src, ii) => (
                    <img
                      key={ii}
                      src={src}
                      alt="attachment"
                      className="max-h-32 rounded-lg border border-emerald-500/20"
                    />
                  ))}
                </div>
              ) : null}
              {it.role === "assistant" && it.interrupted ? (
                <span className="ml-1 text-xs italic text-neutral-500 dark:text-neutral-400">(interrupted)</span>
              ) : null}
              {it.role === "user" && it.historyIndex !== undefined && !busy ? (
                <div className="mt-1 flex gap-2 text-[10px] text-emerald-200/50 opacity-0 transition group-hover:opacity-100">
                  <button
                    className="hover:text-emerald-100"
                    onClick={() => editUserAt(it.historyIndex!)}
                    title="Edit this message: pulls it into the composer and removes everything after it."
                  >
                    Edit
                  </button>
                  <button
                    className="hover:text-emerald-100"
                    onClick={() => regenerateAt(it.historyIndex!)}
                    title="Re-run this prompt to get a fresh reply, dropping everything after it."
                  >
                    Regenerate
                  </button>
                </div>
              ) : null}
              {it.role === "assistant" && it.usage && (it.usage.inputTokens || it.usage.outputTokens) ? (
                <span
                  className="ml-2 align-middle text-[10px] text-neutral-400 dark:text-neutral-600"
                  title="Token usage for this reply (input / output)."
                >
                  {formatTokens(it.usage.inputTokens ?? 0)}/{formatTokens(it.usage.outputTokens ?? 0)} tok
                </span>
              ) : null}
              {it.role === "assistant" && it.turnUsage ? (
                <span
                  className="ml-2 align-middle text-[10px] text-neutral-400 dark:text-neutral-600"
                  title="Total token usage for this exchange across all tool rounds (input / output)."
                >
                  turn {formatTokens(it.turnUsage.inputTokens ?? 0)}/{formatTokens(it.turnUsage.outputTokens ?? 0)} tok
                </span>
              ) : null}
              {it.role === "assistant" && it.content ? (
                <CopyButton
                  text={it.content}
                  className="ml-2 align-middle text-[10px] text-neutral-400 dark:text-neutral-600 opacity-0 transition hover:text-neutral-700 dark:hover:text-neutral-300 group-hover:opacity-100"
                  title="Copy this reply to the clipboard."
                />
              ) : null}
            </div>
          ) : (
            <div key={i} className="mr-auto max-w-2xl animate-fade-in rounded-2xl border border-neutral-300/60 dark:border-neutral-700/60 bg-white/80 dark:bg-neutral-900/80 px-4 py-2.5 text-sm shadow-sm">
              <div className="font-mono text-xs text-neutral-700 dark:text-neutral-300">
                <span className="text-emerald-700 dark:text-emerald-300">{it.name}</span>({it.args})
                {it.autoApproved ? (
                  <span
                    className="ml-2 rounded-full border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 font-sans text-[10px] font-medium text-amber-300"
                    title="Ran automatically without asking because auto-approve was on."
                  >
                    auto
                  </span>
                ) : null}
              </div>
              {it.status === "approval" ? (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-amber-300">Approval required.</span>
                  {it.risk === "destructive" ? (
                    <span
                      className="rounded-full border border-red-500/40 bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-300"
                      title="This command can delete data or change your system, so it always asks for approval even when auto-approve is on."
                    >
                      destructive
                    </span>
                  ) : it.risk === "mutating" ? (
                    <span
                      className="rounded-full border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
                      title="This command can change files or state, so it asks for approval unless auto-approve is on."
                    >
                      mutating
                    </span>
                  ) : null}
                  <button
                    className="rounded-md bg-emerald-600 px-2.5 py-0.5 font-medium text-white transition hover:bg-emerald-500"
                    onClick={() => approve(it.callId, true)}
                  >
                    Approve
                  </button>
                  <button
                    className="rounded-md bg-red-700 px-2.5 py-0.5 font-medium text-white transition hover:bg-red-600"
                    onClick={() => approve(it.callId, false)}
                  >
                    Deny
                  </button>
                </div>
              ) : (
                <div className="mt-1.5 text-xs">
                  <span className={toolStatusColor(it.status)}>{it.status}</span>
                  {it.result ? (
                    <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-50 dark:bg-neutral-950 p-2 text-neutral-700 dark:text-neutral-300">
                      {it.result}
                    </pre>
                  ) : null}
                </div>
              )}
            </div>
          ),
        ))}
      </div>

      <footer
        className="relative border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-950/60 px-4 py-3 backdrop-blur-sm"
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        {dragging ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-emerald-500/60 bg-neutral-50/80 dark:bg-neutral-950/80 text-sm text-emerald-300">
            Drop files to attach
          </div>
        ) : null}
        {status ? <div className="mb-2 text-xs text-neutral-600 dark:text-neutral-400">{status}</div> : null}
        {dictation.error ? <div className="mb-2 text-xs text-red-600 dark:text-red-400">{dictation.error}</div> : null}
        {attachments.length > 0 && settings.model && !isLikelyVisionModel(settings.model) ? (
          <div className="mb-2 text-xs text-amber-600 dark:text-amber-400">The selected model may not support images.</div>
        ) : null}
        {attachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((src, i) => (
              <div key={i} className="relative">
                <img
                  src={src}
                  alt="attachment"
                  className="h-14 w-14 rounded-lg border border-neutral-300/60 dark:border-neutral-700/60 object-cover"
                />
                <button
                  className="absolute -right-1 -top-1 rounded-full bg-white dark:bg-neutral-900 px-1 text-[10px] text-neutral-700 dark:text-neutral-300 hover:text-white"
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  title="Remove this attachment"
                >
                  x
                </button>
              </div>
            ))}
            <button
              className="self-center rounded-lg px-2 py-1 text-[10px] text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
              onClick={() => setAttachments([])}
              title="Remove all attachments"
            >
              Clear all
            </button>
          </div>
        ) : null}
        <div className="flex gap-2">
          <textarea
            className="flex-1 resize-none rounded-xl border border-neutral-300/60 dark:border-neutral-700/60 bg-neutral-200 dark:bg-neutral-800 px-3 py-2 transition focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            rows={2}
            placeholder="Message…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              if (e.clipboardData.files.length > 0) {
                e.preventDefault();
                addFiles(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.txt,.md,.json,.csv,.tsv,.log,.xml,.yml,.yaml,.toml,.ini,.html,.css,.ts,.tsx,.js,.jsx,.py,.sh,.sql,.rs,.go,.java,.c,.cpp,.rb"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            className="rounded-xl bg-neutral-300 dark:bg-neutral-700 px-3 py-2 transition hover:bg-neutral-400 dark:hover:bg-neutral-600"
            onClick={() => fileInputRef.current?.click()}
            title="Attach an image or text file"
          >
            Attach{attachments.length > 0 ? ` (${attachments.length})` : ""}
          </button>
          <button
            className={`rounded-xl px-3 py-2 transition disabled:opacity-50 ${
              dictation.state === "recording"
                ? "bg-red-700 hover:bg-red-600"
                : "bg-neutral-300 dark:bg-neutral-700 hover:bg-neutral-400 dark:hover:bg-neutral-600"
            }`}
            onClick={dictation.toggle}
            disabled={dictation.state === "transcribing"}
            title="Dictate with Whisper"
          >
            {dictation.state === "recording"
              ? "Recording"
              : dictation.state === "transcribing"
                ? "…"
                : "Mic"}
          </button>
          {busy ? (
            <button className="rounded-xl bg-red-700 px-4 py-2 font-medium text-white transition hover:bg-red-600" onClick={abort}>
              Stop
            </button>
          ) : (
            <button
              className="rounded-xl bg-emerald-600 px-4 py-2 font-medium text-white shadow transition hover:bg-emerald-500 disabled:opacity-50"
              onClick={() => send()}
              disabled={!settings.model}
            >
              Send
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

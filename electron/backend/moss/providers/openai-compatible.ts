// electron/backend/moss/providers/openai-compatible.ts
//
// Covers Ollama (via its /v1 endpoint), OpenAI, LM Studio, vLLM, Groq,
// OpenRouter, and any other server exposing /chat/completions + /models.
// Supports streaming text and OpenAI-style function/tool calls.

import { randomUUID } from "node:crypto";

import type { AgentMessage } from "../../../../common/types";
import { joinUrl, safeText } from "./http";
import { readSSE } from "./sse";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "./types";

interface OAToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OAStreamChunk {
  choices?: Array<{
    delta?: { content?: string; tool_calls?: OAToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OpenAiModelList {
  data?: Array<{ id?: string }>;
}

export function toOpenAiMessages(messages: AgentMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === "user" && m.images && m.images.length > 0) {
      const parts: unknown[] = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const url of m.images) parts.push({ type: "image_url", image_url: { url } });
      return { role: "user", content: parts };
    }
    return { role: m.role, content: m.content };
  });
}

export class OpenAiCompatibleProvider implements ChatProvider {
  readonly kind = "openai-compatible";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  async *streamChat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    const tools =
      req.tools && req.tools.length > 0
        ? req.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          }))
        : undefined;

    const res = await fetch(joinUrl(this.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: req.model,
        messages: toOpenAiMessages(req.messages),
        stream: true,
        ...(tools ? { tools } : {}),
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`OpenAI-compatible request failed: HTTP ${res.status} ${await safeText(res)}`);
    }

    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let flushed = false;
    const flush = (): ProviderStreamEvent[] => {
      if (flushed) return [];
      flushed = true;
      const events: ProviderStreamEvent[] = [];
      for (const tc of toolAcc.values()) {
        if (tc.name) {
          events.push({
            type: "tool-call",
            toolCall: { id: tc.id || randomUUID(), name: tc.name, arguments: tc.args || "{}" },
          });
        }
      }
      return events;
    };

    for await (const data of readSSE(res.body, signal)) {
      if (data === "[DONE]") {
        yield* flush();
        return;
      }
      let json: OAStreamChunk;
      try {
        json = JSON.parse(data) as OAStreamChunk;
      } catch {
        continue;
      }
      const choice = json.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content) yield { type: "text-delta", text: delta.content };
      if (delta?.tool_calls) {
        for (const d of delta.tool_calls) {
          const idx = d.index ?? 0;
          const cur = toolAcc.get(idx) ?? { id: "", name: "", args: "" };
          if (d.id) cur.id = d.id;
          if (d.function?.name) cur.name = d.function.name;
          if (d.function?.arguments) cur.args += d.function.arguments;
          toolAcc.set(idx, cur);
        }
      }
      if (json.usage) {
        yield {
          type: "usage",
          usage: { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens },
        };
      }
      if (choice?.finish_reason === "tool_calls") yield* flush();
    }
    yield* flush();
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(joinUrl(this.baseUrl, "/models"), {
      headers: { ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
    });
    if (!res.ok) throw new Error(`List models failed: HTTP ${res.status} ${await safeText(res)}`);
    const json = (await res.json()) as OpenAiModelList;
    return (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
  }
}

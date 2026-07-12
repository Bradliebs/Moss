// electron/backend/moss/providers/anthropic.ts
//
// Native Anthropic Messages API client with streaming text and tool use.

import { randomUUID } from "node:crypto";

import type { AgentMessage } from "../../../../common/types";
import { joinUrl, safeText } from "./http";
import { readSSE } from "./sse";
import { ProviderError } from "./types";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "./types";

const DEFAULT_ANTHROPIC_MODELS = [
  "claude-sonnet-4-20250514",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
];

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  source?: { type: "base64"; media_type: string; data: string };
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string };
  usage?: { output_tokens?: number };
  error?: { message?: string };
}

interface AnthropicModelList {
  data?: Array<{ id?: string }>;
}

/** Split a data URL (data:<mime>;base64,<payload>) into the media type and raw
 *  base64 payload Anthropic's image block expects, or null if it is not one. */
function parseDataUrl(url: string): { media_type: string; data: string } | null {
  const m = /^data:([^;]+);base64,(.*)$/.exec(url);
  if (!m) return null;
  return { media_type: m[1], data: m[2] };
}

export function toAnthropic(messages: AgentMessage[]): { system?: string; messages: AnthropicMessage[] } {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const out: AnthropicMessage[] = [];

  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "user") {
      if ((m.images?.length ?? 0) > 0 || (m.documents?.length ?? 0) > 0) {
        const blocks: AnthropicBlock[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const document of m.documents ?? []) {
          blocks.push({
            type: "text",
            text: `--- BEGIN ATTACHED FILE: ${document.name} (${document.mediaType}) ---\n${document.text}\n--- END ATTACHED FILE: ${document.name} ---`,
          });
        }
        for (const url of m.images ?? []) {
          const parsed = parseDataUrl(url);
          if (parsed) {
            blocks.push({ type: "image", source: { type: "base64", media_type: parsed.media_type, data: parsed.data } });
          }
        }
        out.push({ role: "user", content: blocks });
      } else {
        out.push({ role: "user", content: m.content });
      }
    } else if (m.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        let input: Record<string, unknown> = {};
        try {
          input = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {};
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
      }
      out.push({ role: "assistant", content: blocks.length > 0 ? blocks : m.content });
    } else if (m.role === "tool") {
      const block: AnthropicBlock = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }

  return { system: system || undefined, messages: out };
}

export class AnthropicProvider implements ChatProvider {
  readonly kind = "anthropic";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  async *streamChat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    const { system, messages } = toAnthropic(req.messages);
    const tools =
      req.tools && req.tools.length > 0
        ? req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
        : undefined;

    const res = await fetch(joinUrl(this.baseUrl, "/v1/messages"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? 4096,
        system,
        messages,
        stream: true,
        ...(tools ? { tools } : {}),
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new ProviderError(`Anthropic request failed: HTTP ${res.status} ${await safeText(res)}`, res.status);
    }

    const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();

    for await (const data of readSSE(res.body, signal)) {
      let json: AnthropicStreamEvent;
      try {
        json = JSON.parse(data) as AnthropicStreamEvent;
      } catch {
        continue;
      }
      switch (json.type) {
        case "content_block_start":
          blocks.set(json.index ?? 0, {
            type: json.content_block?.type ?? "",
            id: json.content_block?.id,
            name: json.content_block?.name,
            json: "",
          });
          break;
        case "content_block_delta":
          if (json.delta?.type === "text_delta" && json.delta.text) {
            yield { type: "text-delta", text: json.delta.text };
          } else if (json.delta?.type === "input_json_delta" && typeof json.delta.partial_json === "string") {
            const b = blocks.get(json.index ?? 0);
            if (b) b.json += json.delta.partial_json;
          }
          break;
        case "content_block_stop": {
          const b = blocks.get(json.index ?? 0);
          if (b && b.type === "tool_use") {
            yield {
              type: "tool-call",
              toolCall: { id: b.id || randomUUID(), name: b.name ?? "", arguments: b.json || "{}" },
            };
          }
          break;
        }
        case "message_delta":
          if (json.usage) yield { type: "usage", usage: { outputTokens: json.usage.output_tokens } };
          break;
        case "error":
          throw new Error(json.error?.message ?? "Anthropic stream error");
      }
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(joinUrl(this.baseUrl, "/v1/models"), {
        headers: {
          "anthropic-version": "2023-06-01",
          ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
        },
      });
      if (res.ok) {
        const json = (await res.json()) as AnthropicModelList;
        const ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
        if (ids.length > 0) return ids;
      }
    } catch {
      /* fall through to static list */
    }
    return DEFAULT_ANTHROPIC_MODELS;
  }
}

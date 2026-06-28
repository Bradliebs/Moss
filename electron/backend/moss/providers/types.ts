// electron/backend/moss/providers/types.ts

import type { AgentMessage, ToolDefinition } from "../../../../common/types";

export interface ChatRequest {
  model: string;
  messages: AgentMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
}

/** Low-level provider stream events. The agent runner accumulates these into the
 *  renderer-facing `MossEvent` stream and the tool-execution loop. */
export type ProviderStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolCall: { id: string; name: string; arguments: string } }
  | { type: "usage"; usage: { inputTokens?: number; outputTokens?: number } };

export interface ChatProvider {
  readonly kind: string;
  streamChat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent>;
  listModels(): Promise<string[]>;
}

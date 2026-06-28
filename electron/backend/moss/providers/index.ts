// electron/backend/moss/providers/index.ts

import type { ProviderConfig } from "../../../../common/types";
import { AnthropicProvider } from "./anthropic";
import { OpenAiCompatibleProvider } from "./openai-compatible";
import type { ChatProvider } from "./types";

export function createProvider(config: ProviderConfig): ChatProvider {
  switch (config.kind) {
    case "anthropic":
      return new AnthropicProvider(config.baseUrl || "https://api.anthropic.com", config.apiKey);
    case "openai-compatible":
      return new OpenAiCompatibleProvider(config.baseUrl, config.apiKey);
    default: {
      const exhaustive: never = config.kind;
      throw new Error(`Unknown provider kind: ${String(exhaustive)}`);
    }
  }
}

export type { ChatProvider } from "./types";

// electron/backend/moss/providers/index.test.ts
//
// Unit tests for the provider factory: dispatch by kind, the Anthropic base-URL
// default, and the exhaustive guard for unknown kinds.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderConfig } from "../../../../common/types";
import { AnthropicProvider } from "./anthropic";
import { OpenAiCompatibleProvider } from "./openai-compatible";
import { createProvider } from "./index";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createProvider", () => {
  it("builds an Anthropic provider for kind 'anthropic'", () => {
    const provider = createProvider({
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude",
    });
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it("builds an OpenAI-compatible provider for kind 'openai-compatible'", () => {
    const provider = createProvider({
      kind: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt",
    });
    expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
  });

  it("defaults the Anthropic base URL when none is configured", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "m" }] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createProvider({ kind: "anthropic", baseUrl: "", model: "claude" });
    await provider.listModels();
    expect(fetchMock.mock.calls[0][0]).toContain("https://api.anthropic.com");
  });

  it("throws on an unknown provider kind", () => {
    const bogus = { kind: "bogus", baseUrl: "", model: "" } as unknown as ProviderConfig;
    expect(() => createProvider(bogus)).toThrow(/Unknown provider kind/);
  });
});

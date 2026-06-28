// src/lib/settings.test.ts
//
// Unit tests for settings derivation. toProviderConfig is pure; applyPreset and
// updateSettings mutate the exported singletons, which are reset to a known
// baseline before each test. localStorage is absent in node, so the stores run
// purely in memory (their access is try/catch-guarded).

import { beforeEach, describe, expect, it } from "vitest";

import {
  applyPreset,
  modelsStore,
  PROVIDER_PRESETS,
  setModelRate,
  settingsStore,
  toProviderConfig,
  updateSettings,
  type MossSettings,
} from "./settings";

const baseline: MossSettings = {
  presetIndex: 0,
  kind: "openai-compatible",
  baseUrl: "http://localhost:11434/v1",
  apiKey: "",
  model: "",
  enableTools: true,
  workspaceRoot: null,
  sttBaseUrl: "",
  sttModel: "whisper-1",
};

beforeEach(() => {
  settingsStore.set({ ...baseline });
  modelsStore.set([]);
});

describe("toProviderConfig", () => {
  it("omits the apiKey when it is empty", () => {
    expect(toProviderConfig({ ...baseline, apiKey: "" }).apiKey).toBeUndefined();
  });

  it("includes the apiKey when it is set", () => {
    expect(toProviderConfig({ ...baseline, apiKey: "sk-1" }).apiKey).toBe("sk-1");
  });

  it("carries kind, baseUrl, and model", () => {
    const cfg = toProviderConfig({ ...baseline, kind: "anthropic", baseUrl: "https://x", model: "m" });
    expect(cfg).toMatchObject({ kind: "anthropic", baseUrl: "https://x", model: "m" });
  });
});

describe("applyPreset", () => {
  it("applies the Anthropic preset and clears the cached model list", () => {
    modelsStore.set(["old-model"]);
    const idx = PROVIDER_PRESETS.findIndex((p) => p.label === "Anthropic");
    applyPreset(idx);
    const s = settingsStore.get();
    expect(s.presetIndex).toBe(idx);
    expect(s.kind).toBe("anthropic");
    expect(s.baseUrl).toBe("https://api.anthropic.com");
    expect(modelsStore.get()).toEqual([]);
  });

  it("ignores an out-of-range index", () => {
    const before = settingsStore.get();
    applyPreset(999);
    expect(settingsStore.get()).toEqual(before);
  });
});

describe("updateSettings", () => {
  it("merges a partial patch and leaves other fields intact", () => {
    updateSettings({ model: "llama3", enableTools: false });
    const s = settingsStore.get();
    expect(s.model).toBe("llama3");
    expect(s.enableTools).toBe(false);
    expect(s.baseUrl).toBe(baseline.baseUrl);
  });
});

describe("setModelRate", () => {
  it("stores a rate under a normalized lowercased model key", () => {
    setModelRate("GPT-4o", { inputPer1M: 1, outputPer1M: 2 });
    expect(settingsStore.get().modelRates).toEqual({ "gpt-4o": { inputPer1M: 1, outputPer1M: 2 } });
  });

  it("removes the override when both rates are zero", () => {
    setModelRate("gpt-4o", { inputPer1M: 1, outputPer1M: 2 });
    setModelRate("gpt-4o", { inputPer1M: 0, outputPer1M: 0 });
    expect(settingsStore.get().modelRates).toEqual({});
  });

  it("removes the override when passed null and ignores an empty model", () => {
    setModelRate("gpt-4o", { inputPer1M: 1, outputPer1M: 2 });
    setModelRate("gpt-4o", null);
    expect(settingsStore.get().modelRates).toEqual({});
    setModelRate("  ", { inputPer1M: 5, outputPer1M: 5 });
    expect(settingsStore.get().modelRates).toEqual({});
  });
});

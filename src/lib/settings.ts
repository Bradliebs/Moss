// src/lib/settings.ts
//
// Durable user settings: the active provider connection, the model, the tools
// master switch, the UI theme, and the tool workspace root. Persisted to
// localStorage so the app reopens with the same provider/model selected.

import type { ProviderConfig, ProviderKind } from "@common/types";

import { createPersistentStore } from "./persistentStore";

export interface ProviderPreset {
  label: string;
  kind: ProviderKind;
  baseUrl: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { label: "Ollama", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1" },
  { label: "OpenAI", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1" },
  { label: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com" },
  { label: "Custom", kind: "openai-compatible", baseUrl: "" },
];

export interface MossSettings {
  /** index into PROVIDER_PRESETS; the matching preset seeds kind + baseUrl */
  presetIndex: number;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  enableTools: boolean;
  /** when true, tools that mutate files or run commands run without prompting */
  autoApproveTools: boolean;
  /** user-authored persona/instructions appended to the system prompt; the
   *  built-in safety section is always kept regardless of this value */
  customInstructions: string;
  workspaceRoot: string | null;
  /** speech-to-text endpoint base URL (empty = reuse the provider baseUrl) */
  sttBaseUrl: string;
  /** transcription model name for the /audio/transcriptions endpoint */
  sttModel: string;
  /** optional context-window size for the chosen model; 0 hides the meter.
   *  User-supplied so it never drifts against a bundled per-model table. */
  contextLimit: number;
}

const DEFAULT_SETTINGS: MossSettings = {
  presetIndex: 0,
  kind: PROVIDER_PRESETS[0].kind,
  baseUrl: PROVIDER_PRESETS[0].baseUrl,
  apiKey: "",
  model: "",
  enableTools: true,
  autoApproveTools: false,
  customInstructions: "",
  workspaceRoot: null,
  sttBaseUrl: "",
  sttModel: "whisper-1",
  contextLimit: 0,
};

export const settingsStore = createPersistentStore<MossSettings>("moss.settings", DEFAULT_SETTINGS);

/** Last-fetched model ids, kept so the header model dropdown is populated on
 *  reload without re-querying the provider. */
export const modelsStore = createPersistentStore<string[]>("moss.models", []);

/** Last add-server form type (stdio/http), so the MCP form reopens on the kind
 *  the user added most recently instead of always defaulting to stdio. */
export const mcpAddFormTypeStore = createPersistentStore<"stdio" | "http">(
  "moss.mcpAddFormType",
  "stdio",
);

export function useSettings(): MossSettings {
  return settingsStore.use();
}

export function updateSettings(patch: Partial<MossSettings>): void {
  settingsStore.update((prev) => ({ ...prev, ...patch }));
}

/** Apply a preset, resetting the cached model list since models are provider-specific. */
export function applyPreset(index: number): void {
  const preset = PROVIDER_PRESETS[index];
  if (!preset) return;
  updateSettings({ presetIndex: index, kind: preset.kind, baseUrl: preset.baseUrl });
  modelsStore.set([]);
}

export function toProviderConfig(s: MossSettings): ProviderConfig {
  return { kind: s.kind, baseUrl: s.baseUrl, apiKey: s.apiKey || undefined, model: s.model };
}

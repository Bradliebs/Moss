// common/personalities.ts
//
// Selectable personality presets. Shared by the renderer (the picker UI and the
// stored default) and the main process (which injects the active preset's prompt
// into the system message). Keeping the list here gives both sides a single
// source of truth, so the picker and the injected prompt can never drift apart.

export interface PersonalityPreset {
  id: string;
  name: string;
  description: string;
  /** Injected verbatim into the system prompt when this preset is active. Empty
   *  for the default preset, which keeps Moss's neutral baseline voice. */
  systemPrompt: string;
}

export const DEFAULT_PERSONALITY_ID = "default";

export const PERSONALITY_PRESETS: PersonalityPreset[] = [
  {
    id: "default",
    name: "Default",
    description: "Moss's neutral, balanced voice.",
    systemPrompt: "",
  },
  {
    id: "concise",
    name: "Concise",
    description: "Terse and direct, no filler.",
    systemPrompt:
      "Personality: be terse and direct. Lead with the answer, drop pleasantries and hedging, and keep explanations to the minimum that is still clear.",
  },
  {
    id: "mentor",
    name: "Mentor",
    description: "Patient and explanatory; teaches the why.",
    systemPrompt:
      "Personality: act as a patient mentor. Explain the reasoning behind your answers, point out tradeoffs, and encourage good practice without being condescending.",
  },
  {
    id: "dry-wit",
    name: "Dry wit",
    description: "Deadpan and lightly humorous, still precise.",
    systemPrompt:
      "Personality: keep a dry, deadpan wit. A light, understated aside is welcome, but never at the expense of accuracy or brevity, and never force it.",
  },
  {
    id: "cheerful",
    name: "Cheerful",
    description: "Warm, upbeat, and encouraging.",
    systemPrompt:
      "Personality: be warm, upbeat, and encouraging. Stay genuinely positive and supportive while remaining accurate and to the point.",
  },
];

const PRESET_BY_ID = new Map(PERSONALITY_PRESETS.map((p) => [p.id, p]));

/** The trusted system-prompt text for an allow-listed personality id. An unknown
 *  or missing id (and the default preset) yields an empty string, so a tampered
 *  id can never inject arbitrary text -- only a known preset's curated prompt is
 *  ever used. */
export function getPersonalityPrompt(id?: string): string {
  if (!id) return "";
  return PRESET_BY_ID.get(id)?.systemPrompt ?? "";
}

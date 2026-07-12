// src/components/WelcomeScreen.tsx
//
// Shown when the current conversation is empty. Offers a few starter prompts;
// picking one submits it as the first message of the turn. When no model is
// configured yet (e.g. first run on a fresh machine), the starter prompts would
// silently do nothing, so a setup call-to-action is shown instead.

import { MossFace } from "./MossFace";

const SUGGESTIONS = [
  "Summarize the files in my workspace.",
  "Explain what this project does.",
  "Find and fix a bug in the current folder.",
  "Write a unit test for a function I point you to.",
];

interface WelcomeScreenProps {
  onPick: (text: string) => void;
  /** true when no model is selected; the starter prompts cannot run yet */
  needsSetup?: boolean;
  onOpenSettings?: () => void;
}

export function WelcomeScreen({ onPick, needsSetup, onOpenSettings }: WelcomeScreenProps): React.ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 px-4 text-center animate-fade-in">
      <div className="flex flex-col items-center gap-3">
        <MossFace
          className="h-24 w-24 shadow-[0_10px_36px_rgba(16,185,129,0.2)] ring-4 ring-white/70 dark:ring-neutral-900/70"
          label="Moss portrait"
        />
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">Moss</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {needsSetup
            ? "Connect a model provider to start chatting."
            : "Pick a starting point, or just type a message below."}
        </p>
      </div>
      {needsSetup ? (
        <div className="flex w-full max-w-xl flex-col items-center gap-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-6 py-5">
          <p className="text-sm text-neutral-700 dark:text-neutral-300">
            Moss needs a model provider before it can respond. Run Ollama locally, or add an
            OpenAI-compatible or Anthropic API key in Settings, then pick a model.
          </p>
          <button
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-500"
            onClick={() => onOpenSettings?.()}
          >
            Open Settings
          </button>
        </div>
      ) : (
        <div className="grid w-full max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white/70 dark:bg-neutral-900/70 px-4 py-3 text-left text-sm text-neutral-700 dark:text-neutral-300 shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-500/40 hover:bg-neutral-200 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-neutral-100"
              onClick={() => onPick(s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

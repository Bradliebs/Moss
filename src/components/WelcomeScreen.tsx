// src/components/WelcomeScreen.tsx
//
// Shown when the current conversation is empty. Offers a few starter prompts;
// picking one submits it as the first message of the turn.

const SUGGESTIONS = [
  "Summarize the files in my workspace.",
  "Explain what this project does.",
  "Find and fix a bug in the current folder.",
  "Write a unit test for a function I point you to.",
];

export function WelcomeScreen({ onPick }: { onPick: (text: string) => void }): React.ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 px-4 text-center animate-fade-in">
      <div className="flex flex-col items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/15 text-xl font-bold text-emerald-300 shadow-[0_0_30px_rgba(16,185,129,0.25)] ring-1 ring-emerald-500/30">
          M
        </span>
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">Moss</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">Pick a starting point, or just type a message below.</p>
      </div>
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
    </div>
  );
}

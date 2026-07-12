// src/components/Sidebar.tsx
//
// Left navigation: conversation list, new-chat action, and entry points to the
// Settings and Library overlays. Session switching is locked while a turn is in
// flight so transient turn state never lands in the wrong conversation.

import { useState } from "react";

import {
  createSession,
  deleteSession,
  renameSession,
  selectSession,
  sessionToMarkdown,
  useSessions,
  type Session,
} from "../lib/sessions";
import { useSettings } from "../lib/settings";

interface SidebarProps {
  busy: boolean;
  onOpenSettings: () => void;
  onOpenLibrary: () => void;
}

// Trigger a client-side file download for a text payload. Guards on
// createObjectURL so non-browser environments (tests) are a no-op instead of a
// throw; the Markdown serializer is unit-tested independently.
function downloadTextFile(name: string, text: string): void {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function fileNameFor(session: Session): string {
  const slug = session.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug || "conversation"}.md`;
}

// Copy text to the clipboard, guarding on the async clipboard API so non-browser
// environments (tests) are a no-op instead of a throw.
function copyToClipboard(text: string): void {
  if (typeof navigator === "undefined" || !navigator.clipboard) return;
  void navigator.clipboard.writeText(text);
}

export function Sidebar({ busy, onOpenSettings, onOpenLibrary }: SidebarProps): React.ReactElement {
  const { sessions, currentId } = useSessions();
  const settings = useSettings();
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const exportOptions = { includeTools: true, model: settings.model, modelRates: settings.modelRates };

  const filter = query.trim().toLowerCase();
  const visible = filter ? sessions.filter((s) => s.title.toLowerCase().includes(filter)) : sessions;

  function beginRename(s: Session): void {
    setEditingId(s.id);
    setDraft(s.title);
  }

  function commitRename(): void {
    if (editingId) renameSession(editingId, draft);
    setEditingId(null);
    setDraft("");
  }

  function cancelRename(): void {
    setEditingId(null);
    setDraft("");
  }

  return (
    <aside className="hidden h-screen w-60 shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-800 bg-white/70 dark:bg-neutral-900/70 backdrop-blur-sm md:flex">
      <div className="flex items-center gap-2 px-3 py-3">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.7)]" />
        <span className="text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">Moss</span>
      </div>
      <div className="border-b border-neutral-200 dark:border-neutral-800 p-2">
        <button
          className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow transition hover:bg-emerald-500 disabled:opacity-50"
          onClick={() => createSession()}
          disabled={busy}
        >
          + New chat
        </button>
        {sessions.length > 0 ? (
          <input
            className="mt-2 w-full rounded-md border border-neutral-300/60 dark:border-neutral-700/60 bg-neutral-200 dark:bg-neutral-800 px-2 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-500 dark:placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
          />
        ) : null}
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto p-2">
        {sessions.length === 0 ? (
          <p className="px-2 py-4 text-xs text-neutral-500 dark:text-neutral-400">No conversations yet.</p>
        ) : visible.length === 0 ? (
          <p className="px-2 py-4 text-xs text-neutral-500 dark:text-neutral-400">No matching conversations.</p>
        ) : (
          <ul className="space-y-1">
            {visible.map((s) => (
              <li
                key={s.id}
                className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition ${
                  s.id === currentId
                    ? "border-l-2 border-emerald-500 bg-neutral-200 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                    : "border-l-2 border-transparent text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200/60 dark:hover:bg-neutral-800/60"
                }`}
              >
                {editingId === s.id ? (
                  <input
                    className="min-w-0 flex-1 rounded border border-neutral-400 dark:border-neutral-600 bg-white dark:bg-neutral-900 px-1 py-0.5 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") cancelRename();
                    }}
                    aria-label="Rename conversation"
                  />
                ) : (
                  <>
                    <button
                      className="min-w-0 flex-1 truncate text-left disabled:cursor-not-allowed"
                      onClick={() => selectSession(s.id)}
                      onDoubleClick={() => beginRename(s)}
                      disabled={busy}
                      title={s.title}
                    >
                      {s.title}
                    </button>
                    <button
                      className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400 opacity-0 hover:text-emerald-400 group-hover:opacity-100 disabled:opacity-0"
                      onClick={() => beginRename(s)}
                      disabled={busy}
                      title="Rename conversation"
                    >
                      Rename
                    </button>
                    <button
                      className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400 opacity-0 hover:text-emerald-400 group-hover:opacity-100 disabled:opacity-0"
                      onClick={() => downloadTextFile(fileNameFor(s), sessionToMarkdown(s, exportOptions))}
                      title="Export conversation as Markdown"
                    >
                      Export
                    </button>
                    <button
                      className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400 opacity-0 hover:text-emerald-400 group-hover:opacity-100 disabled:opacity-0"
                      onClick={() => copyToClipboard(sessionToMarkdown(s, exportOptions))}
                      title="Copy conversation as Markdown"
                    >
                      Copy
                    </button>
                    <button
                      className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400 opacity-0 hover:text-red-400 group-hover:opacity-100 disabled:opacity-0"
                      onClick={() => deleteSession(s.id)}
                      disabled={busy}
                      title="Delete conversation"
                    >
                      Delete
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </nav>

      <div className="space-y-1 border-t border-neutral-200 dark:border-neutral-800 p-2">
        <button
          className="w-full rounded-md px-3 py-1.5 text-left text-sm text-neutral-700 dark:text-neutral-300 transition hover:bg-neutral-200 dark:hover:bg-neutral-800"
          onClick={onOpenLibrary}
        >
          Library
        </button>
        <button
          className="w-full rounded-md px-3 py-1.5 text-left text-sm text-neutral-700 dark:text-neutral-300 transition hover:bg-neutral-200 dark:hover:bg-neutral-800"
          onClick={onOpenSettings}
        >
          Settings
        </button>
      </div>
    </aside>
  );
}

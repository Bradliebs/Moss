// src/components/Sidebar.tsx
//
// Left navigation: conversation list, new-chat action, and entry points to the
// Settings and Library overlays. Session switching is locked while a turn is in
// flight so transient turn state never lands in the wrong conversation.

import {
  createSession,
  deleteSession,
  selectSession,
  useSessions,
} from "../lib/sessions";

interface SidebarProps {
  busy: boolean;
  onOpenSettings: () => void;
  onOpenLibrary: () => void;
}

export function Sidebar({ busy, onOpenSettings, onOpenLibrary }: SidebarProps): React.ReactElement {
  const { sessions, currentId } = useSessions();

  return (
    <aside className="flex h-screen w-60 flex-col border-r border-neutral-800 bg-neutral-900/70 backdrop-blur-sm">
      <div className="flex items-center gap-2 px-3 py-3">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.7)]" />
        <span className="text-sm font-semibold tracking-tight text-neutral-100">Moss</span>
      </div>
      <div className="border-b border-neutral-800 p-2">
        <button
          className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow transition hover:bg-emerald-500 disabled:opacity-50"
          onClick={() => createSession()}
          disabled={busy}
        >
          + New chat
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto p-2">
        {sessions.length === 0 ? (
          <p className="px-2 py-4 text-xs text-neutral-500">No conversations yet.</p>
        ) : (
          <ul className="space-y-1">
            {sessions.map((s) => (
              <li
                key={s.id}
                className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition ${
                  s.id === currentId
                    ? "border-l-2 border-emerald-500 bg-neutral-800 text-neutral-100"
                    : "border-l-2 border-transparent text-neutral-300 hover:bg-neutral-800/60"
                }`}
              >
                <button
                  className="min-w-0 flex-1 truncate text-left disabled:cursor-not-allowed"
                  onClick={() => selectSession(s.id)}
                  disabled={busy}
                  title={s.title}
                >
                  {s.title}
                </button>
                <button
                  className="shrink-0 text-xs text-neutral-500 opacity-0 hover:text-red-400 group-hover:opacity-100 disabled:opacity-0"
                  onClick={() => deleteSession(s.id)}
                  disabled={busy}
                  title="Delete conversation"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>

      <div className="space-y-1 border-t border-neutral-800 p-2">
        <button
          className="w-full rounded-md px-3 py-1.5 text-left text-sm text-neutral-300 transition hover:bg-neutral-800"
          onClick={onOpenLibrary}
        >
          Library
        </button>
        <button
          className="w-full rounded-md px-3 py-1.5 text-left text-sm text-neutral-300 transition hover:bg-neutral-800"
          onClick={onOpenSettings}
        >
          Settings
        </button>
      </div>
    </aside>
  );
}

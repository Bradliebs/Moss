// src/App.tsx

import { useEffect, useState } from "react";

import { ChatPanel } from "./components/ChatPanel";
import { LibraryPanel } from "./components/LibraryPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { Sidebar } from "./components/Sidebar";
import { settingsStore } from "./lib/settings";

type Overlay = "none" | "settings" | "library";

export default function App(): React.JSX.Element {
  const [overlay, setOverlay] = useState<Overlay>("none");
  const [busy, setBusy] = useState(false);
  const theme = settingsStore.use().theme;

  useEffect(() => {
    const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const apply = (): void => {
      const dark = theme === "dark" || (theme === "auto" && !!mq?.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    if (theme !== "auto" || !mq) return;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  return (
    <div className="flex h-screen bg-transparent text-neutral-900 dark:text-neutral-100">
      <Sidebar
        busy={busy}
        onOpenSettings={() => setOverlay("settings")}
        onOpenLibrary={() => setOverlay("library")}
      />
      <ChatPanel busy={busy} setBusy={setBusy} onOpenSettings={() => setOverlay("settings")} />
      {overlay === "settings" ? <SettingsPanel onClose={() => setOverlay("none")} /> : null}
      {overlay === "library" ? <LibraryPanel onClose={() => setOverlay("none")} /> : null}
    </div>
  );
}

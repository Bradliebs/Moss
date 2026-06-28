// src/App.tsx

import { useState } from "react";

import { ChatPanel } from "./components/ChatPanel";
import { LibraryPanel } from "./components/LibraryPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { Sidebar } from "./components/Sidebar";

type Overlay = "none" | "settings" | "library";

export default function App(): React.JSX.Element {
  const [overlay, setOverlay] = useState<Overlay>("none");
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex h-screen bg-transparent text-neutral-100">
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

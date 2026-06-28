// electron/main.ts
//
// Composition root for the Moss main process. Creates the window, points the
// renderer at the Vite dev server (dev) or the built bundle (prod), and
// registers IPC handlers.

import { join } from "node:path";

import { app, BrowserWindow, session } from "electron";

import { createLogger } from "../common/logger";
import { mcpManager } from "./backend/moss/mcp/mcp-manager";
import { memoryStore } from "./backend/moss/memory/memory-store";
import { registerChatIpc } from "./ipc/chat-ipc";

const log = createLogger("Main");
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    backgroundColor: "#0b0b0f",
    webPreferences: {
      preload: join(app.getAppPath(), "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(join(app.getAppPath(), "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app
  .whenReady()
  .then(() => {
    memoryStore.reload();
    registerChatIpc();
    // The renderer captures microphone audio for speech-to-text. This is a
    // local, trusted app, so grant only the media permission it needs.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === "media");
    });
    createWindow();
    // Connect MCP servers in the background; tool availability updates the
    // registry the next time a turn starts, so this need not block the window.
    void mcpManager.init().catch((err) => log.error("MCP init failed", err));
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((err) => log.error("startup failed", err));

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void mcpManager.close();
});

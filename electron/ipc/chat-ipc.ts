// electron/ipc/chat-ipc.ts
//
// Wires renderer requests to the agent runner. One AbortController + one
// ApprovalBroker per in-flight turn.

import { clipboard, dialog, ipcMain, shell } from "electron";

import { IPC } from "../../common/ipc-contract";
import type {
  ChatStartRequest,
  MemoryCategory,
  MossEvent,
  SkillCreateRequest,
  SkillUpdateRequest,
  SkillRenameRequest,
  ToolApprovalDecision,
  TranscribeRequest,
  TranscribeResult,
} from "../../common/types";
import { runTurn } from "../backend/moss/agent-runner";
import { ApprovalBroker } from "../backend/moss/approval-broker";
import {
  addMcpServer,
  ensureMcpConfig,
  loadMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
  updateMcpServer,
  type McpServerConfig,
} from "../backend/moss/mcp/mcp-config";
import { mcpManager } from "../backend/moss/mcp/mcp-manager";
import { memoryStore } from "../backend/moss/memory/memory-store";
import { createProvider } from "../backend/moss/providers";
import { skillsStore } from "../backend/moss/skills/skills-store";
import { transcribeAudio } from "../backend/moss/stt";
import { buildSystemMessage } from "../backend/moss/system-prompt";
import { TOOL_DEFINITIONS, TOOL_REGISTRY } from "../backend/moss/tools";

interface Inflight {
  controller: AbortController;
  broker: ApprovalBroker;
}

const inflight = new Map<string, Inflight>();

export function registerChatIpc(): void {
  ipcMain.on(IPC.chatStart, (event, req: ChatStartRequest) => {
    void startTurn(event, req);
  });

  ipcMain.on(IPC.chatAbort, (_event, turnId: string) => {
    const entry = inflight.get(turnId);
    if (entry) {
      entry.controller.abort();
      entry.broker.denyAll();
    }
  });

  ipcMain.on(IPC.toolApprove, (_event, decision: ToolApprovalDecision) => {
    inflight.get(decision.turnId)?.broker.resolve(decision.callId, decision.approved);
  });

  ipcMain.handle(IPC.providerListModels, async (_event, config: ChatStartRequest["config"]) => {
    const provider = createProvider(config);
    return provider.listModels();
  });

  ipcMain.handle(IPC.workspacePick, async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(IPC.memoryList, () => memoryStore.list());
  ipcMain.handle(IPC.memoryAdd, (_event, fact: string, category: MemoryCategory) =>
    memoryStore.add(fact, category, "user"),
  );
  ipcMain.handle(IPC.memoryDelete, (_event, id: string) => memoryStore.delete(id));
  ipcMain.handle(IPC.memoryClear, () => {
    memoryStore.clear();
  });

  ipcMain.handle(IPC.skillsList, () => skillsStore.list());
  ipcMain.handle(IPC.skillCreate, (_event, req: SkillCreateRequest) =>
    skillsStore.create(req.name, req.description, req.instructions),
  );
  ipcMain.handle(IPC.skillDelete, (_event, id: string) => skillsStore.delete(id));
  ipcMain.handle(IPC.skillToggle, (_event, id: string, enabled: boolean) => {
    skillsStore.setEnabled(id, enabled);
  });
  ipcMain.handle(IPC.skillUpdate, (_event, req: SkillUpdateRequest) =>
    skillsStore.update(req.id, req.description, req.instructions),
  );
  ipcMain.handle(IPC.skillRename, (_event, req: SkillRenameRequest) =>
    skillsStore.rename(req.id, req.newName),
  );

  ipcMain.handle(IPC.mcpStatus, () => mcpManager.getStatus());
  ipcMain.handle(IPC.mcpSetEnabled, async (_event, id: string, enabled: boolean) => {
    if (setMcpServerEnabled(id, enabled)) await mcpManager.reconnect(id);
    return mcpManager.getStatus();
  });
  ipcMain.handle(IPC.mcpOpenConfig, async () => {
    const path = ensureMcpConfig();
    const error = await shell.openPath(path);
    return error === "" ? path : null;
  });
  ipcMain.handle(IPC.mcpAddServer, async (_event, config: McpServerConfig) => {
    if (addMcpServer(config)) await mcpManager.reconnect(config.id);
    return mcpManager.getStatus();
  });
  ipcMain.handle(IPC.mcpUpdateServer, async (_event, config: McpServerConfig) => {
    if (updateMcpServer(config)) await mcpManager.reconnect(config.id);
    return mcpManager.getStatus();
  });
  ipcMain.handle(IPC.mcpRemoveServer, async (_event, id: string) => {
    if (removeMcpServer(id)) await mcpManager.reconnect(id);
    return mcpManager.getStatus();
  });
  ipcMain.handle(IPC.mcpListConfigs, () => loadMcpServers());
  ipcMain.handle(IPC.mcpReconnect, async (_event, id: string) => {
    await mcpManager.reconnect(id);
    return mcpManager.getStatus();
  });

  ipcMain.handle(IPC.shellOpenExternal, async (_event, url: string): Promise<boolean> => {
    // Defense in depth: the renderer also guards the scheme, but never open a
    // URL the main process has not re-validated to http(s)/mailto.
    if (typeof url !== "string" || !/^(https?:|mailto:)/i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle(IPC.clipboardWrite, (_event, text: string, html?: string): boolean => {
    if (typeof text !== "string") return false;
    clipboard.write(typeof html === "string" && html ? { text, html } : { text });
    return true;
  });

  ipcMain.handle(IPC.transcribe, async (_event, req: TranscribeRequest): Promise<TranscribeResult> => {
    try {
      return { text: await transcribeAudio(req) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
}

async function startTurn(event: Electron.IpcMainEvent, req: ChatStartRequest): Promise<void> {
  const controller = new AbortController();
  const broker = new ApprovalBroker();
  inflight.set(req.turnId, { controller, broker });

  const send = (mossEvent: MossEvent) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send(IPC.chatEvent, { turnId: req.turnId, event: mossEvent });
    }
  };

  try {
    const provider = createProvider(req.config);
    const enableTools = req.enableTools !== false;
    // Merge built-in tools with any connected MCP tools for this turn. MCP
    // servers connect at runtime, so the merge is recomputed per turn rather
    // than baked into the static built-in registry.
    const mcpTools = enableTools ? mcpManager.getTools() : [];
    const toolDefinitions = enableTools
      ? [
          ...TOOL_DEFINITIONS,
          ...mcpTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
        ]
      : [];
    const toolRegistry =
      mcpTools.length > 0
        ? new Map([...TOOL_REGISTRY, ...mcpTools.map((t) => [t.name, t] as const)])
        : TOOL_REGISTRY;
    // Prepend a fresh system message (base instructions + skills index + memory)
    // unless the renderer already supplied one. The latest user message drives
    // query-aware memory selection.
    const hasSystem = req.messages.some((m) => m.role === "system");
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const messages = hasSystem
      ? req.messages
      : [buildSystemMessage({ includeSkills: enableTools, query: lastUser?.content ?? "", customInstructions: req.customInstructions, personalityId: req.personalityId, adaptiveTone: req.adaptiveTone }), ...req.messages];
    await runTurn({
      provider,
      model: req.config.model,
      messages,
      tools: toolDefinitions,
      toolRegistry,
      workspaceRoot: req.workspaceRoot ?? "",
      signal: controller.signal,
      onEvent: send,
      requestApproval: (callId) => broker.request(callId),
      autoApprove: req.autoApproveTools === true,
      stt: req.stt,
      email: req.email,
    });
  } catch (err) {
    send({ type: "turn-error", message: err instanceof Error ? err.message : String(err), messages: [] });
  } finally {
    inflight.delete(req.turnId);
  }
}

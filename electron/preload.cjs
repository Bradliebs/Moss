// electron/preload.cjs
//
// Hand-written CommonJS preload (not compiled by tsc). Channel strings are
// duplicated from common/ipc-contract.ts — keep them in sync.

const { contextBridge, ipcRenderer } = require("electron");

const CH = {
  chatStart: "moss:chat:start",
  chatAbort: "moss:chat:abort",
  chatEvent: "moss:chat:event",
  toolApprove: "moss:tool:approve",
  providerListModels: "moss:provider:listModels",
  workspacePick: "moss:workspace:pick",
  memoryList: "moss:memory:list",
  memoryAdd: "moss:memory:add",
  memoryDelete: "moss:memory:delete",
  memoryClear: "moss:memory:clear",
  skillsList: "moss:skills:list",
  skillCreate: "moss:skills:create",
  skillDelete: "moss:skills:delete",
  skillToggle: "moss:skills:toggle",
  skillUpdate: "moss:skills:update",
  skillRename: "moss:skills:rename",
  mcpStatus: "moss:mcp:status",
  mcpSetEnabled: "moss:mcp:setEnabled",
  mcpOpenConfig: "moss:mcp:openConfig",
  mcpAddServer: "moss:mcp:addServer",
  mcpUpdateServer: "moss:mcp:updateServer",
  mcpRemoveServer: "moss:mcp:removeServer",
  mcpListConfigs: "moss:mcp:listConfigs",
  mcpReconnect: "moss:mcp:reconnect",
  shellOpenExternal: "moss:shell:openExternal",
  transcribe: "moss:stt:transcribe",
  clipboardWrite: "moss:clipboard:write",
  checkpointList: "moss:checkpoint:list",
  checkpointRevert: "moss:checkpoint:revert",
};

contextBridge.exposeInMainWorld("moss", {
  chat: {
    send: (request) => ipcRenderer.send(CH.chatStart, request),
    abort: (turnId) => ipcRenderer.send(CH.chatAbort, turnId),
    onEvent: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on(CH.chatEvent, listener);
      return () => ipcRenderer.removeListener(CH.chatEvent, listener);
    },
  },
  tool: {
    approve: (decision) => ipcRenderer.send(CH.toolApprove, decision),
  },
  provider: {
    listModels: (config) => ipcRenderer.invoke(CH.providerListModels, config),
  },
  workspace: {
    pick: () => ipcRenderer.invoke(CH.workspacePick),
  },
  memory: {
    list: () => ipcRenderer.invoke(CH.memoryList),
    add: (fact, category) => ipcRenderer.invoke(CH.memoryAdd, fact, category),
    delete: (id) => ipcRenderer.invoke(CH.memoryDelete, id),
    clear: () => ipcRenderer.invoke(CH.memoryClear),
  },
  skills: {
    list: () => ipcRenderer.invoke(CH.skillsList),
    create: (request) => ipcRenderer.invoke(CH.skillCreate, request),
    delete: (id) => ipcRenderer.invoke(CH.skillDelete, id),
    toggle: (id, enabled) => ipcRenderer.invoke(CH.skillToggle, id, enabled),
    update: (request) => ipcRenderer.invoke(CH.skillUpdate, request),
    rename: (request) => ipcRenderer.invoke(CH.skillRename, request),
  },
  mcp: {
    status: () => ipcRenderer.invoke(CH.mcpStatus),
    setEnabled: (id, enabled) => ipcRenderer.invoke(CH.mcpSetEnabled, id, enabled),
    openConfig: () => ipcRenderer.invoke(CH.mcpOpenConfig),
    add: (config) => ipcRenderer.invoke(CH.mcpAddServer, config),
    update: (config) => ipcRenderer.invoke(CH.mcpUpdateServer, config),
    remove: (id) => ipcRenderer.invoke(CH.mcpRemoveServer, id),
    servers: () => ipcRenderer.invoke(CH.mcpListConfigs),
    reconnect: (id) => ipcRenderer.invoke(CH.mcpReconnect, id),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke(CH.shellOpenExternal, url),
  },
  clipboard: {
    write: (text, html) => ipcRenderer.invoke(CH.clipboardWrite, text, html),
  },
  stt: {
    transcribe: (request) => ipcRenderer.invoke(CH.transcribe, request),
  },
  checkpoint: {
    list: (turnId) => ipcRenderer.invoke(CH.checkpointList, turnId),
    revert: (turnId) => ipcRenderer.invoke(CH.checkpointRevert, turnId),
  },
});

// common/ipc-contract.ts
//
// Single source of truth for IPC channel names. The hand-written
// `electron/preload.cjs` cannot import this TS module, so it duplicates these
// string literals — keep the two in sync.

export const IPC = {
  /** renderer -> main: begin streaming a turn (fire-and-forget; events stream back) */
  chatStart: "moss:chat:start",
  /** renderer -> main: abort an in-flight turn by turnId */
  chatAbort: "moss:chat:abort",
  /** main -> renderer: a normalized MossEvent for a turn */
  chatEvent: "moss:chat:event",
  /** renderer -> main: approve or deny a pending tool call */
  toolApprove: "moss:tool:approve",
  /** renderer -> main (invoke): list available models for a provider config */
  providerListModels: "moss:provider:listModels",
  /** renderer -> main (invoke): open a folder picker, returns path or null */
  workspacePick: "moss:workspace:pick",

  /** renderer -> main (invoke): memory CRUD */
  memoryList: "moss:memory:list",
  memoryAdd: "moss:memory:add",
  memoryDelete: "moss:memory:delete",
  memoryClear: "moss:memory:clear",

  /** renderer -> main (invoke): skills CRUD */
  skillsList: "moss:skills:list",
  skillCreate: "moss:skills:create",
  skillDelete: "moss:skills:delete",
  skillToggle: "moss:skills:toggle",
  skillUpdate: "moss:skills:update",
  skillRename: "moss:skills:rename",

  /** renderer -> main (invoke): connected/failed status of MCP servers */
  mcpStatus: "moss:mcp:status",
  /** renderer -> main (invoke): enable/disable a configured MCP server, then
   *  re-init the manager and return the refreshed status */
  mcpSetEnabled: "moss:mcp:setEnabled",
  /** renderer -> main (invoke): open mcp-servers.json in the OS default editor */
  mcpOpenConfig: "moss:mcp:openConfig",
  /** renderer -> main (invoke): add a server to mcp-servers.json, then re-init
   *  the manager and return the refreshed status */
  mcpAddServer: "moss:mcp:addServer",
  /** renderer -> main (invoke): merge changed fields into an existing server in
   *  mcp-servers.json, then re-init the manager and return the refreshed status */
  mcpUpdateServer: "moss:mcp:updateServer",
  /** renderer -> main (invoke): remove a server from mcp-servers.json, then
   *  re-init the manager and return the refreshed status */
  mcpRemoveServer: "moss:mcp:removeServer",
  /** renderer -> main (invoke): read the raw configured servers, so the settings
   *  UI can populate an edit form with a server's command/args/url */
  mcpListConfigs: "moss:mcp:listConfigs",
  /** renderer -> main (invoke): tear down and reconnect a single server by id,
   *  then return the refreshed status */
  mcpReconnect: "moss:mcp:reconnect",

  /** renderer -> main (invoke): open an http(s)/mailto URL in the OS browser */
  shellOpenExternal: "moss:shell:openExternal",

  /** renderer -> main (invoke): transcribe captured audio to text (Whisper) */
  transcribe: "moss:stt:transcribe",
} as const;

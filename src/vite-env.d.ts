/// <reference types="vite/client" />

import type {
  ChatEventPayload,
  ChatStartRequest,
  McpServerStatus,
  MemoryCategory,
  MemoryEntry,
  ProviderConfig,
  Skill,
  SkillCreateRequest,
  ToolApprovalDecision,
  TranscribeRequest,
  TranscribeResult,
} from "@common/types";

declare global {
  /** Server shape accepted by the settings UI add/edit form and returned by
   *  mcp.servers(). A structural subset of the backend McpServerConfig: only the
   *  fields the form reads or writes (env/cwd/headers stay file-edited). */
  type MossMcpServerInput =
    | { type: "stdio"; id: string; command: string; args?: string[]; enabled?: boolean }
    | { type: "http"; id: string; url: string; enabled?: boolean };


  interface Window {
    moss: {
      chat: {
        send: (request: ChatStartRequest) => void;
        abort: (turnId: string) => void;
        onEvent: (handler: (payload: ChatEventPayload) => void) => () => void;
      };
      tool: {
        approve: (decision: ToolApprovalDecision) => void;
      };
      provider: {
        listModels: (config: ProviderConfig) => Promise<string[]>;
      };
      workspace: {
        pick: () => Promise<string | null>;
      };
      memory: {
        list: () => Promise<MemoryEntry[]>;
        add: (fact: string, category: MemoryCategory) => Promise<MemoryEntry | null>;
        delete: (id: string) => Promise<boolean>;
        clear: () => Promise<void>;
      };
      skills: {
        list: () => Promise<Skill[]>;
        create: (request: SkillCreateRequest) => Promise<Skill>;
        delete: (id: string) => Promise<boolean>;
        toggle: (id: string, enabled: boolean) => Promise<void>;
      };
      mcp: {
        status: () => Promise<McpServerStatus[]>;
        setEnabled: (id: string, enabled: boolean) => Promise<McpServerStatus[]>;
        openConfig: () => Promise<string | null>;
        add: (config: MossMcpServerInput) => Promise<McpServerStatus[]>;
        update: (config: MossMcpServerInput) => Promise<McpServerStatus[]>;
        remove: (id: string) => Promise<McpServerStatus[]>;
        servers: () => Promise<MossMcpServerInput[]>;
        reconnect: (id: string) => Promise<McpServerStatus[]>;
      };
      shell: {
        openExternal: (url: string) => Promise<boolean>;
      };
      stt: {
        transcribe: (request: TranscribeRequest) => Promise<TranscribeResult>;
      };
    };
  }
}

export {};

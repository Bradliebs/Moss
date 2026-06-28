// electron/backend/moss/tools/types.ts

import type { SttConfig } from "../../../../common/types";

export interface ToolContext {
  /** absolute sandbox root; empty string means no workspace selected */
  workspaceRoot: string;
  signal: AbortSignal;
  /** speech-to-text config, when configured, for the transcribe_audio tool */
  stt?: SttConfig;
}

export interface ToolResult {
  ok: boolean;
  content: string;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

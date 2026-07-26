// electron/backend/moss/tools/types.ts

import type { EmailConfig, EmbedConfig, SttConfig } from "../../../../common/types";
import type { CheckpointRecorder } from "../checkpoint/checkpoint-store";
import type { PlanStore } from "../task/plan-store";

export interface ToolContext {
  /** absolute sandbox root; empty string means no workspace selected */
  workspaceRoot: string;
  signal: AbortSignal;
  /** speech-to-text config, when configured, for the transcribe_audio tool */
  stt?: SttConfig;
  /** email config, when configured, for the send_email tool */
  email?: EmailConfig;
  /** embeddings config, when configured, for the search_codebase tool */
  embed?: EmbedConfig;
  /** when present, mutating tools snapshot a file's pre-image before changing
   *  it so the turn's edits can be reverted */
  checkpoint?: CheckpointRecorder;
  /** Trusted runtime state: true only when the user approved this exact tool
   *  call through the approval broker. Never sourced from model arguments. */
  approvalGranted?: boolean;
  /** when true, m_remember queues a proposal for human review instead of
   *  writing straight to durable memory */
  gatedMemory?: boolean;
  /** checklist state for the plan tool; scoped to the turn unless the caller
   *  supplies a longer-lived store */
  plan?: PlanStore;
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

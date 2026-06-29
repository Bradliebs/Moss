// common/types.ts
//
// Shared types reachable from both the Electron main process (CommonJS) and the
// React renderer (ESM via Vite). Type-only / pure data — no runtime imports that
// differ across the two module systems.

export type ProviderKind = "openai-compatible" | "anthropic";

export interface ProviderConfig {
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** Speech-to-text endpoint config carried alongside a turn so the
 *  transcribe_audio tool can reach the same Whisper endpoint as the mic. */
export interface SttConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** Email-sending config carried alongside a turn so the send_email tool can
 *  reach the Resend HTTPS API. apiKey empty = tool refuses (no plaintext SMTP). */
export interface EmailConfig {
  apiKey: string;
  from: string;
}

/** Verification config carried alongside a turn: after the agent edits files,
 *  these shell commands run in the workspace and their pass/fail is fed back to
 *  the model so it can self-correct. Disabled or empty commands = no-op. */
export interface VerifyConfig {
  enabled: boolean;
  /** shell commands run in workspace order; fail-fast on the first failure */
  commands: string[];
  /** max times verification runs per turn before the loop stops re-checking */
  maxCycles?: number;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** A tool invocation requested by the model. `arguments` is the raw JSON string
 *  the model emitted (parsed at execution time). */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Content-risk tier the permission policy resolves for a tool call. */
export type ToolRisk = "readonly" | "mutating" | "destructive";

/** The neutral conversation unit. Providers translate to/from their own wire
 *  formats (OpenAI tool_calls / Anthropic tool_use + tool_result). */
export interface AgentMessage {
  role: ChatRole;
  content: string;
  /** present on assistant turns that invoke tools */
  toolCalls?: ToolCall[];
  /** present on tool-result turns; references the ToolCall.id it answers */
  toolCallId?: string;
  /** present on tool-result turns that ran under auto-approve without a prompt;
   *  persisted so reloaded history stays truthful about what ran unattended */
  autoApproved?: boolean;
  /** real content-risk tier the permission policy resolved when this tool ran;
   *  persisted so an after-the-fact audit reflects what actually ran rather than
   *  a name-based guess. Absent on readonly allow-listed tools the policy runs
   *  without recording a tier. */
  risk?: ToolRisk;
  /** wall-clock milliseconds the tool took to execute, recorded when this
   *  tool ran so an audit can show how long each call took. Absent on history
   *  saved before durations were tracked. */
  durationMs?: number;
  /** present on an assistant turn cut off by an error mid-stream; persisted so
   *  reloaded history shows it was interrupted rather than a complete reply */
  interrupted?: boolean;
  /** token counts the provider reported for the round that produced this
   *  message, when available; the session total is the sum across messages */
  usage?: TokenUsage;
  /** image attachments on a user turn, as data URLs (data:<mime>;base64,...).
   *  Sent to vision-capable models as image content parts alongside the text */
  images?: string[];
  /** id of the turn that produced this message; stamped on assistant turns so
   *  the renderer can look up and revert the files that turn changed */
  turnId?: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** Tool advertised to the model. `parameters` is a JSON Schema object. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Normalized turn events emitted by the agent runner to the renderer. */
export type MossEvent =
  | { type: "text-delta"; text: string }
  | { type: "token-usage"; usage: TokenUsage }
  | { type: "tool-call"; callId: string; name: string; arguments: string }
  | { type: "tool-approval-request"; callId: string; name: string; arguments: string; risk?: ToolRisk }
  | { type: "tool-result"; callId: string; name: string; ok: boolean; content: string; autoApproved: boolean; risk?: ToolRisk; durationMs?: number }
  | { type: "notice"; level: "info" | "warn"; message: string }
  | { type: "turn-complete"; messages: AgentMessage[] }
  | { type: "turn-aborted"; messages: AgentMessage[] }
  | { type: "turn-error"; message: string; messages: AgentMessage[] };

export interface ChatStartRequest {
  turnId: string;
  config: ProviderConfig;
  messages: AgentMessage[];
  /** absolute path tools are sandboxed to; empty = no filesystem access */
  workspaceRoot?: string;
  /** when false, tools are not advertised (plain chat, for non-tool models) */
  enableTools?: boolean;
  /** when true, run mutating tools without pausing for per-call approval */
  autoApproveTools?: boolean;
  /** user-authored persona/instructions appended to the base system prompt;
   *  the safety section is always kept, so this cannot disable XPIA defenses */
  customInstructions?: string;
  /** id of the selected personality preset; the backend maps it to an
   *  allow-listed prompt, so an unknown id injects nothing */
  personalityId?: string;
  /** when true, the assistant adapts its tone to remembered preferences
   *  (memory-driven adaptation) */
  adaptiveTone?: boolean;
  /** speech-to-text config for the transcribe_audio tool */
  stt?: SttConfig;
  /** email config for the send_email tool */
  email?: EmailConfig;
  /** verification commands run after the agent edits files */
  verify?: VerifyConfig;
}

export interface ToolApprovalDecision {
  turnId: string;
  callId: string;
  approved: boolean;
}

export interface ChatEventPayload {
  turnId: string;
  event: MossEvent;
}

/** A file a turn changed, as reported to the renderer for the revert affordance. */
export interface CheckpointFile {
  /** workspace-relative path */
  path: string;
  /** false when the turn created the file (revert deletes it) */
  existed: boolean;
}

/** Outcome of reverting a turn's file changes. */
export interface CheckpointRevertResult {
  /** number of files restored or deleted */
  reverted: number;
  /** per-file failures, as "<path>: <message>" */
  errors: string[];
}

// --- Durable memory & skills (Phase 5) ---

export type MemoryCategory = "preference" | "fact" | "decision" | "context";

export interface MemoryEntry {
  id: string;
  fact: string;
  category: MemoryCategory;
  /** who recorded it, e.g. "assistant" or "user" */
  source: string;
  createdAt: string;
}

export interface Skill {
  /** filesystem-safe directory id */
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  createdAt: string;
  /** "agent" when authored by the model via m_create_skill; "user" otherwise.
   *  Agent-created skills start disabled until a human enables them. */
  createdBy?: "user" | "agent";
}

export interface SkillCreateRequest {
  name: string;
  description: string;
  instructions: string;
}

export interface SkillUpdateRequest {
  id: string;
  description: string;
  instructions: string;
}

export interface SkillRenameRequest {
  id: string;
  newName: string;
}

// --- MCP runtime status (Phase 6 settings, read-only) ---

export interface McpServerStatus {
  id: string;
  /** false when the server is configured but turned off in mcp-servers.json;
   *  such servers are listed (so the settings UI can re-enable them) but never
   *  connected. */
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  /** names of the tools the server exposes (raw MCP tool names, unprefixed);
   *  present only while connected, for a hover/expand list in the settings UI */
  tools?: string[];
  error?: string;
}

// --- Speech-to-text (Whisper via OpenAI-compatible /audio/transcriptions) ---

export interface TranscribeRequest {
  /** base64-encoded audio bytes captured in the renderer */
  audioBase64: string;
  mimeType: string;
  /** transcription endpoint base URL (e.g. http://localhost:8000/v1) */
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export interface TranscribeResult {
  text?: string;
  error?: string;
}

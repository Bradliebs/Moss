# Subagent Research: Scout Core Agentic Capabilities

Reference half of a Moss<->Scout parity gap analysis. READ-ONLY audit of Microsoft Scout
(`D:\Brad\Downloads\m-main\m-main`, Scout v0.22.358). Scope = provider-agnostic core only.
EXCLUDED (not investigated): auth (Entra/MSAL/GitHub OAuth), M365/WorkIQ/OneDrive, telemetry
(1DS/hugin/px/heartbeat), gateway-node, enterprise/, teams-manifest/, private Azure feeds.

## Research Questions (7 areas)
1. TOOLS — built-in agent tools, names, schemas, behavior
2. PERMISSION / APPROVAL MODEL — tiers, auto-approve, path guards, command classification
3. AGENT LOOP — turn structure, streaming, iterations, tool feedback, cancellation
4. SKILLS SYSTEM — discovery, loading, description, invocation, file structure
5. MCP — config, lifecycle, tool surfacing, browser control
6. SYSTEM PROMPT — assembly, personas, injected instructions
7. CHAT UX — tool rendering, approval UI, streaming, attachments, sessions, stop/edit

## Status: Complete

---

## TOP-LEVEL ARCHITECTURE FINDING (load-bearing for the whole audit)

**Scout does NOT contain an agent loop, and it does NOT implement the core file/shell/web tools.**
Both live inside the bundled GitHub Copilot CLI that `@github/copilot-sdk` spawns. Scout is a
**host shell** around that CLI. What Scout owns and what it borrows:

| Concern | Owned by Scout (replicable) | Owned by the bundled Copilot CLI/SDK (NOT in repo) |
|---|---|---|
| Agent turn loop, tool-call iteration, streaming | no | yes |
| Core tools: `view`, `grep`, `glob`, `edit`, `create`, `web_fetch` | no (only declared/gated) | yes |
| Shell execution + "Search Web" | no (gated only) | yes |
| `m_*` self/automation/memory/skill tools (~40) | yes | no |
| `m_filesystem_*` tools (5) | yes | no |
| Permission/approval policy + gating | yes | no (calls Scout's `onPermissionRequest`) |
| MCP server config + lifecycle wiring | yes | host (CLI runs the MCP host) |
| System prompt assembly | yes | no |
| Skills system | yes | no |
| Event normalization -> UI | yes | no |

Implication for Moss parity: the loop and core tools must be supplied by whatever
provider/runtime Moss uses (e.g. an Ollama/OpenAI tool-call loop). Scout's *reusable* value is the
permission policy, the `m_*`/`m_filesystem_*` tool implementations, the skills system, the MCP
config layer, and the system-prompt builder -- all SDK-agnostic.

Evidence: common/sdk-builtin-tools.ts declares the SDK-native tools, "Maintained by hand because the
Copilot SDK does not export its tool roster." The session is created via
`actualClient.createSession({...})` in electron/backend/copilot/session.ts; no turn loop exists in the
repo -- only `session.abort()` and event wiring.

---

## AREA 1 -- TOOLS

### 1a. SDK-native (bundled CLI) tools -- declared & gated in Scout, implemented by the CLI

common/sdk-builtin-tools.ts:

```ts
export const SDK_BUILTIN_TOOLS = {
  web_fetch: { gatedByServer: "playwright" },
  view:      { gatedByServer: "filesystem" },
  grep:      { gatedByServer: "filesystem" },
  glob:      { gatedByServer: "filesystem" },
  edit:      { gatedByServer: "filesystem" },
  create:    { gatedByServer: "filesystem" },
} as const;
const SDK_HITL_REQUIRED = new Set(["edit", "create"]); // bypass onPermissionRequest -> forced HITL
```

- `view` (read file), `grep` (content search), `glob` (path search): filesystem READ tools -- eligible
  for read auto-approve. Helpers: `isSdkFilesystemReadTool()`, `isSdkHitlRequired()`,
  `normalizeSdkToolName()`, `isSdkBuiltinTool()`, `getServerForSdkTool()`.
- `edit`, `create`: filesystem WRITE tools -- in `SDK_HITL_REQUIRED`, always human-in-the-loop.
- `web_fetch`: "Fetch HTTP(S) URLs without browser automation", gated by the `playwright` server but
  remains SDK-native even when Playwright MCP exposes no tools (synthetic tool added in
  electron/tool-discovery.ts).
- **Shell** and **Search Web** are SDK/CLI built-in "servers" (no JSON schema in repo) --
  `BUILTIN_SERVERS = ["Shell", "Search Web", "WorkIQ"]` in electron/mcp-tools.ts.

Scout never defines parameter schemas for these -- they are the CLI's. Scout only knows their names for
permission gating and UI listing.

### 1b. Scout filesystem tools (`m_filesystem_*`) -- implemented in repo

electron/scout-fs/tools.ts (254 lines) -- `getSelfFsTools(deps): Tool<any>[]`. Exactly 5 tools, all
guarded by `assertRealpathAllowed(path, "read"|"write", scope())` from scout-fs/path-guard.ts (realpath
check against workspace + per-session folder grants), plus `checkSensitivePath`. They supplement the
CLI's view/edit/create with structured directory ops:

| Tool | Purpose | Params (notable) | Behavior |
|---|---|---|---|
| `m_filesystem_list` | List a directory | `path` | JSON entries `{name,type,size}` |
| `m_filesystem_tree` | Recursive tree | `path`, `maxDepth`(default 5) | `MAX_ENTRIES=5000`, symlink-loop guard (visited Set), `truncated` flag |
| `m_filesystem_stat` | Stat a path | `path` | `size,isFile,isDirectory,times,mode` |
| `m_filesystem_mkdir` | Make dir | `path` | recursive |
| `m_filesystem_move` | Move/rename | `from`,`to` (write-guarded) | write-scoped (body truncated at read) |

Deps: `SelfFsToolDeps { getWorkspaceDir, getEffectiveFolderGrants():{read,write}, settingsManager }`;
`scope()` -> `FsAccessScope { workspaceDir, readGrants, writeGrants }`.

### 1c. Scout self-control tools (`m_*`) -- implemented in repo

electron/self-tools.ts (1538 lines). "Self-control tools -- lets the LLM manage Microsoft Scout's own
features." Each is an SDK `Tool` `{ name, description, parameters, handler }`. Conventions:
`import type { Tool } from "@github/copilot-sdk"`; `toolParameters(schema: z.ZodType)` converts a Zod
schema and **strips `$schema`** (provider-agnostic JSON Schema); `typedHandler<TArgs>` identity wrapper.
Deps injected via `ISelfToolDeps` from electron/backend/ports.ts.

Full `m_*` roster (self-tools.ts + scout-fs, verified by name extraction):

- Memory: `m_remember`, `m_recall`, `m_list_memories`, `m_forget`
- Skills: `m_list_skills`, `m_get_skill`, `m_create_skill`, `m_update_skill`, `m_delete_skill`
- Automations: `m_list_automations`, `m_get_automation`, `m_create_automation`, `m_update_automation`,
  `m_delete_automation`, `m_run_automation_now`
- Models: `m_list_models`, `m_get_current_model`, `m_set_default_model`
- Personality: `m_list_personalities`, `m_set_personality`
- Settings: `m_get_settings`, `m_update_settings` (Zod `SettingsUpdateSchema.strict()`: theme,
  telemetryEnabled, miniModeEnabled, sessionRetentionDays, experiments.authCooldown, ...)
- Sessions: `m_list`/`m_search_sessions`, `m_get_session_transcript`, `m_delete_session`
- Heartbeat: `m_get_heartbeat_status`, `m_run_heartbeat_now`, `m_set_heartbeat_settings`
- Teams relay (gated): `m_relay_connect`, `m_relay_disconnect`, `m_relay_status`, `m_send_teams_message`
- Permissions/escalation: `m_request_permission_escalation`
- Control-flow / UX: `m_ask_user` (2-5 discrete choices; surfaced via `tool-result.question`),
  `m_compact` (compact conversation), `m_accept_workiq_eula`
- WorkIQ/M365 sign-in tools (`m_m365_*`) -- referenced in prompt, EXCLUDED from this audit.

UI grouping registry (not execution): common/tool-registry.ts defines `APP_TOOLS_CATEGORY`
(Memory/Automations/Skills groups), `M365_CATEGORY` (excluded), and `MCP_BUILTIN_TOOLS.playwright`
(22 `browser_*` tools -- Area 5).

### 1d. Where the full tool set is assembled

session.ts -> `buildAllTools(sessionId, workspaceDir, onSensitivityDetected)` passed as `tools:` to
`createSession`. Combines SDK-native (implicit), `m_*` self-tools, `m_filesystem_*`, and MCP tools.
tool-discovery.ts builds the *UI* category tree (`buildStaticCategories`, `buildMcpCategory`,
`humanize()` strips `workiq_`/`m365_`/`m_` prefixes), separate from execution.

---

## AREA 2 -- PERMISSION / APPROVAL MODEL (fully owned by Scout -- highest reuse value)

Core class: `PermissionPolicy` in electron/permission-policy.ts (1532 lines), implementing
`IPermissionPolicy`. Public entry: `evaluate(request): "approve"|"deny"|"prompt"` ->
`evaluateInternal(request, shouldAudit)`. Decision is a **first-match-wins priority pipeline** over
`POLICY_RULES` (each rule `apply()` returns a result or `null` to fall through). A separate
`evaluatePreHook()` over `POLICY_PRE_HOOK_RULES` runs BEFORE the SDK's permission handler
(tenant/user-disabled servers, tool gates).

### 2a. The 16-rule pipeline (exact order)

electron/policy-rules/index.ts:

```
 1. TENANT_DENY_RULE              (enterprise policy hard-deny)
 2. TENANT_FORCE_PROMPT_RULE      (enterprise force prompt)
 3. SENSITIVE_PATH_GATE_RULE      -> prompt (deny+audit) if path is sensitive
 4. READ_AUTO_APPROVE_RULE        -> approve kind:"read" inside workspace (else fall through)
 5. SERVER_DISABLED_RULE          -> deny if the server toggle is off
 6. FOLDER_GRANT_RULE             (out-of-workspace read/write folder grants)
 7. WORKIQ_EULA_GATE_RULE         (excluded domain)
 8. REMOTE_AUTH_VECTOR_RULE       -> block remote-auth exfil vectors
 9. SERVER_AUTO_APPROVE_RULE      -> approve if server.autoApprove===true (shell: single-invocation only)
10. KIND_SERVER_FALLBACK_RULE     (map kind->server name)
11. READ_ONLY_AUTO_APPROVE_RULE   -> approve read-only shell/custom-tool IF autoApproveReadOnly setting on
12. SHELL_DENY_PATTERN_RULE       -> deny on denyPatterns or unsafe shell syntax
13. STRUCTURED_TOOL_AUTO_APPROVE_RULE -> approve if tool/group key persisted true
14. PATTERN_WHITELIST_RULE        -> approve if all shell segments / pattern key match allow-list
15. BACKGROUND_DENY_RULE          -> deny in unattended sessions that can't prompt
16. DEFAULT_PROMPT_RULE           -> prompt (terminal default; pipeline must end here)
```

`evaluateInternal` throws if the list doesn't terminate in `DEFAULT_PROMPT_RULE` -- defensive invariant.

### 2b. What distinguishes auto-approved vs approval-required

- **Auto-approved with no setting**: `kind:"read"` whose resolved path is inside the workspace
  (`READ_AUTO_APPROVE_RULE`; re-enforces the boundary itself because "SDK read tools bypass the MCP's
  allowedDirectories", case-insensitive prefix on win32). Out-of-workspace reads fall through.
- **Auto-approved only when `permissions.autoApproveReadOnly === true`**: read-only shell
  (`isReadOnlyCommand`, large `READ_ONLY_PREFIXES` list: ls, cat, head, tail, grep, rg, echo, date,
  whoami, plus read-only git/az analyzers `isReadOnlyGitCommand`/`isReadOnlyAzCommand`) and read-only
  custom tools (`isReadOnlyCustomTool`; unattended sessions use stricter `isUnattendedSafeCustomTool`).
- **Auto-approved via persisted user choice**: structured tool key true
  (`STRUCTURED_TOOL_AUTO_APPROVE_RULE`, tool->group fallback via `getToolGroupKey`; group `false` !=
  block, explicit tool `false` skips group), or shell/pattern allow-list match (`PATTERN_WHITELIST_RULE`,
  `allSegmentsMatchAllowPatterns`).
- **Auto-denied**: sensitive path (forces prompt, audited denied), disabled server, deny-pattern or
  unsafe shell syntax (`isUnsafeShellSyntax`), remote-auth vector, unattended background session
  (`sessionDenyPrompt`).
- **Everything else -> prompt** (interactive permission card).

### 2c. Shell command classification (LLM-assisted)

electron/permission-classifier.ts -- `classifyShellCommand(command, deps)` calls an LLM (`deps.infer`,
15s "permission-card UX budget") with a strict JSON-only system prompt labeling a command as
`readonly | writes | network | destructive | unknown`, plus `explanation`, `suggestedPattern`,
`patternRationale`. On infer/parse failure -> `FALLBACK_CLASSIFICATION`. Output passes through
`applyGuardrails()` (permission-pattern-guardrails.ts) which can override the LLM (e.g. re-tag a
"readonly" that actually mutates). Drives the permission card's explanation + safe "always allow"
pattern; it does NOT itself approve.

### 2d. Supporting modules (all SDK-agnostic, reusable)

- permission-patterns.ts (tokenize, splitShellSegments, allow/deny matchers, `getPatternKey`),
  permission-shell-syntax.ts (`getShellMode`, `isUnsafeShellSyntax`), permission-sensitive-paths.ts
  (`checkSensitivePath` -> `SensitivePathHit`), permission-path-scope.ts (`grantFolderForPath`,
  `isPathWithinDir`), permission-remote-auth.ts (`hasRemoteAuthVector`), policy-rules/* (rule bodies),
  audit-log.ts (every auto-decision audited with `source`: policy-auto-approve, policy-auto-deny,
  policy-security-gate, user-interactive, policy-burst-defuser).
- Persistence/scope state maps in PermissionPolicy: `sessionAdditions` ("Allow for session", in-memory,
  lost on restart), `entitySessionPermissions` (automations/heartbeat), `unattendedSessions` (stricter
  custom-tool set), `sessionDenyPrompt` (background auto-deny). `always-allow` -> `persistAllowRule`
  (disk). `getEffectiveFolderGrants(sessionId)` is consumed by the scout-fs realpath guard so the FS
  tools re-check against exactly what the policy approved.
- `FALLBACK_PERMISSIONS = { autoApproveReadOnly:false, allow:[], tools:{}, servers:{} }`.
  `PermissionCardManager` (permission-card-manager.ts) bridges policy <-> UI cards with a "burst
  defuser" that auto-resolves sibling pending cards once an always-allow rule lands.

---

## AREA 3 -- AGENT LOOP (lives in the bundled CLI; Scout normalizes + gates)

No turn/tool-call loop in the repo. Scout creates an SDK session and reacts to its event stream.
electron/backend/copilot/session.ts:

```ts
const sdkSession = await actualClient.createSession({
  clientName: `${APP_NAME}/${app.getVersion()}`,
  model: opts.model,
  streaming: true,
  workingDirectory: effectiveWorkspaceDir,
  includeSubAgentStreamingEvents: false,
  mcpServers: mcpConfig,
  hooks,                       // buildHooks() -- onUserPromptSubmitted etc.
  tools: allTools,             // SDK-native + m_* + m_filesystem_* + MCP
  systemMessage: { content: opts.systemMessage },
  onPermissionRequest: permissionHandler,  // -> ApprovalBroker -> PermissionPolicy
});
this.wireEvents(opts.sessionId, sdkSession);
this.eagerlyLoadMcp(opts.sessionId, sdkSession);   // pre-warm MCP host
```

- **Streaming**: `streaming: true`. Loop, max-iterations, tool-result feedback are internal to the CLI,
  not configurable from the repo.
- **Resume**: `resume()` uses `actualClient.resumeSession(backendId, config)` (restores history from
  disk); fallback creates a fresh session with context injected via system message.
- **Cancellation**: `abort(sessionId)` -> `session.abort()` (only loop control Scout exposes).
- **Per-turn context injection**: `buildUserPromptContext(prompt, {timeZone})` in system-message.ts
  returns `{ modifiedPrompt }` appending an authoritative current-date line every user turn (uses
  `modifiedPrompt` not `additionalContext` due to SDK v0.2.2 bug #775).

### 3a. Event normalization (the seam Moss would re-implement)

electron/backend/normalize-event.ts -- `normalizeEvent(event: SessionEvent): BackendEvent[]` maps raw
SDK events -> Scout's `BackendEvent` union (electron/backend/types.ts):

| SDK event | BackendEvent |
|---|---|
| `assistant.message_delta` | `text-delta` |
| `assistant.message` | `turn-complete` (commits `{id,role,content,reasoning}`) |
| `assistant.reasoning_delta` | `reasoning-delta` |
| `tool.execution_start` | `tool-start {toolCallId,toolName(mcpToolName||sdkToolName),args,serverName}` |
| `tool.execution_complete` | `tool-result {toolCallId,result,success,error}` |
| (others) | `token-usage`, `llm-usage`, `status`, `metadata-updated`, `mcp-server-status`, `mcp-oauth-required/completed`, `idle` |

`BackendEvent` also carries `text-snapshot` (Phase-2 gateway), `turn-error {recoverable,code?,
retryAfterMs?}`, and `tool-result.question` (for `m_ask_user`). `MCP_STATUSES =
connected|failed|needs-auth|pending|disabled|not_configured`. `TurnAccumulator`
(electron/turn-accumulator.ts) buffers deltas and decides when to commit turn-complete (e.g. holds
empty messages so question-only turns commit). Multi-step planning/iteration is entirely CLI-side.

---

## AREA 4 -- SKILLS SYSTEM (fully owned by Scout -- high reuse value)

Module: electron/skills.ts (814 lines).

### 4a. Skill file structure

A skill = a directory containing `SKILL.md` with YAML frontmatter + Markdown body:

```
---
name: <slug>
description: <one line; used for model matching only>
---
<full instructions / body -- the actual execution guidance>
```

Parsing: regex `^---\n([\s\S]*?)\n---\n?([\s\S]*)$` -> frontmatter + body; `description` from
`^description:\s*(.+)$`. A skill may carry a resource directory (helper scripts/files) beside SKILL.md.

### 4b. Discovery & loading (three tiers, single chokepoint)

`loadSkills()` merges, in precedence order:
1. **Local** -- `~/.copilot/m-skills/` (`LOCAL_SKILLS_DIR`), user-authored/editable.
2. **Global** -- `~/.copilot/skills/` (`GLOBAL_SKILLS_DIR`).
3. **Bundled** -- shipped `app/bundled-skills/`, installed/refreshed by version via
   `initBundledSkills(appRoot, appVersion)` (writes a `.bundled-version` marker per skill).

Disabled state in `m-skills/disabled-skills.json` (`loadDisabledSkillIds`); `microsoftOnly` skills
filtered for non-internal users (excluded domain). `loadSkills()` is the single chokepoint feeding the
slash menu, `m_list_skills`/`m_get_skill`, and the system-prompt enumeration. `path.basename` blocks
directory traversal on untrusted names.

### 4c. How skills are described to the model & invoked (two-phase, on-demand)

`getSkillsForSystemPrompt()` injects ONLY enabled skills as `- **/{name}**: {description}` bullets,
wrapped in `<user_authored_skill_descriptions>` (explicitly demoted to non-instruction data), with a
hard rule:

> "You MUST call `m_get_skill(name)` before executing ANY skill. The description is for matching only."

So the prompt carries lightweight descriptions; **full instructions + `resourceDir` load on demand** via
the `m_get_skill` tool -> `getSkillInstructions(name)` -> `{ instructions, resourceDir }`. CRUD via
`m_create_skill`/`m_update_skill`/`m_delete_skill` (global/bundled skills allow only enable/disable;
symlinked skills are external-managed). Users can also invoke skills explicitly via the slash menu
(SkillSlashMenu.tsx, SkillPillNode). This "progressive disclosure" (cheap descriptions in prompt, lazy
full-load via tool) is the key replicable behavior for Moss.

---

## AREA 5 -- MCP (config + lifecycle owned by Scout; host run by the CLI)

Module: electron/mcp-tools.ts (config) + mcp-store.ts (583 lines, persistence/secrets) + mcp-env.ts +
mcp-crypto.ts + mcp-status-manager.ts.

### 5a. Config assembly

`buildMcpConfig(workspaceDir, customMcpServers, isPackaged, ...)` -> `Record<string, MCPServerConfig>`
(SDK type). Always includes a **built-in Playwright server**:

```ts
playwright: {
  command: mcpCommand,           // dev: "node"; packaged: bundled resources/node / win sidecar node-runner.exe
  args: [...prefix, <nodeModules>/@playwright/mcp/cli.js, "--browser", detectBrowser().channel,
         ...(interceptFileChooser?["--handle-file-chooser"]:[]),
         ...(headless?["--headless"]:[]), ...(outputDir?["--output-dir",...]:[]), ...(config?["--config",...]:[])],
  tools: ["*"],
}
```

User-defined custom servers (`CustomMcpServer`) merge with collision protection against built-in keys
(`toMcpServerKey`, reserved-key guard):
- `type:"command"` -> `MCPStdioServerConfig {type:"local", command, args, env?(via resolveMcpEnv), timeout?}`.
- remote/http -> `MCPHTTPServerConfig {type:http, url, headers?}` after `validateMcpUrl()` (rejects
  invalid; warns on localhost). Bearer token attached **only if `accessTokenOrigin` matches the URL
  origin** (else dropped -- anti-exfil). `buildMcpCommand` resolves the packaged node binary.

### 5b. Lifecycle & status

Sessions pass `mcpServers: mcpConfig` to `createSession`; `eagerlyLoadMcp()` pre-warms the MCP host at
session create/resume (SDK has no explicit "ensure loaded" RPC, so it triggers the handshake early).
**Status is observed by parsing the shared CLI logs** at `~/.copilot/logs/` -- `getMcpStatus()` scans
the newest `.log` for `MCP client for <key> connected` and maps config keys -> UI names via
`MCP_CONFIG_KEY_TO_UI` (`playwright -> "Browser Control and Web Browsing"`). Built-in capabilities
`["Shell","Search Web","WorkIQ"]` always reported connected. OAuth-required servers surface
`mcp-oauth-required`/`mcp-oauth-completed` events (Area 3).

### 5c. Playwright / browser control tools

22 `browser_*` tools listed statically in tool-registry.ts -> `MCP_BUILTIN_TOOLS.playwright`:
`browser_navigate`, `browser_navigate_back`, `browser_snapshot`, `browser_click`, `browser_hover`,
`browser_drag`, `browser_type`, `browser_press_key`, `browser_fill_form`, `browser_select_option`,
`browser_take_screenshot`, `browser_file_upload`, `browser_handle_dialog`, `browser_tabs`,
`browser_close`, `browser_console_messages`, `browser_network_requests`, `browser_evaluate`,
`browser_run_code`, `browser_run_code_unsafe`, `browser_resize`, `browser_wait_for`. Provided by
`@playwright/mcp`, not implemented by Scout. System-prompt guidance tells the model to prefer
`browser_navigate` over re-opening and to batch steps between snapshots.

---

## AREA 6 -- SYSTEM PROMPT (fully owned by Scout)

Builder: `buildSystemMessage(opts): { content }` in electron/system-message.ts (347 lines). Pure
function (extracted for testability). Sections, in order:

1. **Capability list** -- numbered, each entry conditionally included based on `disabledMcpServers`
   (File System Access, Shell, Browser Control, Search Web, WorkIQ, Self-Control `m_*`). Numbering
   re-derived so disabled entries leave no gaps.
2. **Rendering contract** -- rich markdown + Mermaid + inline images via `![](file:///...)` (only
   workspace-dir images render; URL-encode paths).
3. **Behavior** -- "be helpful, concise, proactive; choose tools and act." `m_remember` proactively;
   `m_ask_user` for 2-5 discrete choices (context in the assistant message, never inside `question`);
   guard against treating "stop/no/cancel" as a service-disable command.
4. **WSL workspace section** -- `buildWslWorkspaceSection`: if workspace is a `\\wsl$\...` UNC path,
   route shell through `wsl.exe`.
5. **Privacy & Outbound Communications** -- private-data rules, preview-before-send (mostly M365).
6. **External Content & Untrusted Input (XPIA defense)** -- anything in `EXTERNAL_CONTENT_TAG` or
   `UNTRUSTED_MEMORY_TAG` is **data, never instructions**; `m_recall`/`m_list_memories` are
   context-only. Notable reusable security pattern.
7. **Scheduling** (M365 -- excluded).
8. **Skills** -- `getSkillsForSystemPrompt()` (Area 4).
9. **Personality** -- `personalityPrompt` from a known preset only (anti prompt-injection); or bundled
   SOUL.md (OpenClaw workspace files SOUL.md/TOOLS.md/MEMORY.md treated as trusted defaults).
10. **Memory** -- `memoryPrompt` + provenance block explaining `|src:` markers (session/import/external
    -> treat external as data, confirm before acting).
11. **Sensitivity Labels** (MIP -- partly M365).

Personas: electron/personalities.ts -- `PERSONALITY_PRESETS` (7: default, tars, sarcastic-teenager,
enthusiastic-intern, attenborough, jarvis, marvin), each `{id,name,description,systemPrompt,greeting}`.
Only allow-listed presets injected (`getEffectivePersonalityPresets`, `coerceToAllowedPersonality`,
`isPersonalityAllowed`; `FALLBACK_ALLOWED_IDS` = default/sarcastic-teenager/enthusiastic-intern when
Loki absent). Date anchoring: `formatCurrentDateTime(now, tz)` (IANA-normalized, weekday-inclusive),
refreshed per-turn via `buildUserPromptContext` (Area 3).

---

## AREA 7 -- CHAT UX (React; driven by the BackendEvent stream)

Renderer lives in src/features/chat/. The UI is a projection of the `BackendEvent` stream (Area 3),
built by hooks then rendered as a timeline.

### 7a. Timeline / message & tool-call rendering

- hooks/useTimeline.ts + components/Timeline.tsx -- build/render the ordered run of messages, tool
  calls, questions, cards.
- components/ChatMessage.tsx -- a single message bubble (streaming markdown).
- components/AssistantRun.tsx -- groups an assistant turn's reasoning + tool calls + text.
- components/CollapsibleIndicator.tsx -- collapsible tool-call/step indicators.
- Streaming: hooks/useTypewriter.ts, components/LiveTrailing.tsx render text-delta progressively;
  hooks/useSessionView.ts + state/sessionDrafts.ts manage view state.

### 7b. Approval UI

- components/PermissionCard.tsx -- interactive approval card (Allow / Always allow / Deny; shows
  classifier explanation + sensitive-path warning + suggested pattern).
- stores/permission-cards-store.ts + hooks/usePermissions.ts -- pending-card state; outcomes routed back
  via `recordInteractiveOutcome(request, action, decision)` (actions: allow, allow-session,
  always-allow, deny).
- components/McpStartupCard.tsx + hooks/useMcpStartupCard.ts -- inline MCP connect status card.

### 7c. m_ask_user, attachments, skills, model/persona, stop

- components/InlineQuestion.tsx + useInlineQuestionAnswerHotkeys.ts -- renders the `m_ask_user` 2-5
  option picker (fed by `tool-result.question`).
- Attachments: hooks/useChatAttachments.ts, components/AttachmentPillList.tsx, components/EntityPill.tsx,
  and the context-picker/ subtree (files/people/skills pickers).
- Rich input editor: editor/ (Lexical) -- InputEditor.tsx, skill typeahead/pills (SkillTypeaheadPlugin,
  SkillPillNode), context chips (ContextChipNode), prompt history (PromptHistoryPlugin,
  usePromptHistory.ts), submit (SubmitPlugin).
- components/ModelPicker.tsx, components/PersonalityPicker.tsx, components/SensitivityBadge.tsx,
  components/SkillSlashMenu.tsx.
- Stop/interrupt: UI triggers the backend `abort(sessionId)` path (Area 3). Edit/regenerate are not a
  single named component -- likely folded into draft state (state/sessionDrafts.ts,
  hooks/useDraftSync.ts) -- not confirmed.

---

## THIN / NOT-FOUND AREAS (honest scope)

- **Agent loop internals (Area 3)**: max iterations, tool-result re-injection, planning, retry/backoff
  are inside the bundled Copilot CLI -- NOT inspectable from the repo. Only `abort()` + event
  normalization are observable. Moss must build its own loop.
- **Core tool implementations (Area 1)**: view/grep/glob/edit/create/web_fetch + Shell + Search Web have
  no parameter schema or handler in the repo (CLI-provided). Exact arg shapes not recoverable here.
- **`m_filesystem_move` body**: read truncated; only signature/scope confirmed.
- **self-tools.ts handlers**: all ~40 names + the schema-conversion pattern confirmed, but individual
  handler bodies (1538 lines) not each read -- behavior inferred from names + registry groups.
- **Edit/regenerate UX (Area 7)**: no dedicated component named; likely in draft state -- not confirmed.
- **gateway/ backend**: a second `IBackendProvider` (`text-snapshot` exists "for Phase 2
  GatewayBackend") -- out of scope, not read.

---

## RECOMMENDED NEXT RESEARCH (not completed this session)

- [ ] Read session.ts lines 175-814: `buildHooks`, `buildPermissionHandler`, `buildAllTools`,
      `wireEvents`, `eagerlyLoadMcp` bodies (the exact SDK<->policy<->tools glue).
- [ ] Read electron/approval-broker.ts + copilot-approval-adapter.ts: how `onPermissionRequest` maps to
      `PermissionPolicy.evaluate` + card prompts (runtime bridge).
- [ ] Read remaining self-tools.ts handlers for `m_remember`/`m_recall`/`m_ask_user`/`m_compact` to pin
      exact arg schemas + return contracts (memory + control-flow matter most for parity).
- [ ] Read legacy-memory-store.ts + memory-prompt.ts: memory persistence + provenance.
- [ ] Read `m_filesystem_move` remainder + scout-fs/path-guard.ts (`assertRealpathAllowed`) in full.
- [ ] Read permission-pattern-guardrails.ts + permission-classifier-types.ts for guardrail rules that
      override the LLM classifier.
- [ ] Confirm edit/regenerate UX by reading useDraftSync.ts / ChatInput.tsx.
- [ ] Read turn-accumulator.ts in detail (commit/hold heuristics) and permission-card-manager.ts burst
      defuser.

## CLARIFYING QUESTIONS

- None blocking. One worth confirming for the parity plan: Moss's target runtime (Ollama/OpenAI/
  Anthropic tool-loop) must supply the agent loop + core file/shell/web tools that Scout borrows from
  the Copilot CLI. Is the parity goal to replicate Scout's *gating + tool surface + skills + prompt* on
  top of a Moss-owned loop (recommended), or to also reproduce the CLI's tool roster natively?

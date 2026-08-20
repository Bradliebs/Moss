---
title: Moss
description: A local-first agentic desktop harness for completing and verifying work across files, commands, browsers, and desktop applications
author: Moss contributors
ms.date: 2026-08-20
ms.topic: overview
keywords:
  - ai agent
  - electron
  - ollama
  - model context protocol
  - desktop automation
estimated_reading_time: 8
---

<p align="center">
  <img src="./build/icon.png" alt="Moss logo" width="180">
</p>

## Overview

Moss is a local-first desktop AI harness built to carry tasks from request to
verified completion. It combines streamed model conversations with durable task
state, workspace tools, browser and desktop automation, reusable skills,
persistent memory, and Model Context Protocol (MCP) integrations.

Moss can connect to a local Ollama server, the Anthropic Messages API, or an
OpenAI-compatible endpoint such as OpenAI, LM Studio, vLLM, Groq, or OpenRouter.
The selected model must support the behavior required by the task. Models vary
substantially in tool use, instruction following, and context capacity.

> [!IMPORTANT]
> Moss can execute commands and modify files. Select a dedicated workspace,
> review approval requests, and keep backups or source control enabled.

## Highlights

* Runs multi-step tasks through an explicit, recoverable lifecycle
* Requires task evidence and configured verification before claiming completion
* Reads, writes, searches, and checkpoints files inside the selected workspace
* Runs shell commands with risk classification and approval controls
* Uses isolated, domain-allow-listed Playwright browser sessions
* Automates allow-listed Windows applications through semantic UI Automation
* Connects to local or remote MCP servers over standard I/O or HTTP
* Stores durable memories and reusable skills between conversations
* Indexes a codebase through a configurable embeddings endpoint
* Supports image and text attachments, dictation, and optional email delivery
* Streams safe GitHub-flavored Markdown with highlighted, copyable code
* Tracks token usage, context consumption, estimated cost, and tool history
* Persists multiple independent conversations with search and management controls
* Supports conversation-specific personalities and memory-informed adaptive tone
* Evaluates runtime and prompt variants through isolated, resumable task matrices

## Requirements

* Windows 10 or Windows 11 for the packaged application and desktop automation
* Node.js 20 or later
* npm
* At least one supported model provider

Ollama users need a running Ollama installation and at least one downloaded chat
model. The default provider URL is `http://localhost:11434/v1`.

## Quick start

Install dependencies, build the main process and renderer, then launch Electron:

```powershell
npm install
npm run dev
```

On Windows, you can also use the launcher, which stops stale Electron processes,
rebuilds the application, and starts Moss:

```powershell
.\start.bat
```

After the application opens:

1. Open **Settings**.
2. Select Ollama, OpenAI, Anthropic, or Custom.
3. Enter the provider URL and API key when required.
4. Refresh the model list and select a model.
5. Choose a workspace before enabling file or command tools.
6. Configure optional verification commands for coding tasks.
7. Start a conversation and describe the outcome you want.

## Conversation management

Each conversation keeps its own message history and personality override. Moss
persists conversations locally, restores the selected conversation after a
reload, and derives a title from the first user message.

Use the left sidebar to create, search, select, rename, export, copy, or delete
conversations. In a compact window, open the same conversation list from the
menu button in the chat header. Creating or selecting a conversation closes the
compact list and displays that conversation's history.

The **Clear** action removes messages from the selected conversation while
keeping its entry. **Continue in new chat** creates a separate conversation with
a bounded summary of the current context and leaves the original unchanged.

When a configured context window approaches its input budget, Moss summarizes
the oldest model-facing turns into a bounded assistant-authored note. The
summary call cannot use tools, excludes raw tool output and arguments, and is
counted in token usage. If summarization fails, Moss falls back to deterministic
trimming. Saved conversation history is never changed. Provider-reported
context overflow uses the same compaction path for one retry.

Large tool results remain complete in saved conversation history and the live
tool card. To protect model context, Moss stores an oversized result as an
opaque application artifact and sends the model a bounded head-and-tail preview
with an artifact ID. The read-only `read_tool_output` tool can retrieve another
range or search the stored text without exposing its host path. Artifacts are
kept outside the selected workspace and are pruned after seven days or when the
store exceeds 200 records.

## Provider configuration

| Provider | Kind | Default base URL | API key |
|----------|------|------------------|---------|
| Ollama | OpenAI-compatible | `http://localhost:11434/v1` | Not normally required |
| OpenAI | OpenAI-compatible | `https://api.openai.com/v1` | Required |
| Anthropic | Anthropic | `https://api.anthropic.com` | Required |
| Custom | OpenAI-compatible | User supplied | Provider dependent |

Custom OpenAI-compatible servers must expose model listing and chat completion
endpoints compatible with `/models` and `/chat/completions`.

### Optional endpoints

Moss can reuse the active provider connection for several optional services, or
you can configure dedicated endpoints in Settings:

* Speech-to-text through an OpenAI-compatible `/audio/transcriptions` endpoint
* Codebase embeddings through an OpenAI-compatible `/embeddings` endpoint
* Email delivery through Resend with a verified sender address

## Task execution

A durable Moss task records its objective, acceptance criteria, execution steps,
attempts, evidence, blockers, and current state. The runtime persists this state
so interrupted work can be inspected and resumed instead of silently discarded.

The task lifecycle includes planning, execution, verification, recovery, pause,
resume, cancellation, failure, and evidence-gated completion. Verification can
combine task-specific evidence with newline-separated commands configured in
Settings, such as tests, type checks, or builds.

When a turn changes files, Moss creates a checkpoint. The response footer shows
the changed-file count and provides a revert action while the checkpoint remains
available.

### Durable approvals and task history

Approval requests for durable tasks are persisted before Moss waits for a
decision. The record correlates the task, turn, and tool call, and the renderer
can attach an optional reason to an approval or denial. Moss persists the
decision before releasing the waiting runner, so a displayed task state does not
claim that approval is pending after execution has begun.

An unresolved approval cannot be bypassed through the generic Resume action. If
the application or renderer stops while a decision is pending, Moss records the
approval as interrupted and pauses the task. Resuming creates a new model
attempt; Moss never replays the interrupted tool call automatically.

Each task also exposes an ordered, read-only timeline derived from its append-only
journal. The renderer receives concise transitions, attempts, approval outcomes,
and evidence results. Raw snapshots, tool arguments, approval comments, model
output, and evidence summaries are excluded from this history projection.

### Agent execution design

Moss applies selected ideas from [12-Factor Agents](https://github.com/humanlayer/12-factor-agents),
[Agent Control Plane](https://github.com/humanlayer/agentcontrolplane), and
[HumanLayer](https://github.com/humanlayer/humanlayer) without adding those
runtimes as dependencies. The shared principles include explicit control-flow
ownership, structured tool calls, compacted context, persisted approval state,
human feedback, restart reconciliation, and an observable event timeline.

Moss remains a local, single-process desktop application. Per-task serialization,
revision checks, atomic snapshots, and the append-only journal provide the
coordination required in that environment. The project does not adopt Kubernetes
controllers, custom resources, distributed leases, remote approval channels,
webhook triggers, or a separate agent daemon. Those mechanisms become relevant
only if multiple processes or machines can advance the same task.

## Tools and integrations

### Workspace tools

Workspace tools can inspect directories, search source, read and write files,
apply patches, and run commands. Path validation keeps file operations inside the
selected workspace. Command operations are classified as read-only, mutating, or
destructive before execution.

Tools that explicitly support cooperative cancellation can declare an execution
deadline. Moss aborts the tool at that deadline and waits for its cleanup to
settle before reporting a timeout. Tools that do not declare this capability do
not receive a generic deadline that could abandon work in the background.

During one turn, Moss also tracks consecutive calls with the same tool name and
canonical arguments. At increasing thresholds it adds an advisory to the
model-facing result, prompting the model to inspect prior evidence or change its
approach. The advisory does not block the call or alter the result retained in
conversation history.

### Browser automation

Browser automation uses Playwright sessions scoped to a durable task. It can
navigate, inspect accessibility or text content, interact with controls, capture
screenshots, and assert page state. Navigation is limited to explicitly allowed
domains, including redirects and subsequent requests.

Enable browser automation and add allowed hostnames in Settings before use.

### Desktop automation

Desktop automation uses Windows UI Automation rather than unrestricted screen
coordinates. Sessions are restricted to configured process names and exact
window titles. Supported operations include semantic inspection, control
interaction, text entry, option selection, screenshots, and state assertions.

Enable desktop automation and configure both process and window allowlists in
Settings before use.

### Model Context Protocol

Moss can connect to MCP servers using standard I/O or HTTP transports. The
Library and Settings surfaces expose server status and management, while the
runtime adapts MCP tool names to provider-safe identifiers.

Server configuration may include commands, arguments, working directories,
environment variables, URLs, and headers. Treat third-party MCP servers as code
with the same access as the account running Moss.

### Memory and skills

Memory stores durable facts and preferences for later conversations. Skills store
reusable instructions that the model can load when their descriptions match a
task. Both can be reviewed and managed from the Library.

Use **Import folder** in the Library to recursively install directories that
contain `SKILL.md` files. Moss preserves supporting files and license documents,
skips existing skill IDs, and leaves imported skills disabled until you review
and enable them. Supporting text files are available to enabled skills through
the skill-resource tool without granting access outside the skill directory.

Adaptive tone uses remembered preferences to adjust wording, formality, and
detail without replacing the selected personality or built-in safety guidance.

## Safety model

Moss separates reversible work from actions that can create external or
irreversible effects.

* Retrieved files, command output, web pages, and tool results are treated as
  untrusted data rather than instructions
* File paths are resolved inside the configured workspace
* Browser destinations are checked against a domain allowlist
* Desktop sessions require process and window allowlists
* Tool approvals are tied to runtime call identity instead of model-authored text
* Destructive commands and final browser or desktop actions require approval
* Verification failures prevent successful task completion
* Run journals and learned patterns are sanitized before persistence

Auto-approval can reduce prompts for eligible reversible actions. It does not
bypass controls for irreversible operations.

## Response experience

Assistant responses render sanitized GitHub-flavored Markdown. Raw model HTML is
not executed. Safe links open through the Electron shell bridge, and fenced code
uses a curated set of lazily loaded Shiki grammars.

The response surface supports headings, nested lists, task lists, tables,
blockquotes, inline code, highlighted code blocks, copy controls, regeneration,
checkpoint reversion, token details, and a streaming indicator. User messages
remain compact bubbles while assistant responses use a wider document layout.

## Development commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Build both application layers and launch Electron |
| `npm run dev:renderer` | Start the Vite renderer server without Electron preload APIs |
| `npm run start` | Launch Electron from existing build output |
| `npm run typecheck` | Type-check the renderer and Electron projects |
| `npm test` | Run the Vitest test suite once |
| `npm run test:deterministic` | Run the deterministic CI test tier |
| `npm run eval -- dry-run scripts/eval-pilots.cjs` | Validate the evaluation matrix without invoking a model |
| `npm run eval:health` | Validate corpus, reference solution, and grader publication health |
| `npm run build` | Build the Electron main process and Vite renderer |
| `npm run pack` | Create an unpacked application directory |
| `npm run dist` | Build a Windows NSIS installer |

The renderer alone expects APIs injected by `electron/preload.cjs`. Running
`npm run dev:renderer` in a normal browser is useful for targeted UI work only
when those APIs are mocked.

## Project structure

```text
common/                  Shared IPC contracts, types, logging, and personalities
electron/
  backend/moss/          Agent runtime, tools, tasks, providers, and persistence
  ipc/                   Main-process IPC handlers
  main.ts                Electron composition root
  preload.cjs            Restricted renderer bridge
src/
  components/            React application surfaces
  lib/                   Renderer stores, formatting, pricing, and utilities
docs/                    Design notes and operational checklists
scripts/                 Repository maintenance utilities
```

The main process owns provider calls, tools, durable tasks, MCP connections, and
privileged operating-system access. The React renderer communicates through the
typed preload and IPC contracts instead of importing Node.js APIs directly.

## Testing

Run all checks used for normal development:

```powershell
npm run typecheck
npm test
npm run build
```

Tests cover renderer behavior, IPC, providers, tool execution, permissions,
approvals, checkpoints, capability acquisition, browser and desktop boundaries,
task recovery, verification, memory, skills, learning, and the evaluation harness.

The evaluation harness runs production-loop tasks in isolated workspaces and
grades their end state with independent validators. It supports governed corpus
splits, repeated baseline comparisons, confidence-aware release policy,
sanitized traces, failure attribution, resumable concurrent matrices, portable
dataset exchange, and opt-in container execution for external terminal tasks.
See the [harness feedback loop guide](docs/harness-feedback-loop.md) for corpus
selection, provider runs, report inspection, resume behavior, and CI tiers.

## Packaging

Create an unpacked Windows build:

```powershell
npm run pack
```

Create the NSIS installer:

```powershell
npm run dist
```

Build artifacts are written to `release/`. The installer is per-user by default,
supports a custom installation directory, and packages the application in an
ASAR archive.

## Troubleshooting

### No models appear

Confirm the provider is running, the base URL is correct, and the API key is
valid. For Ollama, verify the model has been pulled locally before refreshing the
model list.

### The renderer is blank in a browser

Launch Moss with `npm run dev` or `npm start`. The application depends on the
Electron preload bridge and is not designed to run as a standalone website.

### A task cannot use files or commands

Choose a workspace in Settings and confirm tools are enabled. Operations outside
that workspace are rejected by design.

### Browser navigation is denied

Add the destination hostname to the browser domain allowlist. Every redirect and
request must remain within the configured set.

### Desktop controls are unavailable

Desktop automation requires Windows, an allowed process name, an exact allowed
window title, and controls exposed through Windows UI Automation.

### A task remains blocked after a failed check

Inspect the task status and evidence, correct the underlying failure, then use
the Resume action. Moss does not convert failed verification into completion.

## Additional documentation

* [Chat checkpoint design](docs/chat_checkpoint.md)
* [Electron 42 GUI smoke checklist](docs/e42-gui-smoke-checklist.md)
* [Electron Builder 26 upgrade notes](docs/electron-builder-26-upgrade.md)
* [Harness feedback loop](docs/harness-feedback-loop.md)
---
title: E42 Runtime GUI Smoke Checklist
description: Packaged and live-provider smoke checks for the Moss Electron application
ms.topic: how-to
---

<!-- markdownlint-disable-file -->

## Scope

The automated gate launches the unpacked Windows executable with isolated user
data and verifies the Mission intake through the packaged main process, preload,
and renderer. The live-provider pass still needs an interactive window, a real
provider, and a human watching tool effects and native authorization prompts.

Run both before tagging a release or after changes to the turn loop, mission
runtime, IPC contract, preload bridge, or renderer event handling.

## Automated package gate

Build the unpacked app and run its Playwright Electron smoke:

```powershell
npm run pack
npm run smoke:packaged
```

If Windows blocks electron-builder's signing-helper symlinks, create an unsigned
local smoke package without changing the release configuration:

```powershell
npm run build
npx electron-builder --dir --config.win.signAndEditExecutable=false
npm run smoke:packaged
```

The smoke passes when `Moss.exe` loads and the Chat/Mission selector, mission
review surface, and all four budget controls render through the packaged bridge.

## Prerequisites

- Ollama (or another OpenAI-compatible endpoint) running locally and reachable,
  for example `ollama serve` with at least one pulled model (`ollama pull llama3.1`).
- A clean build: `npm run build`.
- Launch the app: `npm start` (loads `dist-electron/electron/main.js` + `dist/index.html`).

## Smoke steps

1. **Provider setup**
   - Open Settings, enter the base URL (`http://localhost:11434/v1` for Ollama),
     and confirm the model dropdown populates from the provider.
   - Select a model; confirm the header shows the model name.

2. **Plain chat (tools off)**
   - Disable tools in Settings.
   - Send "Say hello in one word." Confirm streamed text appears token by token
     and the turn ends without a tool card.

3. **New chat titling (regression for the sidebar fix)**
   - Click "+ New chat". Confirm the new row reads "New chat".
   - Send a first message. Confirm the sidebar row title updates to the message
     text immediately on send (not only after the turn completes), truncated near
     40 characters with an ellipsis for long input.
   - Reload the window (Ctrl+R). Confirm the title persists.

4. **Tool approval gate (auto-approve off)**
   - Enable tools, leave auto-approve off, set a workspace root.
   - Ask the model to read a file in the workspace. Confirm a tool card appears
     with "Approval required", Approve and Deny buttons.
   - Click Approve. Confirm the tool runs and the result renders.
   - In a fresh turn, trigger another gated tool and click Deny. Confirm the
     result shows a denial and the turn continues.

5. **Auto-approve provenance (regression for the inline auto tag)**
   - Enable auto-approve. Confirm the amber "Auto-approving tools" badge shows in
     the header.
   - Ask the model to write a file. Confirm the tool runs without a prompt and the
     tool card shows the inline "auto" tag next to the tool name.
   - Reload the window. Confirm the reloaded tool card still shows the "auto" tag
     (provenance persisted through the session store).
   - Confirm a read-only/allow-listed tool (e.g. read_file) does NOT show "auto".

6. **Abort mid-turn**
   - Start a long generation and click Stop. Confirm the turn ends with "Aborted"
     and the Send button returns.

7. **Dictation (if a Whisper endpoint is configured)**
   - Click Mic, speak, stop. Confirm transcribed text lands in the input box.

8. **Session switching**
   - Create two conversations, switch between them via the sidebar, and confirm
     each shows its own history and the selected row is highlighted.

9. **Supervised read-only mission**
   - Select Mission and open Review mission.
   - Keep Supervised selected and choose only read-only repository capabilities.
   - Launch a repository inspection objective. Confirm no native authorization
     appears, the plan revision and worker role render, and deterministic
     evidence is attached to the acceptance criterion before completion.

10. **Supervised file mutation**
    - Keep Supervised selected and add a file mutation capability.
    - Launch a bounded file change. Confirm the concrete tool card requests
      approval before the write and denial prevents the mutation.
    - Approve a fresh attempt. Confirm the admitted artifact and verification
      evidence appear in Mission details.

11. **Policy-scoped bounded mutation**
    - Select Policy-scoped, set positive time, token, action, and cost budgets,
      then launch a bounded file change.
    - Confirm the native dialog names the objective and authority scope.
    - Cancel once and confirm no task launches and the draft remains. Launch
      again, approve, and confirm usage never exceeds the reviewed budgets.

12. **Mission interruption and recovery**
    - Close or reload the renderer while a mutation approval is pending. Confirm
      the task pauses, the approval becomes interrupted, and the call is not
      replayed after resume.
    - Interrupt a mission while read-only workers are active. Confirm active
      workers settle, their step leases clear, and no dependent exclusive step
      starts until a deliberate resume creates fresh attempts.

## Pass criteria

- No uncaught errors in the main-process console or the renderer devtools.
- Streaming, tool approval, auto-approve provenance, abort, titling, and mission
  authority behave as described above.
- Reload preserves session history, titles, task state, and the "auto" provenance
  tag without replaying an interrupted action.

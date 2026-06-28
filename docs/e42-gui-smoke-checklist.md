<!-- markdownlint-disable-file -->
# E42 Runtime GUI Smoke Checklist

A manual pass that exercises Moss end to end against a live model. It cannot run
in CI or an autonomous agent: it needs an interactive window, a real provider,
and a human watching the screen. Run it before tagging a release or after any
change to the turn loop, IPC contract, or renderer event handling.

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

## Pass criteria

- No uncaught errors in the main-process console or the renderer devtools.
- Streaming, tool approval, auto-approve provenance, abort, and titling all behave
  as described above.
- Reload preserves session history, titles, and the "auto" provenance tag.

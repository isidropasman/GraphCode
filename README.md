# GraphCode

A GUI-native, voice-first development environment where **AI agents execute and humans understand, direct, and decide**.

You open a real Git repository and state an objective by typing or speaking. GraphCode runs Codex on it in an isolated worktree and shows the work as it happens. Afterwards you see what changed, the decisions and assumptions behind it, what evidence supports it, and what is still unknown. You can ask questions about the result, run real verification, and commit only after you have reviewed the change.

> v0. See [docs/implementation-status.md](docs/implementation-status.md) for exactly what is verified.

## Layout

```
packages/protocol   Zod domain model, versioned events, pure reducer, typed RPC contract, voice intent router
apps/runtime        Local Node.js runtime: SQLite event store, Git worktrees, Codex App Server adapter,
                    verification, understanding engine, transcription, WebSocket RPC
apps/desktop        React + Vite GUI (Zustand, XYFlow, Monaco) and Tauri 2 shell (src-tauri)
docs/               architecture, decisions, protocol, implementation status
```

## Requirements

- Node.js ≥ 22.13 (uses built-in `node:sqlite`), pnpm 10
- Git ≥ 2.20
- Codex CLI (`npm i -g @openai/codex`), signed in (`codex login`) or `OPENAI_API_KEY` set for the runtime
- Optional: `OPENAI_API_KEY` for speech-to-text (`GRAPHCODE_STT_MODEL`, default `gpt-4o-mini-transcribe`)
- Desktop shell only: Rust toolchain + Tauri 2 system deps (Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev`)

## Run

```bash
pnpm install

# Browser mode: runtime + GUI in two terminals
pnpm runtime          # ws://127.0.0.1:47120, state in ~/.graphcode
pnpm gui              # http://127.0.0.1:5173

# Desktop: Tauri shell (finds the running runtime, or spawns it detached)
pnpm desktop
```

Environment: `GRAPHCODE_HOME` (data dir), `GRAPHCODE_PORT`, `GRAPHCODE_CODEX_BIN`, `GRAPHCODE_VERIFY_TIMEOUT_MS`.

## Test

```bash
pnpm typecheck
pnpm test        # includes a real Codex App Server handshake when `codex` is installed
```

## Using it

1. **Project Home**: open a repository path (or Browse… in the desktop app). You see its branch, HEAD, dirty state, languages, recent commits and declared test commands.
2. **Objective**: write what should change and add constraints. *Start with Codex* creates branch `graphcode/<slug>-<id>` in `~/.graphcode/worktrees/` and starts a Codex turn there.
3. **Execution**: stage rail, plan steps, commands with exit codes, file edits, and live output. Codex approval requests appear as cards. Only a click can accept them. Interrupt any time; raw events are available on demand.
4. **Decisions & Understanding**: the agent's decisions with alternatives, assumptions and file references, labeled *Agent claim / Reconstructed after run*. Accept or reject each one, ask questions (answered by a read-only Codex turn), and browse concepts and a map of changed files with their observed imports.
5. **Review**: changes grouped by category, an exact diff in Monaco, risks and unknowns, the evidence list with provenance, verification commands run in the worktree, and a two-step *Approve & commit* (never pushes or merges).

**Voice**: hold the mic button, or hold `` ` `` / Ctrl+Space. The transcript stays editable. Navigation commands ("show what changed", "what could break", "go back") run immediately. Questions and changes wait for you to confirm. Voice can never approve, commit, merge, push or delete. The same bar also accepts typed commands.

Provenance badges: **Observed** (GraphCode saw it) · **Reported by Codex** · **Agent claim** · **Derived** (deterministic from observed data) · **You**.

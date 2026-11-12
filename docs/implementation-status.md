# Implementation status (v0)

Environment used for verification: Ubuntu 22.04, Node 24.22, pnpm 10.34, Git 2.56, Codex CLI 0.167.2, Rust 1.99.

## Implemented and tested

| Area | How it was verified |
|---|---|
| Domain schemas, events, reducer (replay, duplicate/out-of-order events, approval expiry, phase derivation, decision reviews kept across regeneration) | `packages/protocol/test/reducer.test.ts` |
| Voice intent routing, including blocking approve/merge/commit/push/delete for voice and requiring confirmation for mutations | `packages/protocol/test/intents.test.ts` |
| Orchestration end to end with a **scripted test provider**: open repo → inspect → task → worktree → run → change capture → understanding (agent decisions tagged `after_run`, unmatched command claims → verification gap, no-test-changes risk) → real `npm test` verification pinned to tree → read-only question run in same thread → decision review → commit on task branch (main untouched) → restart & replay | `apps/runtime/test/orchestrator.test.ts` |
| Restart recovery: runs active at shutdown become *interrupted* with a reason | same |
| Refusal to create worktrees in repos with no commits | same |
| Git helpers (hunk parsing, categorization, import extraction), Codex item/plan translation | `apps/runtime/test/git.test.ts` |
| **Real Codex App Server** handshake: spawn, `initialize`/`initialized`, `account/read`, version | `apps/runtime/test/codex.integration.test.ts` (runs when `codex` is installed) |
| Real Codex turn up to the model call: over live RPC, `thread/start` returned a real thread id and `turn/start` ran; Codex's retry notifications became warnings; the 401 (no credentials) became a failed run with Codex's exact error; worktree, change capture and understanding regeneration still ran | manual smoke against the running runtime (not in CI) |
| Typecheck of all packages, production GUI build, Tauri shell `cargo build` | `pnpm typecheck`, `pnpm --filter @graphcode/desktop build`, `cargo build` in `apps/desktop/src-tauri` |

## Implemented but unverified

- **A completed Codex turn**: plan updates, command/file items, approval requests and their accept/decline responses, structured final message parsing from real Codex output, `turn/interrupt`. Blocked because no OpenAI credentials were available in the build environment (`account/read` → `requiresOpenaiAuth: true`). The payload shapes come from the generated bindings for the installed CLI, not from guesses.
- **Speech-to-text** (OpenAI `audio/transcriptions`): no API key available. The GUI shows *Voice · not configured* and disables the mic; typed commands use the same router.
- **Microphone capture** in WebKitGTK (Tauri on Linux): MediaRecorder support varies by WebKitGTK build.
- **Tauri window at runtime**: the shell compiles. Launching the window, the native folder dialog, and spawning the runtime from the shell were not exercised.
- Text-to-speech uses the Web Speech API when present (feature-detected).

## Mocked / simulated

- `ScriptedProvider` in `apps/runtime/test/orchestrator.test.ts` exists only in tests. The product never uses it, and nothing in the GUI is simulated.

## Not implemented

- Agent providers other than Codex (the `AgentProvider` interface is in place).
- Reattaching to a live Codex turn after the runtime restarts (marked interrupted instead).
- Decisions captured *during* a run (Codex emits no decision events, so all are `after_run`).
- Semantic/call-graph analysis beyond relative imports; non-JS/TS/Python import parsing.
- Merging/pushing, PR creation, worktree cleanup UI.
- Packaged installers (bundle disabled), signing, auto-update.
- Multi-user, cloud, billing, collaboration (out of scope for v0).

# Architecture

GraphCode v0 is three processes plus one external agent:

```
Tauri 2 shell (apps/desktop/src-tauri)        thin: finds or spawns the runtime, native dialogs
  └─ React GUI (apps/desktop/src)             views + Zustand view state, no durable state
        │  WebSocket, typed RPC (packages/protocol/src/rpc.ts), token auth, loopback only
        ▼
Local runtime (apps/runtime)                  independent Node.js process
  ├─ RPC server (server.ts)                    validates every call with Zod
  ├─ Orchestrator (orchestrator.ts)            command handling, run lifecycle, recovery
  ├─ Event store (store.ts, db.ts)             SQLite event log = source of truth; in-memory projections
  ├─ Git / worktrees (git.ts)                  inspection, one worktree+branch per task, content-addressed snapshots
  ├─ Verification (verification.ts)            runs real commands with timeouts, captures exit code + output tail
  ├─ Understanding engine (understanding.ts)   agent claims + deterministic inferences + observed evidence
  ├─ Voice transcription (voice.ts)            replaceable provider; OpenAI by default
  └─ Agent provider registry (agents/types.ts)
        └─ Codex adapter (codex/*)             JSON-RPC over stdio to `codex app-server`
```

## Why the runtime is a separate process

Agent runs take minutes. Closing or reloading the window must not kill them, and a React
re-render must never be able to lose state. The runtime owns all durable state and all
child processes. The GUI is a projection client: it loads `TaskState` via `task.get`, then
applies the same pure reducer (`packages/protocol/src/reducer.ts`) to pushed events. If it
detects a sequence gap it reloads from the runtime.

The Tauri shell spawns the runtime in its own process group and reconnects to it through
`~/.graphcode/runtime.json` (URL, per-start token, pid). In browser mode the Vite dev server
serves that file to the GUI on loopback.

## State model

- Every state change is a versioned `DomainEvent` (`packages/protocol/src/events.ts`) appended
  to SQLite (`events` table, WAL mode) with a per-task sequence number.
- `TaskState` is derived by replaying events. Phase (`running`, `review`, …) is derived, never stored.
- Live token/output deltas are **not** persisted; the completed item that follows them is.
- On startup the runtime replays all events. Runs that were active when it stopped are marked
  `run.state_unknown` → shown as *interrupted* with the reason. GraphCode does not pretend to
  reattach to a Codex turn it no longer has a connection to.

## Isolation

Each task gets `git worktree add -b graphcode/<slug>-<id> ~/.graphcode/worktrees/<task>` from the
repository's current `HEAD`. The user's checkout and index are never touched (snapshots use a
temporary `GIT_INDEX_FILE`). A worktree is **not** a sandbox: Codex runs with its own sandbox
(`workspaceWrite` limited to the worktree for implementation, `readOnly` for questions) and
`approvalPolicy: on-request`; approvals are routed to the GUI and only a pointer/keyboard
action can accept them.

## Evidence and provenance

Every fact shown carries a `Provenance`:

| value | meaning | example |
|---|---|---|
| `observed` | GraphCode saw it itself | git diff, a verification command it ran, a commit you approved |
| `provider` | Codex reported it happened | a command execution item with exit code |
| `agent` | the agent claims it | rationale, alternatives, summary, an answer to a question |
| `inferred` | deterministic derivation from observed data | "source changed without test changes" |
| `user` | you said it | |

Code facts are pinned to a `Revision` = base commit + git tree object of the whole worktree.
A verification result is shown as stale ("older tree") as soon as the tree changes.

## Understanding engine

After each implementation run the runtime builds an `Understanding`:

1. Parses the agent's final message, which Codex is asked to return using a JSON output schema
   (`REVIEW_OUTPUT_SCHEMA`). Decisions are tagged `provenance: agent`, `captured: after_run`.
2. Cross-checks the agent's `commands_run` claims against command executions Codex actually reported.
   Unmatched claims become `verification_gap` risks.
3. Adds deterministic risks from the diff (no test changes, dependency/config changes, deletions)
   and from verification evidence (none, failed, stale).
4. Lists explicit unknowns (unparseable final message, unsupported import analysis, no changes).

User reviews of decisions are events and survive regeneration.

## Voice

Audio is captured in the GUI (MediaRecorder), sent to the runtime, transcribed by the
configured `TranscriptionProvider` (API key stays in the runtime), and routed by a deterministic
intent router (`packages/protocol/src/intents.ts`). Navigation intents act immediately; questions
and mutations wait for the user to confirm an editable transcript; approve/merge/commit/delete/push
and similar are blocked for voice entirely.

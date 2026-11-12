# Protocols

GraphCode has two protocol boundaries. Both are typed; neither leaks into the other.

## 1. GUI ⇄ runtime (GraphCode RPC v1)

Defined in `packages/protocol/src/rpc.ts`. JSON text frames over `ws://127.0.0.1:<port>/rpc`
(default port 47120).

Connection:
1. Runtime writes `~/.graphcode/runtime.json` (`0600`): `{ url, token, pid, startedAt, version }`.
2. Client sends `{ kind: "hello", token, protocolVersion: 1 }` within 5 s; server answers `welcome`.
   Wrong token or unauthenticated calls close the socket (4401). Only loopback / Tauri origins are accepted.
3. Calls: `{ kind: "call", id, method, params }` → `{ kind: "result", id, result }` or `{ kind: "error", id, error: { code, message } }`.
   Params are validated server-side with the method's Zod schema.
4. Push: `{ kind: "event", event: DomainEvent }` (persisted, sequenced) and `{ kind: "delta", delta: LiveDelta }` (ephemeral output).

Methods: `system.status`, `project.list|open|inspect`, `task.list|get|create|updateObjective|start`,
`run.interrupt|instruct`, `approval.respond`, `changes.refresh|file`, `verification.candidates|run`,
`question.ask`, `decision.review`, `integration.commit`, `voice.transcribe`.

Domain events (schema version 1, `packages/protocol/src/events.ts`): `task.created`,
`task.objective_updated`, `worktree.created|failed`, `run.started|bound|plan_updated|item_started|item_completed|warning|finished|state_unknown`,
`approval.requested|resolved`, `changes.captured`, `evidence.recorded`, `understanding.updated`,
`decision.reviewed`, `question.asked`, `integration.committed`.

## 2. Runtime ⇄ Codex App Server

The adapter (`apps/runtime/src/codex/`) speaks the protocol of the **installed** Codex CLI.
TypeScript bindings in `apps/runtime/src/codex/generated/` were produced by
`codex app-server generate-ts` from codex-cli **0.167.2** (`CODEX_VERSION`). Regenerate with
`scripts/generate-codex-protocol.sh`. On a version mismatch the runtime still runs and emits a warning.

Transport: `codex app-server` child process, newline-delimited JSON-RPC 2.0 over stdio
(`jsonrpc.ts`): request/response correlation by id with timeouts, notifications, server→client
requests, stderr tail kept for diagnostics, process exit fails all pending requests and active runs.

Calls used:

| purpose | message |
|---|---|
| handshake | `initialize` (clientInfo, `experimentalApi: false`) → `initialized` notification |
| auth state | `account/read` |
| new conversation | `thread/start` { cwd, approvalPolicy: "on-request", sandbox, developerInstructions } |
| continue (follow-ups, questions) | `thread/resume` { threadId, … } |
| run | `turn/start` { threadId, input, cwd, sandboxPolicy, outputSchema? } |
| stop | `turn/interrupt` { threadId, turnId } |

Notifications consumed: `turn/started`, `turn/completed`, `item/started`, `item/completed`,
`item/agentMessage/delta`, `item/commandExecution/outputDelta`, `item/reasoning/summaryTextDelta`,
`turn/plan/updated`, `error`, `serverRequest/resolved`. Unknown notifications are ignored.

Server requests handled: `item/commandExecution/requestApproval` and
`item/fileChange/requestApproval` → GUI approval card → `{ decision: "accept" | "decline" }`.
Any other server request is refused with a JSON-RPC error; nothing is auto-approved.

Normalization (`translate.ts`): Codex `ThreadItem` → provider-independent `WorkItem`
(`command`, `file_change`, `message`, `reasoning`, `plan`, `tool`, `web_search`, `other`).
The orchestrator and GUI never see Codex types, so another agent can be added by implementing
`AgentProvider` (`apps/runtime/src/agents/types.ts`).

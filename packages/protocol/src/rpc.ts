import { z } from "zod";
import { Objective, Project, QuestionContext, RepoInspection, Task, VerificationCandidate } from "./domain";
import { DomainEvent, LiveDelta } from "./events";

export const RPC_PROTOCOL_VERSION = 1;

const TaskStateSchema = z.custom<import("./reducer").TaskState>((v) => typeof v === "object" && v !== null && "task" in v);

export const CodexStatus = z.object({
  available: z.boolean(),
  version: z.string().nullable(),
  binary: z.string().nullable(),
  account: z.object({ type: z.string(), label: z.string().nullable() }).nullable(),
  requiresAuth: z.boolean(),
  error: z.string().nullable(),
});
export type CodexStatus = z.infer<typeof CodexStatus>;

export const VoiceStatus = z.object({
  provider: z.string().nullable(),
  configured: z.boolean(),
  reason: z.string().nullable(),
});
export type VoiceStatus = z.infer<typeof VoiceStatus>;

export const TaskSummary = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  phase: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  branch: z.string().nullable(),
});
export type TaskSummary = z.infer<typeof TaskSummary>;

const empty = z.object({}).strict();

/**
 * Every GUI → runtime call. Params are validated by the runtime; results are validated
 * by the client in development. Adding a method here is the only way to expose it.
 */
export const RpcMethods = {
  "system.status": {
    params: empty,
    result: z.object({
      runtimeVersion: z.string(),
      protocolVersion: z.number(),
      dataDir: z.string(),
      startedAt: z.string(),
      codex: CodexStatus,
      voice: VoiceStatus,
    }),
  },
  "project.list": { params: empty, result: z.array(Project) },
  "project.open": { params: z.object({ path: z.string().min(1) }), result: z.object({ project: Project, inspection: RepoInspection }) },
  "project.inspect": { params: z.object({ projectId: z.string() }), result: RepoInspection },
  "task.list": { params: z.object({ projectId: z.string().nullable() }), result: z.array(TaskSummary) },
  "task.get": { params: z.object({ taskId: z.string() }), result: TaskStateSchema },
  "task.create": { params: z.object({ projectId: z.string(), objective: Objective, start: z.boolean() }), result: Task },
  "task.updateObjective": { params: z.object({ taskId: z.string(), objective: Objective }), result: z.object({ ok: z.literal(true) }) },
  "task.start": { params: z.object({ taskId: z.string() }), result: z.object({ runId: z.string() }) },
  "run.interrupt": { params: z.object({ taskId: z.string() }), result: z.object({ ok: z.literal(true) }) },
  "run.instruct": { params: z.object({ taskId: z.string(), text: z.string().min(1), source: z.enum(["text", "voice"]) }), result: z.object({ runId: z.string() }) },
  "approval.respond": {
    params: z.object({ taskId: z.string(), approvalId: z.string(), decision: z.enum(["accept", "decline"]) }),
    result: z.object({ ok: z.literal(true) }),
  },
  "changes.refresh": { params: z.object({ taskId: z.string() }), result: z.object({ ok: z.literal(true) }) },
  "changes.file": {
    params: z.object({ taskId: z.string(), path: z.string() }),
    result: z.object({ path: z.string(), original: z.string().nullable(), modified: z.string().nullable(), language: z.string() }),
  },
  "verification.candidates": { params: z.object({ taskId: z.string() }), result: z.array(VerificationCandidate) },
  "verification.run": { params: z.object({ taskId: z.string(), command: z.string().min(1) }), result: z.object({ evidenceId: z.string() }) },
  "question.ask": {
    params: z.object({ taskId: z.string(), text: z.string().min(1), source: z.enum(["text", "voice"]), context: QuestionContext }),
    result: z.object({ questionId: z.string(), runId: z.string() }),
  },
  "decision.review": {
    params: z.object({
      taskId: z.string(),
      decisionId: z.string(),
      status: z.enum(["proposed", "reviewed", "approved", "rejected"]),
      selectedAlternativeId: z.string().nullable(),
      note: z.string().nullable(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  "integration.commit": { params: z.object({ taskId: z.string(), message: z.string().min(1) }), result: z.object({ commitSha: z.string() }) },
  "voice.transcribe": {
    params: z.object({ audioBase64: z.string().min(1), mimeType: z.string() }),
    result: z.object({ text: z.string(), provider: z.string(), durationMs: z.number() }),
  },
} as const;

export type RpcMethodName = keyof typeof RpcMethods;
export type RpcParams<M extends RpcMethodName> = z.input<(typeof RpcMethods)[M]["params"]>;
export type RpcResult<M extends RpcMethodName> = z.infer<(typeof RpcMethods)[M]["result"]>;

export const RpcError = z.object({ code: z.string(), message: z.string() });
export type RpcError = z.infer<typeof RpcError>;

/** Wire envelope (WebSocket, JSON text frames). */
export const ClientMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hello"), token: z.string(), protocolVersion: z.number() }),
  z.object({ kind: z.literal("call"), id: z.number(), method: z.string(), params: z.unknown() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("welcome"), protocolVersion: z.number(), runtimeVersion: z.string() }),
  z.object({ kind: z.literal("result"), id: z.number(), result: z.unknown() }),
  z.object({ kind: z.literal("error"), id: z.number().nullable(), error: RpcError }),
  z.object({ kind: z.literal("event"), event: DomainEvent }),
  z.object({ kind: z.literal("delta"), delta: LiveDelta }),
  z.object({ kind: z.literal("status"), reason: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export const RuntimeConnectionInfo = z.object({
  url: z.string(),
  token: z.string(),
  pid: z.number(),
  startedAt: z.string(),
  version: z.string(),
});
export type RuntimeConnectionInfo = z.infer<typeof RuntimeConnectionInfo>;

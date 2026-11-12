import { z } from "zod";
import {
  AgentRun,
  ApprovalRequest,
  ChangeSnapshot,
  EngineeringDecision,
  Evidence,
  Integration,
  Objective,
  PlanStep,
  Question,
  Task,
  Understanding,
  WorkItem,
  Worktree,
} from "./domain";

export const EVENT_SCHEMA_VERSION = 1;

const Ev = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({
    id: z.string(),
    taskId: z.string(),
    seq: z.number().int().nonnegative(),
    at: z.string(),
    v: z.literal(EVENT_SCHEMA_VERSION),
    type: z.literal(type),
    payload,
  });

export const DomainEvent = z.discriminatedUnion("type", [
  Ev("task.created", z.object({ task: Task })),
  Ev("task.objective_updated", z.object({ objective: Objective })),
  Ev("worktree.created", z.object({ worktree: Worktree })),
  Ev("worktree.failed", z.object({ error: z.string() })),
  Ev("run.started", z.object({ run: AgentRun })),
  Ev("run.bound", z.object({ runId: z.string(), threadId: z.string(), turnId: z.string().nullable(), model: z.string().nullable(), providerVersion: z.string().nullable() })),
  Ev("run.plan_updated", z.object({ runId: z.string(), explanation: z.string().nullable(), steps: z.array(PlanStep) })),
  Ev("run.item_started", z.object({ item: WorkItem })),
  Ev("run.item_completed", z.object({ item: WorkItem })),
  Ev("run.warning", z.object({ runId: z.string(), message: z.string() })),
  Ev("run.finished", z.object({ runId: z.string(), status: z.enum(["completed", "failed", "interrupted"]), error: z.string().nullable(), finalMessage: z.string().nullable() })),
  Ev("run.state_unknown", z.object({ runId: z.string(), reason: z.string() })),
  Ev("approval.requested", z.object({ approval: ApprovalRequest })),
  Ev("approval.resolved", z.object({ approvalId: z.string(), status: ApprovalRequest.shape.status, decidedAt: z.string() })),
  Ev("changes.captured", z.object({ snapshot: ChangeSnapshot })),
  Ev("evidence.recorded", z.object({ evidence: Evidence })),
  Ev("understanding.updated", z.object({ understanding: Understanding })),
  Ev("decision.reviewed", z.object({
    decisionId: z.string(),
    status: EngineeringDecision.shape.status,
    selectedAlternativeId: z.string().nullable(),
    note: z.string().nullable(),
  })),
  Ev("question.asked", z.object({ question: Question })),
  Ev("integration.committed", z.object({ integration: Integration })),
]);
export type DomainEvent = z.infer<typeof DomainEvent>;
export type DomainEventType = DomainEvent["type"];
export type EventOf<T extends DomainEventType> = Extract<DomainEvent, { type: T }>;
export type EventPayload<T extends DomainEventType> = EventOf<T>["payload"];

/** Ephemeral, high-frequency stream data. Broadcast live, never persisted. */
export const LiveDelta = z.object({
  taskId: z.string(),
  runId: z.string(),
  itemId: z.string(),
  stream: z.enum(["agent_message", "command_output", "reasoning", "plan", "file_change"]),
  delta: z.string(),
});
export type LiveDelta = z.infer<typeof LiveDelta>;

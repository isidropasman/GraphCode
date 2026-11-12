import type {
  AgentRun,
  ApprovalRequest,
  ChangeSnapshot,
  Evidence,
  Integration,
  PlanStep,
  Question,
  Task,
  Understanding,
  WorkItem,
  Worktree,
} from "./domain";
import type { DomainEvent } from "./events";

export type TaskPhase =
  | "draft"
  | "preparing"
  | "running"
  | "needs_approval"
  | "review"
  | "integrated"
  | "failed"
  | "interrupted"
  | "unknown";

export type TaskState = {
  task: Task;
  lastSeq: number;
  updatedAt: string;
  worktree: Worktree | null;
  worktreeError: string | null;
  runs: AgentRun[];
  items: Record<string, WorkItem[]>;
  plans: Record<string, { explanation: string | null; steps: PlanStep[] }>;
  warnings: { runId: string; message: string; at: string }[];
  approvals: ApprovalRequest[];
  snapshot: ChangeSnapshot | null;
  evidence: Evidence[];
  understanding: Understanding | null;
  questions: Question[];
  integration: Integration | null;
};

export function emptyTaskState(task: Task): TaskState {
  return {
    task,
    lastSeq: -1,
    updatedAt: task.createdAt,
    worktree: null,
    worktreeError: null,
    runs: [],
    items: {},
    plans: {},
    warnings: [],
    approvals: [],
    snapshot: null,
    evidence: [],
    understanding: null,
    questions: [],
    integration: null,
  };
}

function updateRun(state: TaskState, runId: string, patch: Partial<AgentRun>): AgentRun[] {
  return state.runs.map((r) => (r.id === runId ? { ...r, ...patch } : r));
}

function upsertItem(list: WorkItem[] | undefined, item: WorkItem): WorkItem[] {
  const items = list ?? [];
  const idx = items.findIndex((i) => i.id === item.id);
  if (idx === -1) return [...items, item];
  const next = items.slice();
  const prev = items[idx]!;
  next[idx] = { ...prev, ...item, startedAt: prev.startedAt ?? item.startedAt };
  return next;
}

/** Pure projection of the event log for one task. Unknown sequencing is rejected loudly. */
export function applyEvent(state: TaskState | null, event: DomainEvent): TaskState {
  if (event.type === "task.created") {
    if (state) throw new Error(`task ${event.taskId} already created`);
    return { ...emptyTaskState(event.payload.task), lastSeq: event.seq, updatedAt: event.at };
  }
  if (!state) throw new Error(`event ${event.type} for unknown task ${event.taskId}`);
  if (event.seq <= state.lastSeq) return state;
  const s: TaskState = { ...state, lastSeq: event.seq, updatedAt: event.at };

  switch (event.type) {
    case "task.objective_updated":
      return { ...s, task: { ...s.task, objective: event.payload.objective, title: titleFrom(event.payload.objective.text) } };
    case "worktree.created":
      return { ...s, worktree: event.payload.worktree, worktreeError: null };
    case "worktree.failed":
      return { ...s, worktreeError: event.payload.error };
    case "run.started":
      return { ...s, runs: [...s.runs, event.payload.run] };
    case "run.bound": {
      const { runId, threadId, turnId, model, providerVersion } = event.payload;
      const current = s.runs.find((r) => r.id === runId)?.status;
      const status = current === "starting" || current === "running" ? "running" : current;
      return { ...s, runs: updateRun(s, runId, { threadId, turnId, model, providerVersion, ...(status ? { status } : {}) }) };
    }
    case "run.plan_updated":
      return { ...s, plans: { ...s.plans, [event.payload.runId]: { explanation: event.payload.explanation, steps: event.payload.steps } } };
    case "run.item_started":
    case "run.item_completed": {
      const item = event.payload.item;
      return { ...s, items: { ...s.items, [item.runId]: upsertItem(s.items[item.runId], item) } };
    }
    case "run.warning":
      return { ...s, warnings: [...s.warnings, { runId: event.payload.runId, message: event.payload.message, at: event.at }] };
    case "run.finished": {
      const { runId, status, error, finalMessage } = event.payload;
      const approvals = s.approvals.map((a) =>
        a.runId === runId && a.status === "pending" ? { ...a, status: "expired" as const, decidedAt: event.at } : a,
      );
      const items = (s.items[runId] ?? []).map((i) =>
        i.status === "in_progress" ? { ...i, status: status === "completed" ? ("completed" as const) : ("failed" as const) } : i,
      );
      return {
        ...s,
        approvals,
        items: { ...s.items, [runId]: items },
        runs: updateRun(s, runId, { status, error, finalMessage, endedAt: event.at }),
      };
    }
    case "run.state_unknown": {
      const approvals = s.approvals.map((a) =>
        a.runId === event.payload.runId && a.status === "pending" ? { ...a, status: "expired" as const, decidedAt: event.at } : a,
      );
      return { ...s, approvals, runs: updateRun(s, event.payload.runId, { status: "interrupted", error: event.payload.reason, endedAt: event.at }) };
    }
    case "approval.requested":
      return { ...s, approvals: [...s.approvals, event.payload.approval] };
    case "approval.resolved":
      return {
        ...s,
        approvals: s.approvals.map((a) =>
          a.id === event.payload.approvalId ? { ...a, status: event.payload.status, decidedAt: event.payload.decidedAt } : a,
        ),
      };
    case "changes.captured":
      return { ...s, snapshot: event.payload.snapshot };
    case "evidence.recorded":
      return { ...s, evidence: [...s.evidence.filter((e) => e.id !== event.payload.evidence.id), event.payload.evidence] };
    case "understanding.updated": {
      // Preserve user review state across regenerations.
      const prev = new Map((s.understanding?.decisions ?? []).map((d) => [d.id, d]));
      const decisions = event.payload.understanding.decisions.map((d) => {
        const p = prev.get(d.id);
        return p && p.status !== "proposed"
          ? { ...d, status: p.status, selectedAlternativeId: p.selectedAlternativeId, userNote: p.userNote }
          : d;
      });
      return { ...s, understanding: { ...event.payload.understanding, decisions } };
    }
    case "decision.reviewed": {
      if (!s.understanding) return s;
      const { decisionId, status, selectedAlternativeId, note } = event.payload;
      return {
        ...s,
        understanding: {
          ...s.understanding,
          decisions: s.understanding.decisions.map((d) =>
            d.id === decisionId
              ? { ...d, status, selectedAlternativeId: selectedAlternativeId ?? d.selectedAlternativeId, userNote: note ?? d.userNote }
              : d,
          ),
        },
      };
    }
    case "question.asked":
      return { ...s, questions: [...s.questions, event.payload.question] };
    case "integration.committed":
      return { ...s, integration: event.payload.integration };
  }
}

export function replay(events: DomainEvent[]): TaskState | null {
  let state: TaskState | null = null;
  for (const e of events) state = applyEvent(state, e);
  return state;
}

export function titleFrom(text: string): string {
  const firstLine = text.trim().split("\n")[0] ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}

export function implementRuns(state: TaskState): AgentRun[] {
  return state.runs.filter((r) => r.kind !== "question");
}

export function activeRun(state: TaskState): AgentRun | null {
  return state.runs.find((r) => r.status === "starting" || r.status === "running") ?? null;
}

/** Derived, never stored: the phase shown in the GUI. */
export function taskPhase(state: TaskState): TaskPhase {
  if (state.integration) return "integrated";
  if (state.approvals.some((a) => a.status === "pending")) return "needs_approval";
  const runs = implementRuns(state);
  const last = runs[runs.length - 1];
  if (!last) return state.worktreeError ? "failed" : state.worktree ? "preparing" : "draft";
  switch (last.status) {
    case "starting":
    case "running":
      return "running";
    case "completed":
      return "review";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "unknown":
      return "unknown";
  }
}

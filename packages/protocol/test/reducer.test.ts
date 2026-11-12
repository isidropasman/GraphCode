import { describe, expect, it } from "vitest";
import { applyEvent, replay, taskPhase, type DomainEvent, type Task } from "../src";

const task: Task = { id: "t1", projectId: "p1", title: "Add x", objective: { text: "Add x", constraints: [], source: "text" }, createdAt: "2026-01-01T00:00:00Z" };
let seq = 0;
const ev = (type: DomainEvent["type"], payload: unknown): DomainEvent => ({ id: `e${seq}`, taskId: "t1", seq: seq++, at: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`, v: 1, type, payload } as DomainEvent);
const run = { id: "r1", taskId: "t1", kind: "implement" as const, prompt: "Add x", provider: "codex", providerVersion: null, threadId: null, turnId: null, model: null, status: "starting" as const, startedAt: "x", endedAt: null, error: null, finalMessage: null };

describe("task reducer", () => {
  it("projects a run lifecycle into phases", () => {
    seq = 0;
    let s = applyEvent(null, ev("task.created", { task }));
    expect(taskPhase(s)).toBe("draft");
    s = applyEvent(s, ev("run.started", { run }));
    s = applyEvent(s, ev("run.bound", { runId: "r1", threadId: "th", turnId: "tu", model: "m", providerVersion: "1" }));
    expect(taskPhase(s)).toBe("running");
    s = applyEvent(s, ev("run.item_started", { item: { id: "i1", runId: "r1", kind: "command", status: "in_progress", title: "ls", startedAt: null, completedAt: null, providerType: "commandExecution" } }));
    s = applyEvent(s, ev("approval.requested", { approval: { id: "a1", runId: "r1", kind: "command", summary: "rm", command: "rm x", cwd: null, reason: null, files: [], status: "pending", requestedAt: "x", decidedAt: null } }));
    expect(taskPhase(s)).toBe("needs_approval");
    s = applyEvent(s, ev("run.finished", { runId: "r1", status: "completed", error: null, finalMessage: "{}" }));
    expect(taskPhase(s)).toBe("review");
    expect(s.approvals[0]!.status).toBe("expired");
    expect(s.items.r1![0]!.status).toBe("completed");
  });

  it("marks unattachable runs interrupted instead of running", () => {
    seq = 0;
    const s = replay([ev("task.created", { task }), ev("run.started", { run }), ev("run.state_unknown", { runId: "r1", reason: "restarted" })])!;
    expect(s.runs[0]!.status).toBe("interrupted");
    expect(taskPhase(s)).toBe("interrupted");
  });

  it("ignores replayed events and rejects events for unknown tasks", () => {
    seq = 0;
    const created = ev("task.created", { task });
    const s = applyEvent(null, created);
    expect(applyEvent(s, { ...created, type: "run.warning", payload: { runId: "r", message: "m" } } as DomainEvent)).toBe(s);
    expect(() => applyEvent(null, ev("run.started", { run }))).toThrow();
  });

  it("keeps user decision reviews across understanding regeneration", () => {
    seq = 0;
    const decision = { id: "d1", question: "Q", alternatives: [{ id: "a", label: "A", description: "", consequences: [] }], selectedAlternativeId: "a", rationale: null, assumptions: [], tradeoffs: [], evidenceIds: [], fileRefs: [], status: "proposed", provenance: "agent", captured: "after_run", userNote: null };
    const u = { revision: null, generatedAt: "x", summary: null, decisions: [decision], risks: [], concepts: [], unknowns: [] };
    const s = replay([
      ev("task.created", { task }),
      ev("understanding.updated", { understanding: u }),
      ev("decision.reviewed", { decisionId: "d1", status: "approved", selectedAlternativeId: null, note: "ok" }),
      ev("understanding.updated", { understanding: u }),
    ])!;
    expect(s.understanding!.decisions[0]!.status).toBe("approved");
    expect(s.understanding!.decisions[0]!.userNote).toBe("ok");
  });
});

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  activeRun,
  implementRuns,
  taskPhase,
  titleFrom,
  type AgentRun,
  type Objective,
  type Project,
  type QuestionContext,
  type RepoInspection,
  type Task,
  type TaskState,
  type TaskSummary,
  type VerificationCandidate,
  type WorkItem,
} from "@graphcode/protocol";
import type { AgentEvent, AgentProvider, RunHandle } from "./agents/types";
import type { RuntimeConfig } from "./config";
import type { Database } from "./db";
import { captureChanges, commitAll, createWorktree, detectVerification, fileAt, inspectRepo, isGitRepo, languageFor, repoRoot } from "./git";
import type { EventStore } from "./store";
import { agentSuggestedCommand, buildUnderstanding, REVIEW_OUTPUT_SCHEMA } from "./understanding";
import { runCommand } from "./verification";

export class UserError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const IMPLEMENT_INSTRUCTIONS = `You are working inside GraphCode, a review-centric development environment.
- You are in a dedicated git worktree created for this task. Make changes only inside it.
- Do not commit, push, merge, rebase, or delete branches. The human integrates changes after review.
- Prefer small, focused changes that follow existing conventions.
- Run the project's relevant checks when practical and report exactly what you ran.
- Your final message MUST be a JSON object matching the provided output schema. Report only real decisions where a reasonable alternative existed; do not invent alternatives, risks, or verification you did not perform. Use repository-relative file paths.`;

const QUESTION_INSTRUCTIONS = `You are answering a reviewer's question inside GraphCode about work in this git worktree.
- Do not modify any files. Read code as needed.
- Answer concisely (under 200 words unless necessary). Reference repository-relative file paths and line numbers.
- Clearly separate what you verified by reading code from what you are inferring. If you do not know, say so.`;

export class Orchestrator {
  private handles = new Map<string, RunHandle>(); // by runId
  private verifying = new Set<string>(); // taskIds with a verification command running in the worktree

  constructor(
    private readonly db: Database,
    private readonly store: EventStore,
    private readonly provider: AgentProvider,
    private readonly config: RuntimeConfig,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** Runs that were active when the runtime stopped cannot be reattached; say so instead of pretending. */
  recover() {
    for (const state of this.store.all()) {
      for (const run of state.runs) {
        if (run.status === "starting" || run.status === "running") {
          this.store.emit(state.task.id, "run.state_unknown", {
            runId: run.id,
            reason: "The GraphCode runtime stopped while this run was active, so its live agent turn could not be reattached. The worktree contents are preserved; refresh changes to see what was written.",
          });
        }
      }
    }
  }

  // ---------- projects ----------

  async openProject(input: string): Promise<{ project: Project; inspection: RepoInspection }> {
    const dir = path.resolve(input.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new UserError("not_found", `Directory not found: ${dir}`);
    if (!(await isGitRepo(dir))) throw new UserError("not_git", `${dir} is not a Git repository.`);
    const root = await repoRoot(dir);
    const now = new Date().toISOString();
    const project = this.db.upsertProject({ id: randomUUID(), path: root, name: path.basename(root), addedAt: now, lastOpenedAt: now });
    return { project, inspection: await inspectRepo(root) };
  }

  async inspectProject(projectId: string) {
    return inspectRepo(this.requireProject(projectId).path);
  }

  private requireProject(id: string): Project {
    const p = this.db.project(id);
    if (!p) throw new UserError("not_found", "Unknown project");
    return p;
  }

  requireTask(taskId: string): TaskState {
    const s = this.store.get(taskId);
    if (!s) throw new UserError("not_found", "Unknown task");
    return s;
  }

  listTasks(projectId: string | null): TaskSummary[] {
    return this.store
      .all()
      .filter((s) => !projectId || s.task.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => ({ id: s.task.id, projectId: s.task.projectId, title: s.task.title, phase: taskPhase(s), createdAt: s.task.createdAt, updatedAt: s.updatedAt, branch: s.worktree?.branch ?? null }));
  }

  // ---------- tasks ----------

  async createTask(projectId: string, objective: Objective, start: boolean): Promise<Task> {
    this.requireProject(projectId);
    const task: Task = { id: randomUUID(), projectId, title: titleFrom(objective.text), objective, createdAt: new Date().toISOString() };
    this.db.insertTask(task.id, projectId, task.createdAt);
    this.store.emit(task.id, "task.created", { task });
    if (start) await this.startTask(task.id);
    return task;
  }

  updateObjective(taskId: string, objective: Objective) {
    const s = this.requireTask(taskId);
    if (implementRuns(s).length) throw new UserError("conflict", "The objective is locked once the agent has started. Send an instruction instead.");
    this.store.emit(taskId, "task.objective_updated", { objective });
  }

  private async ensureWorktree(taskId: string) {
    const s = this.requireTask(taskId);
    if (s.worktree) return s.worktree;
    const project = this.requireProject(s.task.projectId);
    try {
      const wt = await createWorktree(project.path, this.config.worktreesDir, taskId, s.task.title);
      this.store.emit(taskId, "worktree.created", { worktree: wt });
      return wt;
    } catch (err) {
      this.store.emit(taskId, "worktree.failed", { error: (err as Error).message });
      throw new UserError("worktree", (err as Error).message);
    }
  }

  async startTask(taskId: string): Promise<{ runId: string }> {
    const s = this.requireTask(taskId);
    if (implementRuns(s).length) throw new UserError("conflict", "This task has already started. Send an instruction to continue.");
    const { text, constraints } = s.task.objective;
    const prompt = constraints.length ? `${text}\n\nConstraints:\n${constraints.map((c) => `- ${c}`).join("\n")}` : text;
    return this.startRun(taskId, "implement", prompt);
  }

  async instruct(taskId: string, text: string): Promise<{ runId: string }> {
    const s = this.requireTask(taskId);
    if (!implementRuns(s).length) throw new UserError("conflict", "Start the task before sending instructions.");
    return this.startRun(taskId, "instruct", text);
  }

  private lastThread(s: TaskState): string | null {
    return [...implementRuns(s)].reverse().find((r) => r.threadId)?.threadId ?? null;
  }

  private async startRun(taskId: string, kind: AgentRun["kind"], prompt: string, opts: { context?: string } = {}): Promise<{ runId: string }> {
    const s0 = this.requireTask(taskId);
    // One active writer per worktree. Read-only questions may run alongside nothing else either, to keep the thread linear.
    const active = activeRun(s0);
    if (active) throw new UserError("busy", `A ${active.kind} run is already active for this task. Wait for it or interrupt it.`);
    if (kind !== "question") this.assertNotVerifying(taskId);
    if (s0.integration && kind !== "question") throw new UserError("conflict", "This task was already integrated.");
    const wt = await this.ensureWorktree(taskId);
    const runId = randomUUID();
    const threadId = this.lastThread(this.requireTask(taskId));
    const run: AgentRun = {
      id: runId, taskId, kind, prompt, provider: this.provider.id, providerVersion: null, threadId, turnId: null,
      model: null, status: "starting", startedAt: new Date().toISOString(), endedAt: null, error: null, finalMessage: null,
    };
    this.store.emit(taskId, "run.started", { run });
    const emit = (e: AgentEvent) => this.onAgentEvent(taskId, runId, kind, e);
    try {
      const handle = await this.provider.startRun(
        {
          runId,
          cwd: wt.path,
          prompt: opts.context ? `${opts.context}\n\nQuestion: ${prompt}` : prompt,
          developerInstructions: kind === "question" ? QUESTION_INSTRUCTIONS : IMPLEMENT_INSTRUCTIONS,
          access: kind === "question" ? "read-only" : "workspace-write",
          outputSchema: kind === "question" ? null : REVIEW_OUTPUT_SCHEMA,
          threadId,
        },
        emit,
      );
      if (this.requireTask(taskId).runs.find((r) => r.id === runId)?.status !== "completed") this.handles.set(runId, handle);
    } catch (err) {
      this.log(`[run ${runId}] failed to start: ${(err as Error).message}`);
      this.store.emit(taskId, "run.finished", { runId, status: "failed", error: `Failed to start agent: ${(err as Error).message}`, finalMessage: null });
    }
    return { runId };
  }

  private onAgentEvent(taskId: string, runId: string, kind: AgentRun["kind"], e: AgentEvent) {
    const withRun = (item: Omit<WorkItem, "runId">): WorkItem => ({ ...item, runId });
    switch (e.type) {
      case "bound":
        this.store.emit(taskId, "run.bound", { runId, threadId: e.threadId, turnId: e.turnId, model: e.model, providerVersion: e.providerVersion });
        return;
      case "plan":
        this.store.emit(taskId, "run.plan_updated", { runId, explanation: e.explanation, steps: e.steps });
        return;
      case "item_started":
        this.store.emit(taskId, "run.item_started", { item: withRun(e.item) });
        return;
      case "item_completed": {
        const item = withRun(e.item);
        this.store.emit(taskId, "run.item_completed", { item });
        if (item.kind === "command" && item.command) {
          this.store.emit(taskId, "evidence.recorded", {
            evidence: {
              id: `ev_cmd_${item.id}`, taskId, type: "command", provenance: "provider",
              title: item.command, reference: `${this.provider.id} run ${runId} · item ${item.id}`, revision: null,
              observedAt: item.completedAt ?? new Date().toISOString(), command: item.command, cwd: item.cwd ?? "",
              exitCode: item.exitCode ?? null, durationMs: item.durationMs ?? null, outputTail: (item.output ?? "").slice(-6000), workItemId: item.id,
            },
          });
        }
        return;
      }
      case "delta":
        this.store.delta({ taskId, runId, itemId: e.itemId, stream: e.stream, delta: e.delta });
        return;
      case "approval_requested":
        this.store.emit(taskId, "approval.requested", {
          approval: { ...e.approval, runId, status: "pending", requestedAt: new Date().toISOString(), decidedAt: null },
        });
        return;
      case "approval_resolved": {
        const s = this.requireTask(taskId);
        const a = s.approvals.find((x) => x.id === e.approvalId);
        if (!a || a.status !== "pending") return;
        this.store.emit(taskId, "approval.resolved", { approvalId: e.approvalId, status: e.status, decidedAt: new Date().toISOString() });
        if (e.status === "accepted" || e.status === "declined") {
          this.store.emit(taskId, "evidence.recorded", {
            evidence: {
              id: `ev_appr_${a.id}`, taskId, type: "approval", provenance: "observed", title: `User ${e.status} ${a.kind === "command" ? "command" : "file change"}`,
              reference: `approval ${a.id}`, revision: null, observedAt: new Date().toISOString(), decision: e.status, subject: a.command ?? a.summary,
            },
          });
        }
        return;
      }
      case "warning":
        this.store.emit(taskId, "run.warning", { runId, message: e.message });
        return;
      case "finished": {
        this.handles.delete(runId);
        this.store.emit(taskId, "run.finished", { runId, status: e.status, error: e.error, finalMessage: e.finalMessage });
        if (kind !== "question") {
          void this.afterImplementRun(taskId, runId).catch((err) => {
            this.log(`[run ${runId}] post-run capture failed: ${(err as Error).message}`);
            this.store.emit(taskId, "run.warning", { runId, message: `Could not capture changes: ${(err as Error).message}` });
          });
        }
        return;
      }
    }
  }

  private async afterImplementRun(taskId: string, runId: string) {
    await this.refreshChanges(taskId);
    const s = this.requireTask(taskId);
    const run = s.runs.find((r) => r.id === runId);
    if (run?.finalMessage) {
      this.store.emit(taskId, "evidence.recorded", {
        evidence: {
          id: `ev_agent_${runId}`, taskId, type: "agent_statement", provenance: "agent", title: "Agent's final report",
          reference: `${run.provider} run ${runId}`, revision: s.snapshot?.revision ?? null, observedAt: run.endedAt ?? new Date().toISOString(),
          text: run.finalMessage, runId,
        },
      });
    }
    this.regenerateUnderstanding(taskId, runId);
  }

  private regenerateUnderstanding(taskId: string, runId: string | null = null) {
    const s = this.requireTask(taskId);
    if (!implementRuns(s).some((r) => r.status !== "starting" && r.status !== "running")) return;
    this.store.emit(taskId, "understanding.updated", { understanding: buildUnderstanding(s, runId) });
  }

  async refreshChanges(taskId: string) {
    const s = this.requireTask(taskId);
    if (!s.worktree) throw new UserError("conflict", "This task has no worktree yet.");
    if (!fs.existsSync(s.worktree.path)) throw new UserError("missing", `Worktree is missing on disk: ${s.worktree.path}`);
    const snapshot = await captureChanges(s.worktree.path, s.worktree.baseSha);
    if (s.snapshot?.revision.treeSha === snapshot.revision.treeSha) return;
    this.store.emit(taskId, "changes.captured", { snapshot });
    this.store.emit(taskId, "evidence.recorded", {
      evidence: {
        id: `ev_diff_${snapshot.revision.treeSha.slice(0, 12)}`, taskId, type: "git_diff", provenance: "observed",
        title: `${snapshot.totals.files} files changed (+${snapshot.totals.insertions} −${snapshot.totals.deletions})`,
        reference: `git diff ${snapshot.revision.baseSha.slice(0, 10)} ${snapshot.revision.treeSha.slice(0, 10)}`,
        revision: snapshot.revision, observedAt: snapshot.capturedAt, totals: snapshot.totals,
      },
    });
    if (!activeRun(this.requireTask(taskId))) this.regenerateUnderstanding(taskId);
  }

  async fileContents(taskId: string, file: string) {
    const s = this.requireTask(taskId);
    if (!s.worktree) throw new UserError("conflict", "No worktree");
    if (file.includes("..")) throw new UserError("invalid", "Invalid path");
    const change = s.snapshot?.changes.find((c) => c.path === file);
    const original = await fileAt(s.worktree.path, s.worktree.baseSha, change?.oldPath ?? file);
    const modified = s.snapshot ? await fileAt(s.worktree.path, s.snapshot.revision.treeSha, file) : null;
    return { path: file, original, modified, language: languageFor(file) };
  }

  interrupt(taskId: string) {
    const run = activeRun(this.requireTask(taskId));
    if (!run) throw new UserError("conflict", "No active run.");
    const h = this.handles.get(run.id);
    if (!h) throw new UserError("conflict", "This run is not attached to a live agent process.");
    return h.interrupt();
  }

  async respondApproval(taskId: string, approvalId: string, decision: "accept" | "decline") {
    const s = this.requireTask(taskId);
    const a = s.approvals.find((x) => x.id === approvalId);
    if (!a || a.status !== "pending") throw new UserError("conflict", "This approval is no longer pending.");
    const h = this.handles.get(a.runId);
    if (!h) throw new UserError("conflict", "The agent run that asked for this approval is not live anymore.");
    await h.respondApproval(approvalId, decision);
  }

  verificationCandidates(taskId: string): VerificationCandidate[] {
    const s = this.requireTask(taskId);
    const project = this.requireProject(s.task.projectId);
    const out = detectVerification(s.worktree?.path ?? project.path);
    const suggested = agentSuggestedCommand(s);
    if (suggested && !out.some((c) => c.command === suggested)) out.push({ command: suggested, source: "agent", reason: "Suggested by the agent (not run by GraphCode yet)" });
    return out;
  }

  async runVerification(taskId: string, command: string): Promise<{ evidenceId: string }> {
    this.assertNotVerifying(taskId);
    this.verifying.add(taskId);
    try {
      return await this.verifyNow(taskId, command);
    } finally {
      this.verifying.delete(taskId);
    }
  }

  private assertNotVerifying(taskId: string): void {
    if (this.verifying.has(taskId)) throw new UserError("busy", "A verification command is running in this worktree. Wait for it to finish.");
  }

  private async verifyNow(taskId: string, command: string): Promise<{ evidenceId: string }> {
    const s = this.requireTask(taskId);
    if (!s.worktree) throw new UserError("conflict", "No worktree");
    if (activeRun(s)) throw new UserError("busy", "Wait for the agent run to finish before verifying.");
    await this.refreshChanges(taskId);
    const revision = this.requireTask(taskId).snapshot!.revision;
    const evidenceId = `ev_test_${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const result = await runCommand(command, s.worktree.path, this.config.verificationTimeoutMs, (chunk) =>
      this.store.delta({ taskId, runId: "verification", itemId: evidenceId, stream: "command_output", delta: chunk }),
    );
    // Did the command itself modify the tree (e.g. formatters, snapshots)? Then the result applies to the pre-run revision only.
    await this.refreshChanges(taskId);
    const after = this.requireTask(taskId).snapshot!.revision;
    this.store.emit(taskId, "evidence.recorded", {
      evidence: {
        id: evidenceId, taskId, type: "test", provenance: "observed",
        title: `${command} → ${result.timedOut ? "timed out" : `exit ${result.exitCode ?? result.signal}`}`,
        reference: `ran by GraphCode in ${s.worktree.path} at ${startedAt}`,
        revision, observedAt: new Date().toISOString(), command, cwd: s.worktree.path, exitCode: result.exitCode,
        timedOut: result.timedOut, durationMs: result.durationMs, outputTail: result.outputTail,
        scope: after.treeSha === revision.treeSha
          ? "Shows only that this command exited with this code on this exact tree. It does not show which behaviors were exercised."
          : "The command modified files while running; this result applies to the tree before it ran.",
      },
    });
    this.regenerateUnderstanding(taskId);
    return { evidenceId };
  }

  async ask(taskId: string, text: string, source: "text" | "voice", context: QuestionContext) {
    const s = this.requireTask(taskId);
    const ctx = this.describeContext(s, context);
    const { runId } = await this.startRun(taskId, "question", text, { context: ctx });
    const questionId = randomUUID();
    this.store.emit(taskId, "question.asked", { question: { id: questionId, runId, text, source, context, askedAt: new Date().toISOString() } });
    return { questionId, runId };
  }

  private describeContext(s: TaskState, c: QuestionContext): string {
    const lines = [`Task objective: ${s.task.objective.text}`];
    if (s.snapshot) lines.push(`Changed files: ${s.snapshot.changes.map((x) => x.path).join(", ") || "none"}`);
    if (c.objectType === "decision") {
      const d = s.understanding?.decisions.find((x) => x.id === c.objectId);
      if (d) lines.push(`The reviewer is looking at this decision: "${d.question}". Chosen: ${d.alternatives.find((a) => a.id === d.selectedAlternativeId)?.label ?? "unknown"}. Alternatives: ${d.alternatives.map((a) => a.label).join("; ")}.`);
    } else if (c.objectType === "risk") {
      const r = s.understanding?.risks.find((x) => x.id === c.objectId);
      if (r) lines.push(`The reviewer is looking at this risk/assumption: "${r.title}" — ${r.detail}`);
    } else if (c.objectType === "change" && c.objectId) {
      lines.push(`The reviewer is looking at file: ${c.objectId}`);
    } else if (c.objectType === "concept") {
      const k = s.understanding?.concepts.find((x) => x.id === c.objectId);
      if (k) lines.push(`The reviewer wants to understand the concept: ${k.term}`);
    }
    if (c.view) lines.push(`Current view: ${c.view}`);
    return lines.join("\n");
  }

  reviewDecision(taskId: string, decisionId: string, status: "proposed" | "reviewed" | "approved" | "rejected", selectedAlternativeId: string | null, note: string | null) {
    const s = this.requireTask(taskId);
    if (!s.understanding?.decisions.some((d) => d.id === decisionId)) throw new UserError("not_found", "Unknown decision");
    this.store.emit(taskId, "decision.reviewed", { decisionId, status, selectedAlternativeId, note });
  }

  /** Explicit, user-initiated: commits the reviewed worktree to the task branch. Never pushes or merges. */
  async commit(taskId: string, message: string): Promise<{ commitSha: string }> {
    const s = this.requireTask(taskId);
    if (!s.worktree) throw new UserError("conflict", "No worktree");
    if (activeRun(s)) throw new UserError("busy", "Wait for the agent run to finish.");
    this.assertNotVerifying(taskId);
    if (s.integration) throw new UserError("conflict", "Already committed.");
    await this.refreshChanges(taskId);
    const snap = this.requireTask(taskId).snapshot;
    if (!snap || snap.totals.files === 0) throw new UserError("conflict", "There are no changes to commit.");
    const commitSha = await commitAll(s.worktree.path, message);
    const now = new Date().toISOString();
    this.store.emit(taskId, "integration.committed", { integration: { commitSha, branch: s.worktree.branch, message, revision: snap.revision, approvedAt: now } });
    this.store.emit(taskId, "evidence.recorded", {
      evidence: { id: `ev_commit_${commitSha.slice(0, 10)}`, taskId, type: "approval", provenance: "observed", title: `User approved and committed to ${s.worktree.branch}`, reference: `commit ${commitSha}`, revision: snap.revision, observedAt: now, decision: "committed", subject: message },
    });
    return { commitSha };
  }

  /** Graceful shutdown: we are killing the agent process, so active runs really are interrupted. */
  shutdown() {
    for (const s of this.store.all()) {
      const run = activeRun(s);
      if (run) this.store.emit(s.task.id, "run.finished", { runId: run.id, status: "interrupted", error: "GraphCode runtime was stopped.", finalMessage: null });
    }
  }
}

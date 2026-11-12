import { useState } from "react";
import { activeRun, type AgentRun, type ApprovalRequest, type TaskState, type WorkItem } from "@graphcode/protocol";
import { Empty, Section, duration } from "../components/ui";
import { client, notify, useApp } from "../store";

type StageState = "done" | "active" | "pending" | "failed" | "skipped";

function stages(st: TaskState): { label: string; state: StageState; detail?: string }[] {
  const impl = st.runs.filter((r) => r.kind !== "question");
  const last = impl[impl.length - 1];
  const runState: StageState = !last ? "pending" : last.status === "running" || last.status === "starting" ? "active" : last.status === "completed" ? "done" : "failed";
  const tests = st.evidence.filter((e) => e.type === "test");
  const lastTest = tests[tests.length - 1];
  const testCurrent = lastTest && st.snapshot && lastTest.revision?.treeSha === st.snapshot.revision.treeSha;
  return [
    { label: "Worktree", state: st.worktree ? "done" : st.worktreeError ? "failed" : impl.length ? "active" : "pending", detail: st.worktree?.branch },
    { label: "Agent", state: runState, detail: last ? last.status : undefined },
    { label: "Changes", state: st.snapshot ? "done" : runState === "done" ? "active" : "pending", detail: st.snapshot ? `${st.snapshot.totals.files} files` : undefined },
    { label: "Understanding", state: st.understanding ? "done" : "pending", detail: st.understanding ? `${st.understanding.decisions.length} decisions, ${st.understanding.risks.length} risks` : undefined },
    {
      label: "Verification",
      state: !lastTest ? "pending" : lastTest.type === "test" && lastTest.exitCode === 0 && testCurrent ? "done" : lastTest.type === "test" && lastTest.exitCode !== 0 ? "failed" : "pending",
      detail: lastTest && lastTest.type === "test" ? `${lastTest.command}: ${lastTest.timedOut ? "timeout" : `exit ${lastTest.exitCode}`}${testCurrent ? "" : " (older tree)"}` : undefined,
    },
    { label: "Committed", state: st.integration ? "done" : "pending", detail: st.integration?.branch },
  ];
}

export function StageRail({ st }: { st: TaskState }) {
  return (
    <ol className="stages" aria-label="Task stages">
      {stages(st).map((s) => (
        <li key={s.label} className={`stage stage-${s.state}`}>
          <span className="stage-dot" aria-hidden />
          <div>
            <div className="strong">{s.label}</div>
            {s.detail && <div className="muted small">{s.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function ApprovalCard({ a, taskId }: { a: ApprovalRequest; taskId: string }) {
  const [busy, setBusy] = useState(false);
  const respond = async (decision: "accept" | "decline") => {
    setBusy(true);
    try {
      await client.call("approval.respond", { taskId, approvalId: a.id, decision });
    } catch (err) {
      notify(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="approval" role="alert">
      <div className="strong">Codex asks to {a.kind === "command" ? "run a command" : a.kind === "file_change" ? "change files" : "do something"}</div>
      {a.command && <pre className="mono block">{a.command}</pre>}
      {a.cwd && <div className="muted small mono">in {a.cwd}</div>}
      {a.files.length > 0 && <div className="small mono">{a.files.join(", ")}</div>}
      {a.reason && <p className="small">Reason given: {a.reason}</p>}
      <div className="row">
        <button className="danger-outline" disabled={busy} onClick={() => void respond("decline")}>Decline</button>
        <button className="primary" disabled={busy} onClick={() => void respond("accept")}>Allow once</button>
      </div>
      <p className="muted small">Approvals are pointer/keyboard only. Voice cannot approve.</p>
    </div>
  );
}

const ICON: Record<WorkItem["kind"], string> = { command: "›_", file_change: "✎", message: "❝", reasoning: "∴", plan: "☰", tool: "⚙", web_search: "⌕", other: "•" };

function ItemRow({ item, raw }: { item: WorkItem; raw: boolean }) {
  const live = useApp((s) => s.deltas[`${item.runId}:${item.id}`]);
  const [open, setOpen] = useState(item.status === "in_progress" && item.kind === "command");
  const failed = item.status === "failed" || (item.kind === "command" && item.exitCode != null && item.exitCode !== 0);
  const body = item.kind === "command" ? item.output ?? live : item.kind === "file_change" ? item.files?.map((f) => `--- ${f.kind}: ${f.path}\n${f.diff}`).join("\n") : item.text ?? live;
  if (!raw && (item.kind === "reasoning" || item.kind === "message") && !body) return null;
  return (
    <li className={`item item-${item.kind} ${failed ? "item-failed" : ""} ${item.status === "in_progress" ? "item-live" : ""}`}>
      <button className="item-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="item-icon mono" aria-hidden>{ICON[item.kind]}</span>
        <span className="item-title">{item.kind === "command" ? <span className="mono">{item.command}</span> : item.title}</span>
        <span className="item-meta muted small">
          {item.status === "in_progress" ? "running…" : item.status === "declined" ? "declined" : ""}
          {item.kind === "command" && item.exitCode != null && <span className={item.exitCode === 0 ? "ok" : "bad"}> exit {item.exitCode}</span>}
          {item.durationMs != null && ` · ${duration(item.durationMs)}`}
        </span>
      </button>
      {open && body && <pre className="mono block output">{body}</pre>}
      {open && raw && <pre className="mono block raw">{JSON.stringify(item, null, 2)}</pre>}
    </li>
  );
}

function RunBlock({ st, run, raw }: { st: TaskState; run: AgentRun; raw: boolean }) {
  const items = st.items[run.id] ?? [];
  const plan = st.plans[run.id];
  const warnings = st.warnings.filter((w) => w.runId === run.id);
  return (
    <div className={`run run-${run.status}`}>
      <div className="run-head">
        <span className="strong">{run.kind === "implement" ? "Implementation" : run.kind === "instruct" ? "Follow-up" : "Question"}</span>
        <span className={`run-status run-status-${run.status}`}>{run.status}</span>
        <span className="muted small">{run.provider} {run.providerVersion ?? ""} {run.model ? `· ${run.model}` : ""}</span>
      </div>
      {run.kind !== "implement" && <p className="small quote">{run.prompt}</p>}
      {plan && (
        <ol className="plan">
          {plan.explanation && <p className="small muted">{plan.explanation}</p>}
          {plan.steps.map((s, i) => (
            <li key={i} className={`plan-${s.status}`}>{s.step}</li>
          ))}
        </ol>
      )}
      <ul className="items">
        {items.map((i) => (
          <ItemRow key={i.id} item={i} raw={raw} />
        ))}
        {items.length === 0 && (run.status === "starting" || run.status === "running") && <li className="muted small">Waiting for the first event from Codex…</li>}
      </ul>
      {warnings.map((w, i) => (
        <p key={i} className="warn small">⚠ {w.message}</p>
      ))}
      {run.error && <p className="error">{run.error}</p>}
    </div>
  );
}

export function Execution({ st }: { st: TaskState }) {
  const [raw, setRaw] = useState(false);
  const run = activeRun(st);
  const pending = st.approvals.filter((a) => a.status === "pending");
  return (
    <div className="execution">
      <StageRail st={st} />
      {pending.map((a) => (
        <ApprovalCard key={a.id} a={a} taskId={st.task.id} />
      ))}
      <Section
        title="Agent activity"
        aside={
          <>
            <label className="small"><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> Raw events</label>
            {run && <button className="danger-outline small" onClick={() => client.call("run.interrupt", { taskId: st.task.id }).catch(notify)}>Interrupt</button>}
          </>
        }
      >
        {st.runs.length === 0 ? <Empty>The agent has not started.</Empty> : [...st.runs].reverse().map((r) => <RunBlock key={r.id} st={st} run={r} raw={raw} />)}
      </Section>
    </div>
  );
}

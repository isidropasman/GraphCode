import { useState } from "react";
import { activeRun, implementRuns, taskPhase, type TaskState } from "@graphcode/protocol";
import { Empty, PhaseBadge, Section, short } from "../components/ui";
import { client, notify, setTab, useApp, type TaskTab } from "../store";
import { Execution } from "./Execution";
import { Review } from "./Review";
import { Understanding } from "./Understanding";

const TABS: { id: TaskTab; label: string }[] = [
  { id: "objective", label: "Objective" },
  { id: "execution", label: "Execution" },
  { id: "understanding", label: "Decisions & Understanding" },
  { id: "review", label: "Review" },
];

function ObjectiveTab({ st }: { st: TaskState }) {
  const started = implementRuns(st).length > 0;
  const [text, setText] = useState(st.task.objective.text);
  const [constraints, setConstraints] = useState(st.task.objective.constraints.join("\n"));
  const [instruction, setInstruction] = useState("");
  const busy = !!activeRun(st);
  const save = async (start: boolean) => {
    try {
      await client.call("task.updateObjective", {
        taskId: st.task.id,
        objective: { text: text.trim(), constraints: constraints.split("\n").map((c) => c.trim()).filter(Boolean), source: st.task.objective.source },
      });
      if (start) {
        await client.call("task.start", { taskId: st.task.id });
        setTab("execution");
      }
    } catch (err) {
      notify(err);
    }
  };
  return (
    <div className="grid-2">
      <Section title="Objective" aside={<span className="muted small">captured by {st.task.objective.source}</span>}>
        {started ? (
          <>
            <p className="objective-text">{st.task.objective.text}</p>
            {st.task.objective.constraints.length > 0 && (
              <ul className="bullets">
                {st.task.objective.constraints.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
            <p className="muted small">Locked after the agent started. Send follow-up instructions instead.</p>
          </>
        ) : (
          <div className="composer">
            <label className="label" htmlFor="obj-edit">Objective</label>
            <textarea id="obj-edit" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
            <label className="label" htmlFor="obj-c">Constraints (one per line)</label>
            <textarea id="obj-c" rows={3} value={constraints} onChange={(e) => setConstraints(e.target.value)} />
            <div className="row end">
              <button onClick={() => void save(false)} disabled={!text.trim()}>Save</button>
              <button className="primary" onClick={() => void save(true)} disabled={!text.trim()}>Start with Codex</button>
            </div>
          </div>
        )}
      </Section>
      <Section title="Follow-up instruction">
        {!started ? (
          <Empty>Available after the agent starts.</Empty>
        ) : st.integration ? (
          <Empty>This task was committed. Start a new task for further changes.</Empty>
        ) : (
          <form className="composer" onSubmit={async (e) => { e.preventDefault(); try { await client.call("run.instruct", { taskId: st.task.id, text: instruction.trim(), source: "text" }); setInstruction(""); setTab("execution"); } catch (err) { notify(err); } }}>
            <textarea rows={3} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="e.g. Also handle the empty-input case and add a test for it" aria-label="Instruction" />
            <div className="row end">
              <button className="primary" disabled={busy || !instruction.trim()}>{busy ? "Agent is working…" : "Send to Codex"}</button>
            </div>
          </form>
        )}
        {st.worktree && (
          <dl className="facts small">
            <dt>Branch</dt>
            <dd className="mono">{st.worktree.branch}</dd>
            <dt>Worktree</dt>
            <dd className="mono">{st.worktree.path}</dd>
            <dt>Base</dt>
            <dd className="mono">{st.worktree.baseRef} @ {short(st.worktree.baseSha, 10)}</dd>
          </dl>
        )}
        {st.worktreeError && <p className="error">Worktree could not be created: {st.worktreeError}</p>}
      </Section>
    </div>
  );
}

export function TaskView({ taskId, tab }: { taskId: string; tab: TaskTab }) {
  const st = useApp((s) => s.taskStates[taskId]);
  if (!st) return <Empty>Loading task…</Empty>;
  const phase = taskPhase(st);
  const pendingApprovals = st.approvals.filter((a) => a.status === "pending").length;
  return (
    <div className="task">
      <div className="task-head">
        <h1>{st.task.title}</h1>
        <PhaseBadge phase={phase} />
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === "execution" && pendingApprovals > 0 && <span className="count warn">{pendingApprovals}</span>}
            {t.id === "understanding" && st.understanding && <span className="count">{st.understanding.decisions.length}</span>}
            {t.id === "review" && st.snapshot && <span className="count">{st.snapshot.totals.files}</span>}
          </button>
        ))}
      </div>
      {tab === "objective" && <ObjectiveTab st={st} />}
      {tab === "execution" && <Execution st={st} />}
      {tab === "understanding" && <Understanding st={st} />}
      {tab === "review" && <Review st={st} />}
    </div>
  );
}

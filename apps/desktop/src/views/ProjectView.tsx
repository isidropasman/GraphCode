import { useState } from "react";
import type { Objective, TaskPhase } from "@graphcode/protocol";
import { Empty, PhaseBadge, Prov, Section, ago, short } from "../components/ui";
import { client, inspectProject, notify, openTask, useApp } from "../store";

export function ObjectiveComposer({ projectId, initial }: { projectId: string; initial?: string }) {
  const [text, setText] = useState(initial ?? "");
  const [constraints, setConstraints] = useState<string[]>([]);
  const [draftC, setDraftC] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (start: boolean) => {
    const objective: Objective = { text: text.trim(), constraints, source: "text" };
    if (!objective.text) return;
    setBusy(true);
    try {
      const task = await client.call("task.create", { projectId, objective, start });
      setText("");
      setConstraints([]);
      openTask(task.id, start ? "execution" : "objective");
    } catch (err) {
      notify(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="composer">
      <label className="label" htmlFor="objective">What should change?</label>
      <textarea id="objective" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Add a --json flag to the CLI that prints results as JSON" />
      <div className="label">Constraints</div>
      <ul className="chips-list">
        {constraints.map((c, i) => (
          <li key={i} className="chip chip-plain">
            {c}
            <button className="icon small" aria-label={`Remove constraint ${c}`} onClick={() => setConstraints(constraints.filter((_, j) => j !== i))}>×</button>
          </li>
        ))}
      </ul>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (draftC.trim()) { setConstraints([...constraints, draftC.trim()]); setDraftC(""); } }}>
        <input className="grow" value={draftC} onChange={(e) => setDraftC(e.target.value)} placeholder="Add a constraint, e.g. No new dependencies" aria-label="New constraint" />
        <button type="submit" disabled={!draftC.trim()}>Add</button>
      </form>
      <div className="row end">
        <button disabled={busy || !text.trim()} onClick={() => void submit(false)}>Save as draft</button>
        <button className="primary" disabled={busy || !text.trim()} onClick={() => void submit(true)}>
          Start with Codex
        </button>
      </div>
      <p className="muted small">Starting creates a new branch and worktree, then runs Codex there with workspace-write sandboxing and on-request approvals.</p>
    </div>
  );
}

export function ProjectView({ projectId }: { projectId: string }) {
  const { projects, inspections, tasks } = useApp();
  const project = projects.find((p) => p.id === projectId);
  const ins = inspections[projectId];
  const list = tasks.filter((t) => t.projectId === projectId);
  if (!project) return <Empty>Unknown project.</Empty>;
  return (
    <div className="grid-2">
      <div>
        <Section title="New objective">
          <ObjectiveComposer projectId={projectId} />
        </Section>
        <Section title="Tasks">
          {list.length === 0 ? (
            <Empty>No tasks for this repository yet.</Empty>
          ) : (
            <ul className="list">
              {list.map((t) => (
                <li key={t.id}>
                  <button className="list-item" onClick={() => openTask(t.id)}>
                    <div>
                      <div className="strong">{t.title}</div>
                      <div className="muted small mono">{t.branch ?? "no branch yet"}</div>
                    </div>
                    <div className="list-meta">
                      <PhaseBadge phase={t.phase as TaskPhase} />
                      <span className="muted small">{ago(t.updatedAt)}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
      <Section title={<>Repository <Prov p="observed" /></>} aside={<button className="small" onClick={() => void inspectProject(projectId).catch(notify)}>Re-inspect</button>}>
        {!ins ? (
          <Empty>Inspecting…</Empty>
        ) : (
          <div className="facts">
            <dl>
              <dt>Path</dt>
              <dd className="mono">{ins.path}</dd>
              <dt>Branch</dt>
              <dd className="mono">{ins.branch ?? "detached / unknown"}</dd>
              <dt>HEAD</dt>
              <dd className="mono">{ins.headSha ? short(ins.headSha, 10) : "no commits — tasks need at least one commit"}</dd>
              <dt>Working tree</dt>
              <dd>
                {ins.dirty.staged + ins.dirty.unstaged + ins.dirty.untracked === 0
                  ? "clean"
                  : `${ins.dirty.staged} staged, ${ins.dirty.unstaged} modified, ${ins.dirty.untracked} untracked (not included in task worktrees)`}
              </dd>
              <dt>Tracked files</dt>
              <dd>{ins.trackedFiles}</dd>
              <dt>Languages</dt>
              <dd>{ins.languages.slice(0, 6).map((l) => `${l.ext} (${l.files})`).join(", ") || "unknown"}</dd>
              <dt>Verification</dt>
              <dd>
                {ins.verificationCandidates.length === 0
                  ? "No test/check commands declared in the repository."
                  : ins.verificationCandidates.map((c) => (
                      <div key={c.command} className="mono small" title={c.reason}>
                        {c.command} <span className="muted">({c.source})</span>
                      </div>
                    ))}
              </dd>
            </dl>
            <h3>Recent commits</h3>
            <ul className="commits">
              {ins.recentCommits.map((c) => (
                <li key={c.sha}>
                  <span className="mono muted">{short(c.sha, 7)}</span> {c.subject} <span className="muted small">— {c.author}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>
    </div>
  );
}

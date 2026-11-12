import { useEffect, useMemo, useRef, useState } from "react";
import { DiffEditor, type MonacoDiffEditor } from "@monaco-editor/react";
import "../monaco";
import { activeRun, type ChangeCategory, type Evidence, type TaskState, type VerificationCandidate } from "@graphcode/protocol";
import { Empty, Prov, Section, ago, duration, short } from "../components/ui";
import { client, focusFile, notify, select, useApp } from "../store";
import { Refs } from "./Understanding";

const CAT_LABEL: Record<ChangeCategory, string> = { source: "Source", test: "Tests", config: "Configuration", dependency: "Dependencies", docs: "Documentation", other: "Other" };

function FileDiff({ st }: { st: TaskState }) {
  const focus = useApp((s) => s.focus);
  const theme = useApp((s) => s.theme);
  const [file, setFile] = useState<{ path: string; original: string | null; modified: string | null; language: string } | null>(null);
  const editor = useRef<MonacoDiffEditor | null>(null);
  const path = focus?.path ?? st.snapshot?.changes[0]?.path ?? null;
  const tree = st.snapshot?.revision.treeSha;
  useEffect(() => {
    if (!path) return;
    let live = true;
    client.call("changes.file", { taskId: st.task.id, path }).then((f) => live && setFile(f), notify);
    return () => {
      live = false;
    };
  }, [path, tree, st.task.id]);
  useEffect(() => {
    const line = focus?.line;
    if (line && editor.current) {
      const m = editor.current.getModifiedEditor();
      m.revealLineInCenter(line);
      m.setSelection({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1000 });
    }
  }, [focus, file]);
  if (!path) return <Empty>No changed files.</Empty>;
  return (
    <div className="diff">
      <div className="diff-head mono small">
        {path} {focus?.line ? `:${focus.line}` : ""} <span className="muted">— base {short(st.snapshot?.revision.baseSha)} → tree {short(tree)}</span>
      </div>
      {file && file.path === path ? (
        <DiffEditor
          height="100%"
          original={file.original ?? ""}
          modified={file.modified ?? ""}
          language={file.language}
          theme={theme === "dark" ? "vs-dark" : "vs"}
          onMount={(e) => (editor.current = e)}
          options={{ readOnly: true, renderSideBySide: false, minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13 }}
        />
      ) : (
        <Empty>Loading…</Empty>
      )}
    </div>
  );
}

function EvidenceItem({ e, current }: { e: Evidence; current: string | undefined }) {
  const [open, setOpen] = useState(false);
  const stale = e.revision && current && e.revision.treeSha !== current;
  return (
    <li className={`evidence ev-${e.type}`}>
      <button className="item-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Prov p={e.provenance} />
        <span className={`item-title ${e.type === "test" ? (e.exitCode === 0 ? "ok" : "bad") : ""}`}>{e.title}</span>
        {stale && <span className="tag" title="Recorded for an earlier version of the worktree">older tree</span>}
        <span className="muted small">{ago(e.observedAt)}</span>
      </button>
      {open && (
        <div className="ev-body small">
          <div className="muted mono">{e.reference}{e.revision ? ` · tree ${short(e.revision.treeSha)}` : ""}</div>
          {e.type === "test" && <p className="scope">{e.scope} Duration {duration(e.durationMs)}.</p>}
          {(e.type === "test" || e.type === "command") && e.outputTail && <pre className="mono block output">{e.outputTail}</pre>}
          {e.type === "agent_statement" && <pre className="block wrap">{e.text}</pre>}
          {e.type === "approval" && <p>{e.subject}</p>}
        </div>
      )}
    </li>
  );
}

function Verification({ st }: { st: TaskState }) {
  const [cands, setCands] = useState<VerificationCandidate[]>([]);
  const [cmd, setCmd] = useState("");
  const [running, setRunning] = useState<string | null>(null);
  const live = useApp((s) => (running ? s.deltas[`verification:${running}`] : undefined));
  const busy = !!activeRun(st);
  useEffect(() => {
    client.call("verification.candidates", { taskId: st.task.id }).then((c) => {
      setCands(c);
      setCmd((v) => v || c[0]?.command || "");
    }, notify);
  }, [st.task.id, st.understanding?.generatedAt]);
  const run = async () => {
    setRunning("pending");
    try {
      await client.call("verification.run", { taskId: st.task.id, command: cmd.trim() });
    } catch (err) {
      notify(err);
    } finally {
      setRunning(null);
    }
  };
  return (
    <div>
      <div className="row">
        <input className="grow mono" list="verify-cands" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="Command to run in the worktree" aria-label="Verification command" />
        <datalist id="verify-cands">{cands.map((c) => <option key={c.command} value={c.command}>{c.reason}</option>)}</datalist>
        <button className="primary" disabled={!cmd.trim() || !!running || busy || !st.worktree} onClick={() => void run()}>{running ? "Running…" : "Run"}</button>
      </div>
      <div className="muted small">
        {cands.length ? cands.map((c) => <button key={c.command} className="link mono" onClick={() => setCmd(c.command)} title={c.reason}>{c.command} ({c.source})</button>) : "No commands declared by the repository."}
      </div>
      {running && <pre className="mono block output">{live ?? "Starting…"}</pre>}
    </div>
  );
}

function Commit({ st }: { st: TaskState }) {
  const [msg, setMsg] = useState(st.task.title);
  const [confirm, setConfirm] = useState(false);
  if (st.integration)
    return (
      <p>
        <Prov p="observed" /> Committed <span className="mono">{short(st.integration.commitSha, 10)}</span> to <span className="mono">{st.integration.branch}</span>. Merge or push it with your usual Git workflow.
      </p>
    );
  const openRisks = st.understanding?.risks.filter((r) => r.severity !== "low").length ?? 0;
  const tests = st.evidence.filter((e) => e.type === "test" && e.revision?.treeSha === st.snapshot?.revision.treeSha);
  return (
    <div className="composer">
      <input value={msg} onChange={(e) => setMsg(e.target.value)} aria-label="Commit message" />
      <ul className="small checklist">
        <li className={tests.some((t) => t.type === "test" && t.exitCode === 0) ? "ok" : "warn"}>{tests.length ? `${tests.length} verification run(s) on this exact tree` : "No verification run on this exact tree"}</li>
        <li className={openRisks ? "warn" : "ok"}>{openRisks} risk(s)/gap(s) above low severity</li>
        <li className={st.understanding?.decisions.every((d) => d.status !== "proposed") ? "ok" : "warn"}>{st.understanding?.decisions.filter((d) => d.status === "proposed").length ?? 0} decision(s) not reviewed</li>
      </ul>
      {!confirm ? (
        <button className="primary" disabled={!st.snapshot?.totals.files || !!activeRun(st)} onClick={() => setConfirm(true)}>Approve & commit to {st.worktree?.branch}</button>
      ) : (
        <div className="row">
          <button onClick={() => setConfirm(false)}>Cancel</button>
          <button className="primary" onClick={() => client.call("integration.commit", { taskId: st.task.id, message: msg.trim() }).catch(notify).finally(() => setConfirm(false))}>
            Confirm commit
          </button>
        </div>
      )}
      <p className="muted small">Commits on the task branch inside its worktree (hooks run). GraphCode never pushes or merges.</p>
    </div>
  );
}

export function Review({ st }: { st: TaskState }) {
  const focus = useApp((s) => s.focus);
  const highlight = useApp((s) => s.highlight);
  const snap = st.snapshot;
  const groups = useMemo(() => {
    const g = new Map<ChangeCategory, NonNullable<typeof snap>["changes"]>();
    for (const c of snap?.changes ?? []) g.set(c.category, [...(g.get(c.category) ?? []), c]);
    return [...g.entries()];
  }, [snap]);
  const u = st.understanding;
  const current = snap?.revision.treeSha;
  useEffect(() => {
    if (highlight) document.getElementById(highlight)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [highlight]);
  return (
    <div className="review">
      <div className="review-files">
        <Section title="Changes" aside={st.worktree && <button className="small" onClick={() => client.call("changes.refresh", { taskId: st.task.id }).catch(notify)}>Refresh</button>}>
          {!snap ? (
            <Empty>No changes captured yet.</Empty>
          ) : (
            <>
              <p className="small"><Prov p="observed" /> {snap.totals.files} files, +{snap.totals.insertions} −{snap.totals.deletions}</p>
              {groups.map(([cat, files]) => (
                <div key={cat} className="file-group">
                  <div className="muted small upper">{CAT_LABEL[cat]}</div>
                  <ul>
                    {files.map((c) => (
                      <li key={c.path}>
                        <button className={`file ${focus?.path === c.path ? "active" : ""}`} onClick={() => focusFile(c.path, c.hunks[0]?.newStart ?? null)}>
                          <span className={`fstatus fs-${c.status}`}>{c.status[0]!.toUpperCase()}</span>
                          <span className="mono grow">{c.path}</span>
                          <span className="small"><span className="ok">+{c.insertions}</span> <span className="bad">−{c.deletions}</span></span>
                        </button>
                        {focus?.path === c.path && c.hunks.length > 1 && (
                          <div className="hunks">{c.hunks.map((h, i) => <button key={i} className="link small mono" onClick={() => focusFile(c.path, h.newStart)}>@{h.newStart} {h.header}</button>)}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
        </Section>
      </div>
      <div className="review-diff">
        <FileDiff st={st} />
      </div>
      <div className="review-side">
        <Section title="Risks & unknowns" id="risks" className={highlight === "risks" ? "pulse" : ""}>
          {!u ? (
            <Empty>Available after the agent finishes.</Empty>
          ) : (
            <>
              <ul className="risks">
                {u.risks.map((r) => (
                  <li key={r.id} className={`risk sev-${r.severity}`} onClick={() => select({ type: "risk", id: r.id, label: r.title })}>
                    <div className="row between">
                      <span className="strong">{r.title}</span>
                      <span className="tag">{r.kind.replace("_", " ")}</span>
                    </div>
                    <p className="small">{r.detail}</p>
                    <div className="row"><Prov p={r.provenance} /><span className="muted small">severity: {r.severity}</span></div>
                    <Refs refs={r.fileRefs} />
                  </li>
                ))}
              </ul>
              {u.unknowns.length > 0 && (
                <>
                  <h3>Unknown</h3>
                  <ul className="bullets small">{u.unknowns.map((x) => <li key={x}>{x}</li>)}</ul>
                </>
              )}
            </>
          )}
        </Section>
        <Section title="Verification" id="verification" className={highlight === "verification" ? "pulse" : ""}>
          <Verification st={st} />
        </Section>
        <Section title="Evidence" id="evidence" className={highlight === "evidence" ? "pulse" : ""}>
          {st.evidence.length === 0 ? <Empty>No evidence recorded.</Empty> : <ul className="evidence-list">{[...st.evidence].reverse().map((e) => <EvidenceItem key={e.id} e={e} current={current} />)}</ul>}
        </Section>
        <Section title="Integrate">
          <Commit st={st} />
        </Section>
      </div>
    </div>
  );
}

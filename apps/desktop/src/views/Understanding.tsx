import { useMemo, useState } from "react";
import { Background, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { EngineeringDecision, FileRef, TaskState } from "@graphcode/protocol";
import { Empty, Prov, Section } from "../components/ui";
import { client, focusFile, notify, select, useApp } from "../store";

export function Refs({ refs }: { refs: FileRef[] }) {
  if (!refs.length) return null;
  return (
    <div className="refs">
      {refs.map((r, i) => (
        <button key={i} className="ref mono" onClick={() => focusFile(r.path, r.line)} title="Open the exact code in Review">
          {r.path}
          {r.line ? `:${r.line}` : ""}
        </button>
      ))}
    </div>
  );
}

function DecisionCard({ d, taskId, compare }: { d: EngineeringDecision; taskId: string; compare: boolean }) {
  const selection = useApp((s) => s.selection);
  const [note, setNote] = useState(d.userNote ?? "");
  const review = (status: EngineeringDecision["status"]) =>
    client.call("decision.review", { taskId, decisionId: d.id, status, selectedAlternativeId: null, note: note.trim() || null }).catch(notify);
  const selected = selection?.type === "decision" && selection.id === d.id;
  return (
    <article className={`decision ${selected ? "selected" : ""}`} onClick={() => select({ type: "decision", id: d.id, label: d.question })}>
      <header className="row between">
        <h3>{d.question}</h3>
        <div className="row">
          <Prov p={d.provenance} />
          {d.captured === "after_run" && <span className="tag" title="Reported by the agent after the work was done, not captured when the choice was made.">Reconstructed after run</span>}
          <span className={`tag status-${d.status}`}>{d.status}</span>
        </div>
      </header>
      <div className={`alts ${compare ? "alts-compare" : ""}`}>
        {d.alternatives.map((a) => (
          <div key={a.id} className={`alt ${a.id === d.selectedAlternativeId ? "alt-chosen" : ""}`}>
            <div className="strong">{a.id === d.selectedAlternativeId ? "✓ " : ""}{a.label}</div>
            {a.description && <p className="small">{a.description}</p>}
            {a.consequences.map((c, i) => (
              <p key={i} className="small muted">{c}</p>
            ))}
          </div>
        ))}
      </div>
      {d.rationale && <p><span className="muted">Rationale (agent): </span>{d.rationale}</p>}
      {d.assumptions.length > 0 && (
        <div>
          <div className="muted small">Assumptions</div>
          <ul className="bullets">{d.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
        </div>
      )}
      {d.tradeoffs.length > 0 && <ul className="bullets">{d.tradeoffs.map((t, i) => <li key={i}><b>{t.dimension}:</b> {t.note}</li>)}</ul>}
      <Refs refs={d.fileRefs} />
      <div className="row decision-actions" onClick={(e) => e.stopPropagation()}>
        <input className="grow small" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Your note (optional)" aria-label="Decision note" />
        <button className="small" onClick={() => void review("reviewed")}>Mark reviewed</button>
        <button className="small danger-outline" onClick={() => void review("rejected")}>Reject</button>
        <button className="small primary" onClick={() => void review("approved")}>Accept</button>
      </div>
    </article>
  );
}

function SystemMap({ st }: { st: TaskState }) {
  const { nodes, edges } = useMemo(() => {
    const snap = st.snapshot;
    if (!snap) return { nodes: [] as Node[], edges: [] as Edge[] };
    const changed = new Map(snap.changes.map((c) => [c.path, c]));
    const resolve = (to: string) => [...changed.keys()].find((p) => p === to || p.replace(/\.[^.]+$/, "") === to || p.replace(/\/index\.[^.]+$/, "") === to) ?? to;
    const local = snap.imports.filter((i) => i.specifier.startsWith(".")).map((i) => ({ ...i, to: resolve(i.to) }));
    const ids = new Set<string>([...changed.keys(), ...local.map((i) => i.to)]);
    const cols: Record<string, number> = { source: 0, test: 1, config: 2, dependency: 2, docs: 3, other: 3, context: 4 };
    const counts: Record<number, number> = {};
    const nodes: Node[] = [...ids].map((id) => {
      const c = changed.get(id);
      const col = cols[c?.category ?? "context"]!;
      const row = (counts[col] = (counts[col] ?? 0) + 1) - 1;
      return {
        id,
        position: { x: col * 260, y: row * 80 },
        data: { label: `${id.split("/").pop()}${c ? ` (+${c.insertions} −${c.deletions})` : ""}` },
        className: `map-node map-${c ? c.status : "context"}`,
      };
    });
    const edges: Edge[] = local.map((i, n) => ({ id: `e${n}`, source: i.from, target: i.to, label: i.specifier, animated: false }));
    return { nodes, edges };
  }, [st.snapshot]);
  if (!st.snapshot) return <Empty>No changes captured yet.</Empty>;
  return (
    <>
      <div className="map">
        <ReactFlow nodes={nodes} edges={edges} fitView onNodeClick={(_, n) => focusFile(n.id)} nodesConnectable={false} proOptions={{ hideAttribution: true }}>
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <p className="muted small">
        Nodes are changed files (columns: source, tests, config/deps, docs) plus files they import. Edges are relative imports read from source text at revision <span className="mono">{st.snapshot.revision.treeSha.slice(0, 8)}</span> <Prov p="observed" />. Package imports, dynamic loading and runtime calls are not shown.
      </p>
    </>
  );
}

function QA({ st }: { st: TaskState }) {
  const selection = useApp((s) => s.selection);
  const deltas = useApp((s) => s.deltas);
  const [text, setText] = useState("");
  const ask = async () => {
    try {
      await client.call("question.ask", { taskId: st.task.id, text: text.trim(), source: "text", context: { objectType: selection?.type ?? "task", objectId: selection?.id ?? null, view: "understanding" } });
      setText("");
    } catch (err) {
      notify(err);
    }
  };
  return (
    <div className="qa">
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void ask(); }}>
        <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder={selection ? `Ask about “${selection.label ?? selection.id}”…` : "Ask about this change…"} aria-label="Question" />
        <button className="primary" disabled={!text.trim()}>Ask</button>
      </form>
      <p className="muted small">Answers come from a read-only Codex turn in the same thread. They are agent claims, not verified facts.</p>
      <ul className="answers">
        {[...st.questions].reverse().map((q) => {
          const run = st.runs.find((r) => r.id === q.runId);
          const items = st.items[q.runId] ?? [];
          const msgItem = [...items].reverse().find((i) => i.kind === "message");
          const live = msgItem ? deltas[`${q.runId}:${msgItem.id}`] : Object.entries(deltas).find(([k]) => k.startsWith(`${q.runId}:`))?.[1];
          const answer = run?.finalMessage ?? msgItem?.text ?? live;
          return (
            <li key={q.id} className="answer">
              <div className="strong">{q.source === "voice" ? "🎙 " : ""}{q.text}</div>
              {q.context.objectType && q.context.objectType !== "task" && <div className="muted small">about {q.context.objectType} {q.context.objectId}</div>}
              {answer ? <div className="answer-text"><Prov p="agent" /> {answer}</div> : <div className="muted small">{run?.status === "failed" || run?.status === "interrupted" ? run.error ?? run.status : "Codex is reading the code…"}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Understanding({ st }: { st: TaskState }) {
  const compareId = useApp((s) => s.compareDecisionId);
  const highlight = useApp((s) => s.highlight);
  const u = st.understanding;
  return (
    <div className="grid-2 wide-left">
      <div>
        <Section title="Summary">
          {u?.summary ? <p><Prov p={u.summary.provenance} /> {u.summary.text}</p> : <Empty>No summary yet. It appears after the agent finishes.</Empty>}
        </Section>
        <Section title="Technical decisions">
          {!u ? (
            <Empty>Decisions appear after the agent finishes.</Empty>
          ) : u.decisions.length === 0 ? (
            <Empty>No decisions were reported. GraphCode does not invent them.</Empty>
          ) : (
            u.decisions.map((d) => <DecisionCard key={d.id} d={d} taskId={st.task.id} compare={compareId === d.id} />)
          )}
        </Section>
        <Section title="System map" id="map" className={highlight === "map" ? "pulse" : ""}>
          <SystemMap st={st} />
        </Section>
      </div>
      <div>
        <Section title="Ask about the result">
          <QA st={st} />
        </Section>
        <Section title="Concepts" id="concepts" className={highlight === "concepts" ? "pulse" : ""}>
          {!u || u.concepts.length === 0 ? (
            <Empty>No concepts reported.</Empty>
          ) : (
            <dl className="concepts">
              {u.concepts.map((c) => (
                <div key={c.id} onClick={() => select({ type: "concept", id: c.id, label: c.term })} className="concept">
                  <dt>{c.term} <Prov p={c.provenance} /></dt>
                  <dd>{c.explanation}</dd>
                  <Refs refs={c.fileRefs} />
                </div>
              ))}
            </dl>
          )}
        </Section>
      </div>
    </div>
  );
}

import { useState } from "react";
import { Empty, Section, ago } from "../components/ui";
import { isTauri, pickDirectory } from "../rpc";
import { notify, openProject, useApp } from "../store";

export function Home() {
  const { projects, status, tasks } = useApp();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const open = async (p: string) => {
    if (!p.trim()) return;
    setBusy(true);
    try {
      await openProject(p.trim());
    } catch (err) {
      notify(err);
    } finally {
      setBusy(false);
    }
  };
  const codex = status?.codex;
  return (
    <div className="home">
      <Section title="Open a local Git repository">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void open(path);
          }}
        >
          <input className="grow" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/repository" aria-label="Repository path" />
          {isTauri() && (
            <button type="button" onClick={async () => { const d = await pickDirectory(); if (d) void open(d); }}>
              Browse…
            </button>
          )}
          <button className="primary" disabled={busy || !path.trim()}>
            {busy ? "Opening…" : "Open"}
          </button>
        </form>
        <p className="muted small">GraphCode works in a separate Git worktree per task. Your checkout is never modified.</p>
      </Section>

      <Section title="Recent repositories">
        {projects.length === 0 ? (
          <Empty>No repositories opened yet.</Empty>
        ) : (
          <ul className="list">
            {projects.map((p) => {
              const n = tasks.filter((t) => t.projectId === p.id);
              const active = n.filter((t) => t.phase === "running" || t.phase === "needs_approval").length;
              const review = n.filter((t) => t.phase === "review").length;
              return (
                <li key={p.id}>
                  <button className="list-item" onClick={() => void open(p.path)}>
                    <div>
                      <div className="strong">{p.name}</div>
                      <div className="muted small mono">{p.path}</div>
                    </div>
                    <div className="list-meta">
                      {active > 0 && <span className="phase phase-running">{active} running</span>}
                      {review > 0 && <span className="phase phase-review">{review} to review</span>}
                      <span className="muted small">{n.length} tasks · {ago(p.lastOpenedAt)}</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {codex && (!codex.available || (codex.requiresAuth && !codex.account)) && (
        <Section title="Setup needed" className="setup">
          {!codex.available ? (
            <p>Codex App Server could not start: <span className="mono">{codex.error}</span>. Install it with <span className="mono">npm i -g @openai/codex</span>.</p>
          ) : (
            <p>
              Codex {codex.version} is installed but not signed in, so agent runs will fail. Run <span className="mono">codex login</span> in a terminal, or start the runtime with
              <span className="mono"> OPENAI_API_KEY</span> set, then click the Codex status chip to re-check.
            </p>
          )}
        </Section>
      )}
      {status && !status.voice.configured && (
        <p className="muted small">Voice input: {status.voice.reason} Everything also works with keyboard and pointer.</p>
      )}
    </div>
  );
}

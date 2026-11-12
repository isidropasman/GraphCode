import type { Provenance, TaskPhase } from "@graphcode/protocol";
import type { ReactNode } from "react";

const PROV_LABEL: Record<Provenance, { label: string; title: string }> = {
  observed: { label: "Observed", title: "GraphCode observed this directly (git, a command it ran, or your action)." },
  provider: { label: "Reported by Codex", title: "The agent runtime reported that this happened. GraphCode did not run it itself." },
  agent: { label: "Agent claim", title: "The agent says this. It has not been verified." },
  inferred: { label: "Derived", title: "GraphCode derived this deterministically from observed data." },
  user: { label: "You", title: "You stated this." },
};

export function Prov({ p }: { p: Provenance }) {
  const { label, title } = PROV_LABEL[p];
  return (
    <span className={`prov prov-${p}`} title={title}>
      {label}
    </span>
  );
}

const PHASE_LABEL: Record<TaskPhase, string> = {
  draft: "Draft",
  preparing: "Preparing",
  running: "Agent working",
  needs_approval: "Needs your approval",
  review: "Ready for review",
  integrated: "Committed",
  failed: "Failed",
  interrupted: "Interrupted",
  unknown: "Unknown",
};

export function PhaseBadge({ phase }: { phase: TaskPhase }) {
  return <span className={`phase phase-${phase}`}>{PHASE_LABEL[phase]}</span>;
}

export function Section({ title, aside, children, id, className }: { title: ReactNode; aside?: ReactNode; children: ReactNode; id?: string; className?: string }) {
  return (
    <section className={`section ${className ?? ""}`} id={id}>
      <header className="section-head">
        <h2>{title}</h2>
        {aside && <div className="section-aside">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export const short = (sha: string | null | undefined, n = 8) => (sha ? sha.slice(0, n) : "unknown");

export function ago(iso: string | null | undefined) {
  if (!iso) return "unknown";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function duration(ms: number | null | undefined) {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

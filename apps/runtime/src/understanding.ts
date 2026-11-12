import { createHash } from "node:crypto";
import type {
  ChangeSnapshot,
  EngineeringDecision,
  Evidence,
  Risk,
  TaskState,
  TechnicalConcept,
  Understanding,
  WorkItem,
} from "@graphcode/protocol";

/**
 * JSON Schema the agent's final message must follow for implement runs (Codex `outputSchema`).
 * Everything parsed from it is an agent assertion, never a verified fact.
 */
export const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "decisions", "assumptions", "risks", "concepts", "verification"],
  properties: {
    summary: { type: "string", description: "2-4 sentences: what changed and why, for a reviewer." },
    decisions: {
      type: "array",
      description: "Only real technical choices you made where a reasonable alternative existed. Empty if none.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "chosen", "rationale", "alternatives", "assumptions", "files"],
        properties: {
          question: { type: "string" },
          chosen: { type: "string" },
          rationale: { type: "string" },
          alternatives: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "description", "why_not"],
              properties: { label: { type: "string" }, description: { type: "string" }, why_not: { type: "string" } },
            },
          },
          assumptions: { type: "array", items: { type: "string" } },
          files: { type: "array", items: { type: "string" } },
        },
      },
    },
    assumptions: { type: "array", items: { type: "string" } },
    risks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail", "severity", "files"],
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          files: { type: "array", items: { type: "string" } },
        },
      },
    },
    concepts: {
      type: "array",
      description: "Technical concepts a reviewer may need explained to understand this change.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["term", "explanation"],
        properties: { term: { type: "string" }, explanation: { type: "string" } },
      },
    },
    verification: {
      type: "object",
      additionalProperties: false,
      required: ["commands_run", "suggested_command", "not_verified"],
      properties: {
        commands_run: { type: "array", items: { type: "string" } },
        suggested_command: { type: ["string", "null"] },
        not_verified: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

export type AgentReview = {
  summary: string;
  decisions: { question: string; chosen: string; rationale: string; alternatives: { label: string; description: string; why_not: string }[]; assumptions: string[]; files: string[] }[];
  assumptions: string[];
  risks: { title: string; detail: string; severity: "low" | "medium" | "high"; files: string[] }[];
  concepts: { term: string; explanation: string }[];
  verification: { commands_run: string[]; suggested_command: string | null; not_verified: string[] };
};

export function parseAgentReview(text: string | null): AgentReview | null {
  if (!text) return null;
  const candidates = [text.trim(), /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]?.trim()].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      const v = JSON.parse(c) as Partial<AgentReview>;
      if (v && typeof v.summary === "string" && Array.isArray(v.decisions)) {
        return {
          summary: v.summary,
          decisions: (v.decisions ?? []).filter((d) => d && typeof d.question === "string"),
          assumptions: v.assumptions ?? [],
          risks: v.risks ?? [],
          concepts: v.concepts ?? [],
          verification: v.verification ?? { commands_run: [], suggested_command: null, not_verified: [] },
        };
      }
    } catch {
      /* not JSON; try next candidate */
    }
  }
  return null;
}

const hid = (prefix: string, ...parts: string[]) => `${prefix}_${createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 12)}`;

function refs(files: string[], snapshot: ChangeSnapshot | null) {
  const changed = new Set(snapshot?.changes.map((c) => c.path) ?? []);
  return files.map((f) => {
    const clean = f.replace(/^\.\//, "").replace(/:(\d+)$/, "");
    const line = /:(\d+)$/.exec(f)?.[1];
    const match = changed.has(clean) ? clean : [...changed].find((c) => c.endsWith(clean) || clean.endsWith(c)) ?? clean;
    return { path: match, line: line ? Number(line) : null };
  });
}

function normCmd(c: string) {
  return c.replace(/\s+/g, " ").trim();
}

/**
 * Builds the reviewable understanding of a task from three separated sources:
 * agent assertions (structured final message), deterministic inferences over the observed
 * diff, and observed evidence. Nothing is filled in to make a view look complete.
 */
export function buildUnderstanding(state: TaskState, runId: string | null): Understanding {
  const snapshot = state.snapshot;
  const run = runId ? state.runs.find((r) => r.id === runId) : [...state.runs].reverse().find((r) => r.kind !== "question" && r.status === "completed");
  const review = parseAgentReview(run?.finalMessage ?? null);
  const items: WorkItem[] = run ? state.items[run.id] ?? [] : [];
  const evidenceOnRevision = (e: Evidence) => !snapshot || !e.revision || e.revision.treeSha === snapshot.revision.treeSha;
  const diffEvidence = state.evidence.filter((e) => e.type === "git_diff" && evidenceOnRevision(e));
  const tests = state.evidence.filter((e): e is Extract<Evidence, { type: "test" }> => e.type === "test");
  const testsOnRevision = tests.filter(evidenceOnRevision);
  const agentStatement = state.evidence.find((e) => e.type === "agent_statement" && run && e.runId === run.id);

  const decisions: EngineeringDecision[] = [];
  const risks: Risk[] = [];
  const concepts: TechnicalConcept[] = [];
  const unknowns: string[] = [];

  if (review) {
    for (const d of review.decisions) {
      const selectedId = hid("alt", d.question, d.chosen);
      decisions.push({
        id: hid("dec", d.question),
        question: d.question,
        alternatives: [
          { id: selectedId, label: d.chosen, description: d.rationale, consequences: [] },
          ...d.alternatives.map((a) => ({ id: hid("alt", d.question, a.label), label: a.label, description: a.description, consequences: a.why_not ? [a.why_not] : [] })),
        ],
        selectedAlternativeId: selectedId,
        rationale: d.rationale,
        assumptions: d.assumptions,
        tradeoffs: [],
        evidenceIds: [...diffEvidence.map((e) => e.id), ...(agentStatement ? [agentStatement.id] : [])],
        fileRefs: refs(d.files, snapshot),
        status: "proposed",
        provenance: "agent",
        captured: "after_run",
        userNote: null,
      });
    }
    for (const a of review.assumptions) {
      risks.push({ id: hid("asm", a), kind: "assumption", title: a, detail: "Stated by the agent as an assumption it relied on.", severity: "unknown", provenance: "agent", fileRefs: [], evidenceIds: agentStatement ? [agentStatement.id] : [] });
    }
    for (const r of review.risks) {
      risks.push({ id: hid("rsk", r.title), kind: "risk", title: r.title, detail: r.detail, severity: r.severity, provenance: "agent", fileRefs: refs(r.files, snapshot), evidenceIds: agentStatement ? [agentStatement.id] : [] });
    }
    for (const nv of review.verification.not_verified) {
      risks.push({ id: hid("gap", nv), kind: "verification_gap", title: nv, detail: "The agent reports this was not verified.", severity: "unknown", provenance: "agent", fileRefs: [], evidenceIds: [] });
    }
    for (const c of review.concepts) {
      concepts.push({ id: hid("con", c.term), term: c.term, explanation: c.explanation, provenance: "agent", fileRefs: [] });
    }
    // Cross-check agent claims about commands against commands the provider actually reported.
    const observed = items.filter((i) => i.kind === "command").map((i) => normCmd(i.command ?? ""));
    for (const claimed of review.verification.commands_run) {
      const c = normCmd(claimed);
      if (c && !observed.some((o) => o.includes(c) || c.includes(o))) {
        risks.push({
          id: hid("claim", c),
          kind: "verification_gap",
          title: `Agent says it ran \`${claimed}\`, but no matching command execution was reported`,
          detail: "The claim is not backed by an observed command event in this run. Treat any result it implies as unverified.",
          severity: "medium",
          provenance: "inferred",
          fileRefs: [],
          evidenceIds: [],
        });
      }
    }
  } else if (run) {
    unknowns.push(run.finalMessage ? "The agent's final message was not in the requested structured format, so decisions and risks were not extracted from it." : "The agent produced no final message.");
  }

  if (snapshot) {
    const src = snapshot.changes.filter((c) => c.category === "source");
    const testChanges = snapshot.changes.filter((c) => c.category === "test");
    if (src.length > 0 && testChanges.length === 0) {
      risks.push({
        id: hid("inf", "no-tests"),
        kind: "verification_gap",
        title: "Source changed without any test file changes",
        detail: `${src.length} source file(s) changed and no files recognized as tests were added or modified.`,
        severity: "medium",
        provenance: "inferred",
        fileRefs: src.map((c) => ({ path: c.path, line: c.hunks[0]?.newStart ?? null })),
        evidenceIds: diffEvidence.map((e) => e.id),
      });
    }
    const deps = snapshot.changes.filter((c) => c.category === "dependency");
    if (deps.length) {
      risks.push({
        id: hid("inf", "deps"),
        kind: "risk",
        title: "Dependency manifests changed",
        detail: `Review new or updated dependencies in ${deps.map((d) => d.path).join(", ")}.`,
        severity: "medium",
        provenance: "inferred",
        fileRefs: deps.map((c) => ({ path: c.path, line: c.hunks[0]?.newStart ?? null })),
        evidenceIds: diffEvidence.map((e) => e.id),
      });
    }
    const deleted = snapshot.changes.filter((c) => c.status === "deleted");
    if (deleted.length) {
      risks.push({
        id: hid("inf", "deleted"),
        kind: "risk",
        title: `${deleted.length} file(s) deleted`,
        detail: deleted.map((d) => d.path).join(", "),
        severity: "medium",
        provenance: "inferred",
        fileRefs: deleted.map((c) => ({ path: c.path, line: null })),
        evidenceIds: diffEvidence.map((e) => e.id),
      });
    }
    const config = snapshot.changes.filter((c) => c.category === "config");
    if (config.length) {
      risks.push({
        id: hid("inf", "config"),
        kind: "risk",
        title: "Configuration changed",
        detail: config.map((c) => c.path).join(", "),
        severity: "low",
        provenance: "inferred",
        fileRefs: config.map((c) => ({ path: c.path, line: c.hunks[0]?.newStart ?? null })),
        evidenceIds: diffEvidence.map((e) => e.id),
      });
    }
    if (snapshot.totals.files === 0) unknowns.push("The worktree has no changes relative to the base commit.");

    if (testsOnRevision.length === 0) {
      risks.push({
        id: hid("inf", "unverified"),
        kind: "verification_gap",
        title: tests.length ? "Verification results are for an older revision" : "No verification command has been run by GraphCode",
        detail: tests.length
          ? `The code changed after the last verification run (tree ${tests[tests.length - 1]!.revision?.treeSha.slice(0, 10)} → ${snapshot.revision.treeSha.slice(0, 10)}).`
          : "Run a verification command from the Evidence view to record an observed result for this exact revision.",
        severity: "medium",
        provenance: "inferred",
        fileRefs: [],
        evidenceIds: [],
      });
    } else {
      const last = testsOnRevision[testsOnRevision.length - 1]!;
      if (last.exitCode !== 0) {
        risks.push({
          id: hid("inf", "verify-failed"),
          kind: "risk",
          title: `\`${last.command}\` ${last.timedOut ? "timed out" : `exited with code ${last.exitCode}`}`,
          detail: "The most recent verification on this exact revision did not succeed.",
          severity: "high",
          provenance: "observed",
          fileRefs: [],
          evidenceIds: [last.id],
        });
      }
    }
    const nonAnalyzed = snapshot.changes.filter((c) => c.status !== "deleted" && !/\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(c.path) && c.category === "source");
    if (nonAnalyzed.length) unknowns.push(`Dependency relationships were not analyzed for ${nonAnalyzed.length} source file(s) in languages GraphCode cannot parse yet.`);
  } else {
    unknowns.push("Changes have not been captured yet.");
  }

  return {
    revision: snapshot?.revision ?? null,
    generatedAt: new Date().toISOString(),
    summary: review ? { text: review.summary, provenance: "agent" } : null,
    decisions,
    risks,
    concepts,
    unknowns,
  };
}

export function agentSuggestedCommand(state: TaskState): string | null {
  const run = [...state.runs].reverse().find((r) => r.kind !== "question" && r.status === "completed");
  return parseAgentReview(run?.finalMessage ?? null)?.verification.suggested_command ?? null;
}

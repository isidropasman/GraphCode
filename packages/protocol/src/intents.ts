/**
 * Voice Intent Router: maps a transcript (plus what is on screen) to a typed application
 * action. Deterministic and local on purpose: navigation must be instant and predictable,
 * and nothing here can approve, merge, or run anything by itself.
 */

export type ViewKind =
  | "objective"
  | "execution"
  | "semantic-diff"
  | "decision-comparison"
  | "risk"
  | "evidence"
  | "system-map"
  | "concept-explainer"
  | "code";

export type IntentRisk = "navigation" | "question" | "mutation" | "blocked";

export type VoiceIntent =
  | { type: "objective.create"; text: string }
  | { type: "agent.instruct"; text: string }
  | { type: "view.show"; view: ViewKind }
  | { type: "view.focus"; objectType: "decision" | "change" | "risk" | "concept" | "evidence"; objectId: string }
  | { type: "decision.explain"; decisionId: string | null; text: string }
  | { type: "decision.compare"; decisionId: string | null }
  | { type: "concept.explain"; term: string; text: string }
  | { type: "evidence.show"; objectId: string | null }
  | { type: "code.open"; path: string | null }
  | { type: "verification.run" }
  | { type: "question.ask"; text: string }
  | { type: "navigation.back" }
  | { type: "blocked"; text: string; reason: string }
  | { type: "unrecognized"; text: string };

export type RoutedIntent = {
  intent: VoiceIntent;
  risk: IntentRisk;
  /** Mutations always require the user to confirm an editable transcript. */
  requiresConfirmation: boolean;
};

export type IntentContext = {
  hasTask: boolean;
  runActive: boolean;
  selected: { type: "decision" | "change" | "risk" | "concept" | "evidence"; id: string; label?: string; path?: string } | null;
  decisions: { id: string; question: string; alternatives: string[] }[];
  changedFiles: string[];
  concepts: { id: string; term: string }[];
};

const norm = (s: string) => s.toLowerCase().replace(/[“”"'`]/g, "").replace(/\s+/g, " ").trim();

function tokens(s: string): Set<string> {
  return new Set(norm(s).split(/[^a-z0-9_.\-/]+/).filter((t) => t.length > 2));
}

function bestMatch<T>(text: string, candidates: T[], label: (c: T) => string): T | null {
  const t = tokens(text);
  let best: T | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const ct = tokens(label(c));
    let score = 0;
    for (const w of ct) if (t.has(w)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore > 0 ? best : null;
}

const DANGEROUS = /\b(approve|accept|merge|push|deploy|delete|remove|force|reset|rebase|discard|commit|integrate|ship|rm -rf|drop)\b/;
const QUESTION_START = /^(what|why|how|which|where|when|who|is|are|does|do|did|can|could|should|would|will|explain|tell me|walk me)\b/;
const BUILD_START = /^(build|implement|add|create|make|write|fix|refactor|change|update|rename|introduce|support|migrate|remove)\b/;

export function routeUtterance(raw: string, ctx: IntentContext): RoutedIntent {
  const text = raw.trim();
  const t = norm(text);
  const nav = (intent: VoiceIntent): RoutedIntent => ({ intent, risk: "navigation", requiresConfirmation: false });
  const ask = (intent: VoiceIntent): RoutedIntent => ({ intent, risk: "question", requiresConfirmation: false });
  const mutate = (intent: VoiceIntent): RoutedIntent => ({ intent, risk: "mutation", requiresConfirmation: true });

  if (!t) return { intent: { type: "unrecognized", text }, risk: "navigation", requiresConfirmation: false };

  // Voice never approves privileged operations. Checked before anything else.
  if (DANGEROUS.test(t) && !QUESTION_START.test(t) && !BUILD_START.test(t)) {
    return {
      intent: { type: "blocked", text, reason: "Approvals, commits, merges and destructive actions require a pointer or keyboard confirmation." },
      risk: "blocked",
      requiresConfirmation: false,
    };
  }

  if (/^(go )?back$|^go back\b|^previous( view)?$/.test(t)) return nav({ type: "navigation.back" });

  if (/\b(run|rerun|re-run|execute)\b.*\b(tests?|verification|checks?|build)\b/.test(t)) return mutate({ type: "verification.run" });

  if (/\b(what changed|show (me )?(the )?(parts that )?changed|show (me )?(the )?changes|the diff|what did (you|it) change)\b/.test(t))
    return nav({ type: "view.show", view: "semantic-diff" });
  if (/\b(risks?|what could break|could break|might break|unsafe|danger|unknowns?|assumptions?)\b/.test(t) && !/^why\b/.test(t))
    return nav({ type: "view.show", view: "risk" });
  if (/\b(evidence|test results?|did (the )?tests? pass|verification|proof)\b/.test(t))
    return nav({ type: "evidence.show", objectId: ctx.selected?.type === "evidence" ? ctx.selected.id : null });
  if (/\b(progress|what is it doing|what.?s it doing|execution|status|live)\b/.test(t) && !QUESTION_START.test(t.replace(/^what is it doing/, "")))
    return nav({ type: "view.show", view: "execution" });
  if (/\b(map|architecture|dependencies|dependency graph|impact|components?)\b/.test(t) && /^(show|open|go to|view|display)\b/.test(t))
    return nav({ type: "view.show", view: "system-map" });
  if (/^(show|open|go to)\b.*\b(objective|goal)\b/.test(t)) return nav({ type: "view.show", view: "objective" });
  if (/^(show|open|go to)\b.*\bdecisions?\b/.test(t)) return nav({ type: "view.show", view: "decision-comparison" });

  if (/\bcompare\b/.test(t)) {
    const d = bestMatch(t, ctx.decisions, (x) => `${x.question} ${x.alternatives.join(" ")}`);
    const id = d?.id ?? (ctx.selected?.type === "decision" ? ctx.selected.id : null) ?? ctx.decisions[0]?.id ?? null;
    return nav({ type: "decision.compare", decisionId: id });
  }

  if (/^(open|show)\b.*\b(code|file|source|lines?)\b/.test(t) || /^open\b/.test(t)) {
    const file = bestMatch(t, ctx.changedFiles, (f) => f.replace(/[/.\-_]/g, " "));
    return nav({ type: "code.open", path: file ?? ctx.selected?.path ?? null });
  }

  if (/^why\b/.test(t)) {
    const d = bestMatch(t, ctx.decisions, (x) => `${x.question} ${x.alternatives.join(" ")}`);
    const id = d?.id ?? (ctx.selected?.type === "decision" ? ctx.selected.id : null);
    return ask({ type: "decision.explain", decisionId: id, text });
  }

  const explain = /^(explain|what is|what are|what does|define|tell me about)\s+(.*?)\??$/.exec(t);
  if (explain && ctx.hasTask) {
    const subject = (explain[2] ?? "").replace(/^(the|a|an|this)\s+/, "");
    const c = bestMatch(subject, ctx.concepts, (x) => x.term);
    if (c) return ask({ type: "concept.explain", term: c.term, text });
    if (/^(this|that|it)( (dependency|decision|change|file|risk))?$/.test(subject) || subject === "")
      return ask({ type: "question.ask", text });
    return ask({ type: "concept.explain", term: subject, text });
  }

  if (ctx.hasTask && (QUESTION_START.test(t) || text.endsWith("?"))) return ask({ type: "question.ask", text });

  if (BUILD_START.test(t)) {
    if (ctx.hasTask && !ctx.runActive) return mutate({ type: "agent.instruct", text });
    if (!ctx.hasTask) return mutate({ type: "objective.create", text });
    return mutate({ type: "agent.instruct", text });
  }

  if (!ctx.hasTask) return mutate({ type: "objective.create", text });
  return { intent: { type: "unrecognized", text }, risk: "navigation", requiresConfirmation: false };
}

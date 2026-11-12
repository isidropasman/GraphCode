import { z } from "zod";

/**
 * Where a piece of information comes from. The GUI renders these distinctly and
 * never upgrades one to another:
 * - observed: GraphCode itself observed it (git, a command it ran, a user approval).
 * - provider: the agent runtime reported it happened (e.g. Codex says a command exited 0).
 * - agent: the agent claims it (rationale, summaries, suggested decisions).
 * - inferred: GraphCode derived it deterministically from observed data.
 * - user: the user stated it.
 */
export const Provenance = z.enum(["observed", "provider", "agent", "inferred", "user"]);
export type Provenance = z.infer<typeof Provenance>;

export const Project = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  addedAt: z.string(),
  lastOpenedAt: z.string(),
});
export type Project = z.infer<typeof Project>;

export const VerificationCandidate = z.object({
  command: z.string(),
  source: z.enum(["package.json", "Cargo.toml", "go.mod", "pyproject", "Makefile", "agent", "user"]),
  reason: z.string(),
});
export type VerificationCandidate = z.infer<typeof VerificationCandidate>;

export const RepoInspection = z.object({
  path: z.string(),
  isGitRepo: z.boolean(),
  headSha: z.string().nullable(),
  branch: z.string().nullable(),
  dirty: z.object({ staged: z.number(), unstaged: z.number(), untracked: z.number() }),
  recentCommits: z.array(z.object({ sha: z.string(), subject: z.string(), author: z.string(), date: z.string() })),
  languages: z.array(z.object({ ext: z.string(), files: z.number() })),
  trackedFiles: z.number(),
  verificationCandidates: z.array(VerificationCandidate),
  inspectedAt: z.string(),
});
export type RepoInspection = z.infer<typeof RepoInspection>;

export const Objective = z.object({
  text: z.string().min(1),
  constraints: z.array(z.string()),
  source: z.enum(["text", "voice"]),
});
export type Objective = z.infer<typeof Objective>;

export const Worktree = z.object({
  path: z.string(),
  branch: z.string(),
  baseRef: z.string(),
  baseSha: z.string(),
  createdAt: z.string(),
});
export type Worktree = z.infer<typeof Worktree>;

export const Task = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  objective: Objective,
  createdAt: z.string(),
});
export type Task = z.infer<typeof Task>;

export const RunKind = z.enum(["implement", "question", "instruct"]);
export const RunStatus = z.enum(["starting", "running", "completed", "failed", "interrupted", "unknown"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const AgentRun = z.object({
  id: z.string(),
  taskId: z.string(),
  kind: RunKind,
  prompt: z.string(),
  provider: z.string(),
  providerVersion: z.string().nullable(),
  threadId: z.string().nullable(),
  turnId: z.string().nullable(),
  model: z.string().nullable(),
  status: RunStatus,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  error: z.string().nullable(),
  finalMessage: z.string().nullable(),
});
export type AgentRun = z.infer<typeof AgentRun>;

export const FileChangeKind = z.enum(["add", "delete", "update"]);

export const WorkItem = z.object({
  id: z.string(),
  runId: z.string(),
  kind: z.enum(["command", "file_change", "message", "reasoning", "plan", "tool", "web_search", "other"]),
  status: z.enum(["in_progress", "completed", "failed", "declined"]),
  title: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  durationMs: z.number().nullable().optional(),
  output: z.string().optional(),
  files: z.array(z.object({ path: z.string(), kind: FileChangeKind, diff: z.string() })).optional(),
  text: z.string().optional(),
  providerType: z.string(),
});
export type WorkItem = z.infer<typeof WorkItem>;

export const PlanStep = z.object({
  step: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const ApprovalRequest = z.object({
  id: z.string(),
  runId: z.string(),
  kind: z.enum(["command", "file_change", "permissions", "other"]),
  summary: z.string(),
  command: z.string().nullable(),
  cwd: z.string().nullable(),
  reason: z.string().nullable(),
  files: z.array(z.string()),
  status: z.enum(["pending", "accepted", "declined", "cancelled", "resolved_elsewhere", "expired"]),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export const DiffHunk = z.object({
  header: z.string(),
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
});

export const ChangeCategory = z.enum(["source", "test", "config", "docs", "dependency", "other"]);
export type ChangeCategory = z.infer<typeof ChangeCategory>;

export const CodeChange = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  insertions: z.number(),
  deletions: z.number(),
  binary: z.boolean(),
  category: ChangeCategory,
  hunks: z.array(DiffHunk),
});
export type CodeChange = z.infer<typeof CodeChange>;

/** Exact identification of the code a fact refers to. */
export const Revision = z.object({
  baseSha: z.string(),
  /** git tree object of the full worktree contents (tracked + untracked, honoring .gitignore). */
  treeSha: z.string(),
});
export type Revision = z.infer<typeof Revision>;

export const ChangeSnapshot = z.object({
  revision: Revision,
  capturedAt: z.string(),
  changes: z.array(CodeChange),
  totals: z.object({ files: z.number(), insertions: z.number(), deletions: z.number() }),
  /** Static import edges between changed files and files they reference (observed from source text). */
  imports: z.array(z.object({ from: z.string(), to: z.string(), specifier: z.string() })),
});
export type ChangeSnapshot = z.infer<typeof ChangeSnapshot>;

const EvidenceBase = z.object({
  id: z.string(),
  taskId: z.string(),
  provenance: Provenance,
  title: z.string(),
  reference: z.string(),
  revision: Revision.nullable(),
  observedAt: z.string(),
});

export const Evidence = z.discriminatedUnion("type", [
  EvidenceBase.extend({
    type: z.literal("git_diff"),
    totals: z.object({ files: z.number(), insertions: z.number(), deletions: z.number() }),
  }),
  EvidenceBase.extend({
    type: z.literal("test"),
    command: z.string(),
    cwd: z.string(),
    exitCode: z.number().nullable(),
    timedOut: z.boolean(),
    durationMs: z.number(),
    outputTail: z.string(),
    /** What the command can and cannot tell us. Never claims more than "this command exited with this code". */
    scope: z.string(),
  }),
  EvidenceBase.extend({
    type: z.literal("command"),
    command: z.string(),
    cwd: z.string(),
    exitCode: z.number().nullable(),
    durationMs: z.number().nullable(),
    outputTail: z.string(),
    workItemId: z.string(),
  }),
  EvidenceBase.extend({
    type: z.literal("agent_statement"),
    text: z.string(),
    runId: z.string(),
  }),
  EvidenceBase.extend({
    type: z.literal("approval"),
    decision: z.string(),
    subject: z.string(),
  }),
]);
export type Evidence = z.infer<typeof Evidence>;
export type EvidenceType = Evidence["type"];

export const FileRef = z.object({
  path: z.string(),
  line: z.number().nullable(),
});
export type FileRef = z.infer<typeof FileRef>;

export const Alternative = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  consequences: z.array(z.string()),
});
export type Alternative = z.infer<typeof Alternative>;

export const Tradeoff = z.object({
  dimension: z.string(),
  note: z.string(),
});

export const EngineeringDecision = z.object({
  id: z.string(),
  question: z.string(),
  alternatives: z.array(Alternative),
  selectedAlternativeId: z.string().nullable(),
  rationale: z.string().nullable(),
  assumptions: z.array(z.string()),
  tradeoffs: z.array(Tradeoff),
  evidenceIds: z.array(z.string()),
  fileRefs: z.array(FileRef),
  status: z.enum(["proposed", "reviewed", "approved", "rejected"]),
  provenance: Provenance,
  /** "after_run" means the decision was reconstructed from the result rather than captured as it was made. */
  captured: z.enum(["before_run", "during_run", "after_run"]),
  userNote: z.string().nullable(),
});
export type EngineeringDecision = z.infer<typeof EngineeringDecision>;

export const Risk = z.object({
  id: z.string(),
  kind: z.enum(["risk", "assumption", "verification_gap", "unknown"]),
  title: z.string(),
  detail: z.string(),
  severity: z.enum(["low", "medium", "high", "unknown"]),
  provenance: Provenance,
  fileRefs: z.array(FileRef),
  evidenceIds: z.array(z.string()),
});
export type Risk = z.infer<typeof Risk>;

export const TechnicalConcept = z.object({
  id: z.string(),
  term: z.string(),
  explanation: z.string(),
  provenance: Provenance,
  fileRefs: z.array(FileRef),
});
export type TechnicalConcept = z.infer<typeof TechnicalConcept>;

export const Understanding = z.object({
  revision: Revision.nullable(),
  generatedAt: z.string(),
  summary: z.object({ text: z.string(), provenance: Provenance }).nullable(),
  decisions: z.array(EngineeringDecision),
  risks: z.array(Risk),
  concepts: z.array(TechnicalConcept),
  /** Things GraphCode explicitly could not determine. */
  unknowns: z.array(z.string()),
});
export type Understanding = z.infer<typeof Understanding>;

export const QuestionContext = z.object({
  objectType: z.enum(["decision", "risk", "change", "evidence", "concept", "task"]).nullable(),
  objectId: z.string().nullable(),
  view: z.string().nullable(),
});
export type QuestionContext = z.infer<typeof QuestionContext>;

export const Question = z.object({
  id: z.string(),
  runId: z.string(),
  text: z.string(),
  source: z.enum(["text", "voice"]),
  context: QuestionContext,
  askedAt: z.string(),
});
export type Question = z.infer<typeof Question>;

export const Integration = z.object({
  commitSha: z.string(),
  branch: z.string(),
  message: z.string(),
  revision: Revision,
  approvedAt: z.string(),
});
export type Integration = z.infer<typeof Integration>;

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { taskPhase } from "@graphcode/protocol";
import type { AgentEvent, AgentProvider, RunHandle, RunRequest } from "../src/agents/types";
import type { RuntimeConfig } from "../src/config";
import { Database } from "../src/db";
import { Orchestrator } from "../src/orchestrator";
import { EventStore } from "../src/store";

/**
 * Test double for the agent provider. It is only used here to exercise orchestration
 * deterministically; the product always runs the real Codex adapter.
 */
class ScriptedProvider implements AgentProvider {
  readonly id = "scripted-test";
  requests: RunRequest[] = [];
  async status() {
    return { available: true, version: "test", binary: null, account: null, requiresAuth: false, error: null };
  }
  async startRun(req: RunRequest, emit: (e: AgentEvent) => void): Promise<RunHandle> {
    this.requests.push(req);
    setTimeout(() => {
      emit({ type: "bound", threadId: "thread-1", turnId: `turn-${this.requests.length}`, model: "test-model", providerVersion: "test" });
      if (req.access === "read-only") {
        emit({ type: "finished", status: "completed", error: null, finalMessage: "greet() lives in src/greet.js:1." });
        return;
      }
      emit({ type: "plan", explanation: null, steps: [{ step: "Add greet", status: "completed" }] });
      fs.mkdirSync(path.join(req.cwd, "src"), { recursive: true });
      fs.writeFileSync(path.join(req.cwd, "src/greet.js"), "export function greet(name) {\n  return `Hello, ${name}!`;\n}\n");
      const cmd = { id: "c1", kind: "command" as const, title: "npm test", command: "npm test", cwd: req.cwd, providerType: "commandExecution", startedAt: null };
      emit({ type: "item_started", item: { ...cmd, status: "in_progress", completedAt: null } });
      emit({ type: "item_completed", item: { ...cmd, status: "completed", completedAt: new Date().toISOString(), exitCode: 0, durationMs: 10, output: "ok" } });
      emit({
        type: "finished",
        status: "completed",
        error: null,
        finalMessage: JSON.stringify({
          summary: "Added greet().",
          decisions: [{ question: "Template literal or concatenation?", chosen: "Template literal", rationale: "Matches style", alternatives: [{ label: "Concatenation", description: "a + b", why_not: "less readable" }], assumptions: ["Names are strings"], files: ["src/greet.js"] }],
          assumptions: ["Callers pass a non-empty name"],
          risks: [],
          concepts: [{ term: "ES modules", explanation: "import/export syntax" }],
          verification: { commands_run: ["npm test", "npm run lint"], suggested_command: "npm test", not_verified: ["Unicode names"] },
        }),
      });
    }, 5);
    return { interrupt: async () => {}, respondApproval: async () => {} };
  }
  async shutdown() {}
}

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const until = async (fn: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};

let tmp: string;
let repo: string;
let config: RuntimeConfig;

beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Test";
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "test@example.com";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "graphcode-test-"));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "demo", type: "module", scripts: { test: "node test.js" } }));
  fs.writeFileSync(path.join(repo, "test.js"), "import fs from 'node:fs';\nif (!fs.existsSync('src/greet.js')) { console.error('missing greet'); process.exit(1); }\nconsole.log('ok');\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "init");
  config = { dataDir: tmp, dbPath: path.join(tmp, "state.sqlite"), worktreesDir: path.join(tmp, "wt"), connectionFile: path.join(tmp, "runtime.json"), host: "127.0.0.1", port: 0, codexBinary: "codex", verificationTimeoutMs: 30_000 };
  fs.mkdirSync(config.worktreesDir);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("orchestrator vertical slice (scripted provider)", () => {
  it("runs objective → worktree → run → changes → understanding → verification → commit → reopen", async () => {
    const db = new Database(config.dbPath);
    const store = new EventStore(db);
    const provider = new ScriptedProvider();
    const orch = new Orchestrator(db, store, provider, config);

    const { project, inspection } = await orch.openProject(repo);
    expect(inspection.branch).toBe("main");
    expect(inspection.verificationCandidates.map((c) => c.command)).toContain("npm test");

    const task = await orch.createTask(project.id, { text: "Add a greet function", constraints: ["No dependencies"], source: "voice" }, true);
    await until(() => !!store.get(task.id)?.understanding);
    let s = store.get(task.id)!;

    expect(s.worktree!.path.startsWith(config.worktreesDir)).toBe(true);
    expect(sh(repo, "status", "--porcelain")).toBe(""); // user's checkout untouched
    expect(provider.requests[0]!.prompt).toContain("No dependencies");
    expect(provider.requests[0]!.cwd).toBe(s.worktree!.path);
    expect(taskPhase(s)).toBe("review");
    expect(s.snapshot!.changes.map((c) => c.path)).toEqual(["src/greet.js"]);
    expect(s.evidence.find((e) => e.type === "command")?.provenance).toBe("provider");
    expect(s.evidence.find((e) => e.type === "agent_statement")?.provenance).toBe("agent");

    const u = s.understanding!;
    expect(u.decisions[0]).toMatchObject({ provenance: "agent", captured: "after_run" });
    expect(u.decisions[0]!.fileRefs[0]!.path).toBe("src/greet.js");
    // The agent claimed it ran lint, but no such command was observed.
    expect(u.risks.some((r) => r.kind === "verification_gap" && r.title.includes("npm run lint"))).toBe(true);
    // Source changed, no test file changed.
    expect(u.risks.some((r) => r.provenance === "inferred" && r.kind === "verification_gap")).toBe(true);

    const { evidenceId } = await orch.runVerification(task.id, "npm test");
    s = store.get(task.id)!;
    const ev = s.evidence.find((e) => e.id === evidenceId)!;
    expect(ev).toMatchObject({ type: "test", provenance: "observed", exitCode: 0 });
    expect(ev.revision!.treeSha).toBe(s.snapshot!.revision.treeSha);

    const file = await orch.fileContents(task.id, "src/greet.js");
    expect(file.original).toBeNull();
    expect(file.modified).toContain("greet");

    const { questionId } = await orch.ask(task.id, "Where is greet defined?", "voice", { objectType: "change", objectId: "src/greet.js", view: "review" });
    await until(() => store.get(task.id)!.runs.filter((r) => r.kind === "question").every((r) => r.status === "completed"));
    expect(provider.requests[1]!.access).toBe("read-only");
    expect(provider.requests[1]!.threadId).toBe("thread-1");
    expect(store.get(task.id)!.questions[0]!.id).toBe(questionId);

    orch.reviewDecision(task.id, u.decisions[0]!.id, "approved", null, "fine");
    const { commitSha } = await orch.commit(task.id, "Add greet");
    expect(sh(s.worktree!.path, "rev-parse", "HEAD")).toBe(commitSha);
    expect(sh(repo, "rev-parse", "main")).not.toBe(commitSha); // never merged

    db.close();
    const db2 = new Database(config.dbPath);
    const store2 = new EventStore(db2);
    const s2 = store2.get(task.id)!;
    expect(taskPhase(s2)).toBe("integrated");
    expect(s2.understanding!.decisions[0]!.status).toBe("approved");
    expect(s2.evidence.length).toBe(s.evidence.length + 1);
    db2.close();
  });

  it("marks runs active at shutdown as unknown on restart", async () => {
    const db = new Database(config.dbPath);
    const store = new EventStore(db);
    const hanging: AgentProvider = {
      id: "hang",
      status: async () => ({ available: true, version: null, binary: null, account: null, requiresAuth: false, error: null }),
      startRun: async (_req, emit) => {
        emit({ type: "bound", threadId: "t", turnId: "u", model: null, providerVersion: null });
        return { interrupt: async () => {}, respondApproval: async () => {} };
      },
      shutdown: async () => {},
    };
    const orch = new Orchestrator(db, store, hanging, config);
    const project = db.projects()[0]!;
    const task = await orch.createTask(project.id, { text: "Hang forever", constraints: [], source: "text" }, true);
    expect(taskPhase(store.get(task.id)!)).toBe("running");
    db.close();

    const db2 = new Database(config.dbPath);
    const store2 = new EventStore(db2);
    new Orchestrator(db2, store2, hanging, config).recover();
    expect(taskPhase(store2.get(task.id)!)).toBe("interrupted");
    expect(store2.get(task.id)!.runs[0]!.error).toMatch(/could not be reattached/);
    db2.close();
  });

  it("refuses to start a task in a repository without commits", async () => {
    const empty = path.join(tmp, "empty");
    fs.mkdirSync(empty);
    sh(empty, "init", "-q");
    const db = new Database(config.dbPath);
    const orch = new Orchestrator(db, new EventStore(db), new ScriptedProvider(), config);
    const { project } = await orch.openProject(empty);
    await expect(orch.createTask(project.id, { text: "x", constraints: [], source: "text" }, true)).rejects.toThrow(/commit/i);
    db.close();
  });
});

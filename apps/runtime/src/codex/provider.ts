import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { AgentEvent, AgentProvider, ApprovalAsk, ProviderStatus, RunHandle, RunRequest } from "../agents/types";
import { CodexTransport, type RpcId } from "./jsonrpc";
import { translateItem, translatePlan } from "./translate";
import type { InitializeResponse } from "./generated/InitializeResponse";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse";
import type { ItemStartedNotification } from "./generated/v2/ItemStartedNotification";
import type { ItemCompletedNotification } from "./generated/v2/ItemCompletedNotification";
import type { TurnCompletedNotification } from "./generated/v2/TurnCompletedNotification";
import type { TurnPlanUpdatedNotification } from "./generated/v2/TurnPlanUpdatedNotification";
import type { ErrorNotification } from "./generated/v2/ErrorNotification";
import type { AgentMessageDeltaNotification } from "./generated/v2/AgentMessageDeltaNotification";
import type { CommandExecutionOutputDeltaNotification } from "./generated/v2/CommandExecutionOutputDeltaNotification";
import type { CommandExecutionRequestApprovalParams } from "./generated/v2/CommandExecutionRequestApprovalParams";
import type { FileChangeRequestApprovalParams } from "./generated/v2/FileChangeRequestApprovalParams";
import type { ServerRequestResolvedNotification } from "./generated/v2/ServerRequestResolvedNotification";
import type { TurnStartParams } from "./generated/v2/TurnStartParams";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams";

export const CLIENT_INFO = { name: "graphcode", title: "GraphCode", version: "0.1.0" };

function generatedVersion(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const p of [path.join(here, "generated", "CODEX_VERSION"), path.join(here, "codex", "generated", "CODEX_VERSION")]) {
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
    }
  } catch {
    /* bundled builds may not carry the file; compatibility check is then skipped */
  }
  return null;
}

type Session = {
  runId: string;
  threadId: string;
  turnId: string | null;
  emit: (e: AgentEvent) => void;
  approvals: Map<string, { rpcId: RpcId; kind: ApprovalAsk["kind"] }>;
  fileChangeItems: Map<string, string[]>;
  lastAgentMessage: string | null;
  finished: boolean;
};

/**
 * Codex App Server adapter. One long-lived `codex app-server` process is shared by all
 * runs; notifications are routed to runs by threadId. If the process dies, every active
 * run is finished as failed and the next run starts a fresh process (resuming threads).
 */
export class CodexProvider implements AgentProvider {
  readonly id = "codex";
  private transport: CodexTransport | null = null;
  private ready: Promise<InitializeResponse> | null = null;
  private sessions = new Map<string, Session>(); // by threadId
  private loadedThreads = new Set<string>();
  private serverVersion: string | null = null;
  private readonly expectedVersion = generatedVersion();

  constructor(private readonly binary: string, private readonly log: (msg: string) => void = () => {}) {}

  private resolveBinary(): string | null {
    try {
      return execFileSync("sh", ["-c", `command -v ${JSON.stringify(this.binary)}`], { encoding: "utf8" }).trim() || null;
    } catch {
      return null;
    }
  }

  private connect(): Promise<InitializeResponse> {
    if (this.ready && this.transport && !this.transport.exited) return this.ready;
    const t = new CodexTransport(this.binary);
    this.transport = t;
    this.loadedThreads.clear();
    t.on("notification", (m, p) => this.onNotification(m, p));
    t.on("request", (id, m, p) => this.onServerRequest(id, m, p));
    t.on("protocolError", (msg) => {
      this.log(`[codex] protocol error: ${msg}`);
      for (const s of this.sessions.values()) s.emit({ type: "warning", message: `Codex protocol error: ${msg}` });
    });
    t.on("exit", ({ code, signal, stderrTail }) => {
      this.log(`[codex] app-server exited code=${code} signal=${signal}`);
      const tail = stderrTail.trim().split("\n").slice(-3).join("\n");
      for (const s of this.sessions.values()) {
        if (!s.finished) {
          s.finished = true;
          s.emit({ type: "finished", status: "failed", error: `Codex app-server exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}). ${tail}`.trim(), finalMessage: s.lastAgentMessage });
        }
      }
      this.sessions.clear();
      this.ready = null;
    });
    t.start();
    this.ready = (async () => {
      const init = await t.request<InitializeResponse>("initialize", {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      t.notify("initialized");
      const m = /\/(\d+\.\d+\.\d+)/.exec(init.userAgent);
      this.serverVersion = m?.[1] ?? null;
      return init;
    })();
    this.ready.catch(() => {
      this.ready = null;
    });
    return this.ready;
  }

  private compatibilityWarning(): string | null {
    if (!this.expectedVersion || !this.serverVersion) return null;
    const [a1, a2] = this.expectedVersion.split(".");
    const [b1, b2] = this.serverVersion.split(".");
    return a1 !== b1 || a2 !== b2
      ? `Installed Codex ${this.serverVersion} differs from the protocol bindings GraphCode was built against (${this.expectedVersion}). Regenerate with scripts/generate-codex-protocol.sh if events look wrong.`
      : null;
  }

  async status(): Promise<ProviderStatus> {
    const binary = this.resolveBinary();
    if (!binary) {
      return { available: false, version: null, binary: null, account: null, requiresAuth: true, error: `Codex CLI not found (looked for "${this.binary}" on PATH). Install with: npm i -g @openai/codex` };
    }
    try {
      await this.connect();
      const acct = await this.transport!.request<GetAccountResponse>("account/read", { refreshToken: false });
      const a = acct.account;
      const account = a
        ? { type: a.type, label: a.type === "chatgpt" ? a.email ?? a.workspaceName ?? "ChatGPT" : a.type === "apiKey" ? "API key" : a.type }
        : null;
      return {
        available: true,
        version: this.serverVersion,
        binary,
        account,
        requiresAuth: acct.requiresOpenaiAuth && !account,
        error: this.compatibilityWarning(),
      };
    } catch (err) {
      return { available: false, version: this.serverVersion, binary, account: null, requiresAuth: true, error: (err as Error).message };
    }
  }

  async startRun(req: RunRequest, emit: (e: AgentEvent) => void): Promise<RunHandle> {
    await this.connect();
    const t = this.transport!;
    const compat = this.compatibilityWarning();
    if (compat) emit({ type: "warning", message: compat });

    let threadId: string;
    let model: string | null = null;
    const threadParams: Partial<ThreadStartParams> = {
      cwd: req.cwd,
      approvalPolicy: "on-request",
      sandbox: req.access,
      developerInstructions: req.developerInstructions,
    };
    if (req.threadId && this.loadedThreads.has(req.threadId)) {
      threadId = req.threadId;
    } else if (req.threadId) {
      const r = await t.request<ThreadResumeResponse>("thread/resume", { threadId: req.threadId, ...threadParams, excludeTurns: true });
      threadId = r.thread.id;
      model = r.model;
    } else {
      const r = await t.request<ThreadStartResponse>("thread/start", { ...threadParams, ephemeral: false });
      threadId = r.thread.id;
      model = r.model;
    }
    this.loadedThreads.add(threadId);
    if (this.sessions.has(threadId)) throw new Error("Another run is already active on this agent thread.");

    const session: Session = {
      runId: req.runId,
      threadId,
      turnId: null,
      emit,
      approvals: new Map(),
      fileChangeItems: new Map(),
      lastAgentMessage: null,
      finished: false,
    };
    this.sessions.set(threadId, session);

    const turnParams: TurnStartParams = {
      threadId,
      input: [{ type: "text", text: req.prompt, text_elements: [] }],
      cwd: req.cwd,
      approvalPolicy: "on-request",
      sandboxPolicy:
        req.access === "read-only"
          ? { type: "readOnly", networkAccess: false }
          : { type: "workspaceWrite", writableRoots: [req.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      outputSchema: (req.outputSchema ?? null) as TurnStartParams["outputSchema"],
    };
    try {
      const r = await t.request<TurnStartResponse>("turn/start", turnParams);
      session.turnId = r.turn.id;
      emit({ type: "bound", threadId, turnId: r.turn.id, model, providerVersion: this.serverVersion });
      if (r.turn.status !== "inProgress") this.finishFromTurn(session, r.turn.status, r.turn.error?.message ?? null);
    } catch (err) {
      this.sessions.delete(threadId);
      throw err;
    }

    return {
      interrupt: async () => {
        if (!session.turnId || session.finished) return;
        await t.request("turn/interrupt", { threadId, turnId: session.turnId });
      },
      respondApproval: async (approvalId, decision) => {
        const a = session.approvals.get(approvalId);
        if (!a) throw new Error("Approval request is no longer pending with the agent.");
        t.respond(a.rpcId, { decision });
        session.approvals.delete(approvalId);
        emit({ type: "approval_resolved", approvalId, status: decision === "accept" ? "accepted" : "declined" });
      },
    };
  }

  private finishFromTurn(s: Session, status: string, error: string | null) {
    if (s.finished) return;
    s.finished = true;
    this.sessions.delete(s.threadId);
    const mapped = status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed";
    s.emit({ type: "finished", status: mapped, error, finalMessage: s.lastAgentMessage });
  }

  private sessionFor(params: unknown): Session | undefined {
    const threadId = (params as { threadId?: string } | null)?.threadId;
    return threadId ? this.sessions.get(threadId) : undefined;
  }

  private onNotification(method: string, params: unknown) {
    const s = this.sessionFor(params);
    if (!s) return;
    switch (method) {
      case "item/started":
      case "item/completed": {
        const p = params as ItemStartedNotification | ItemCompletedNotification;
        if (s.turnId && p.turnId !== s.turnId) return;
        const phase = method === "item/started" ? "started" : "completed";
        if (p.item.type === "fileChange") s.fileChangeItems.set(p.item.id, p.item.changes.map((c) => c.path));
        if (p.item.type === "agentMessage" && phase === "completed") s.lastAgentMessage = p.item.text;
        const item = translateItem(p.item, phase);
        if (item) s.emit({ type: phase === "started" ? "item_started" : "item_completed", item });
        return;
      }
      case "turn/plan/updated": {
        const p = params as TurnPlanUpdatedNotification;
        s.emit({ type: "plan", explanation: p.explanation, steps: translatePlan(p.plan) });
        return;
      }
      case "item/agentMessage/delta": {
        const p = params as AgentMessageDeltaNotification;
        s.emit({ type: "delta", itemId: p.itemId, stream: "agent_message", delta: p.delta });
        return;
      }
      case "item/commandExecution/outputDelta": {
        const p = params as CommandExecutionOutputDeltaNotification;
        s.emit({ type: "delta", itemId: p.itemId, stream: "command_output", delta: p.delta });
        return;
      }
      case "item/reasoning/summaryTextDelta": {
        const p = params as { itemId: string; delta: string };
        s.emit({ type: "delta", itemId: p.itemId, stream: "reasoning", delta: p.delta });
        return;
      }
      case "error": {
        const p = params as ErrorNotification;
        s.emit({ type: "warning", message: `${p.willRetry ? "Retrying after error" : "Agent error"}: ${p.error.message}` });
        return;
      }
      case "serverRequest/resolved": {
        const p = params as ServerRequestResolvedNotification;
        for (const [approvalId, a] of s.approvals) {
          if (a.rpcId === p.requestId) {
            s.approvals.delete(approvalId);
            s.emit({ type: "approval_resolved", approvalId, status: "resolved_elsewhere" });
          }
        }
        return;
      }
      case "turn/completed": {
        const p = params as TurnCompletedNotification;
        if (s.turnId && p.turn.id !== s.turnId) return;
        this.finishFromTurn(s, p.turn.status, p.turn.error?.message ?? null);
        return;
      }
      default:
        return;
    }
  }

  private onServerRequest(id: RpcId, method: string, params: unknown) {
    const t = this.transport!;
    const s = this.sessionFor(params);
    if (!s) {
      t.respondError(id, -32603, "GraphCode has no active run for this thread");
      return;
    }
    const approvalId = randomUUID();
    if (method === "item/commandExecution/requestApproval") {
      const p = params as CommandExecutionRequestApprovalParams;
      if (p.kind !== "command") {
        t.respond(id, { decision: "decline" });
        s.emit({ type: "warning", message: `Declined unsupported ${p.kind} approval request.` });
        return;
      }
      s.approvals.set(approvalId, { rpcId: id, kind: "command" });
      s.emit({
        type: "approval_requested",
        approval: { id: approvalId, kind: "command", summary: p.command ?? "Run a command", command: p.command ?? null, cwd: p.cwd ?? null, reason: p.reason ?? null, files: [] },
      });
      return;
    }
    if (method === "item/fileChange/requestApproval") {
      const p = params as FileChangeRequestApprovalParams;
      const files = s.fileChangeItems.get(p.itemId) ?? [];
      s.approvals.set(approvalId, { rpcId: id, kind: "file_change" });
      s.emit({
        type: "approval_requested",
        approval: {
          id: approvalId, kind: "file_change",
          summary: p.grantRoot ? `Allow writes under ${p.grantRoot}` : `Apply changes to ${files.length || "some"} file(s)`,
          command: null, cwd: null, reason: p.reason ?? null, files,
        },
      });
      return;
    }
    // Requests GraphCode does not support yet are declined explicitly, never auto-approved.
    t.respondError(id, -32601, `GraphCode does not support ${method} yet`);
    s.emit({ type: "warning", message: `Agent asked for "${method}", which GraphCode does not support yet; it was refused.` });
  }

  async shutdown() {
    this.transport?.stop();
  }
}

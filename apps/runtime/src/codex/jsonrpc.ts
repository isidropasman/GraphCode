import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

export type RpcId = string | number;

export class CodexRpcError extends Error {
  constructor(readonly method: string, readonly code: number, message: string, readonly data?: unknown) {
    super(`${method}: ${message} (code ${code})`);
  }
}

type Pending = { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null };

export interface CodexTransportEvents {
  notification: [method: string, params: unknown];
  request: [id: RpcId, method: string, params: unknown];
  exit: [info: { code: number | null; signal: string | null; stderrTail: string }];
  protocolError: [message: string];
}

/**
 * Codex App Server transport: newline-delimited JSON-RPC 2.0 messages (without the
 * "jsonrpc" field) over the child's stdio. Correlates responses by id and surfaces
 * server-initiated requests (approvals) and notifications.
 */
export class CodexTransport extends EventEmitter<CodexTransportEvents> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<RpcId, Pending>();
  private stderrTail = "";
  exited = false;

  constructor(private readonly binary: string, private readonly args: string[] = ["app-server"]) {
    super();
  }

  start(): void {
    const child = spawn(this.binary, this.args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "warn" } });
    this.child = child;
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => this.onLine(line));
    child.stderr.on("data", (b: Buffer) => {
      this.stderrTail = (this.stderrTail + b.toString("utf8")).slice(-8000);
    });
    child.on("error", (err) => {
      this.stderrTail += `\n${err.message}`;
    });
    child.on("exit", (code, signal) => {
      this.exited = true;
      const err = new Error(`codex app-server exited (code ${code ?? "null"}, signal ${signal ?? "null"})`);
      for (const p of this.pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.emit("exit", { code, signal, stderrTail: this.stderrTail });
    });
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let msg: { id?: RpcId; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit("protocolError", `unparseable line from app-server: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      this.emit("request", msg.id, msg.method, msg.params);
    } else if (msg.method !== undefined) {
      this.emit("notification", msg.method, msg.params);
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) {
        this.emit("protocolError", `response for unknown id ${String(msg.id)}`);
        return;
      }
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new CodexRpcError(p.method, msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
    } else {
      this.emit("protocolError", `unrecognized message: ${line.slice(0, 200)}`);
    }
  }

  private write(obj: unknown) {
    if (!this.child || this.exited) throw new Error("codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  request<T>(method: string, params: unknown, timeoutMs: number | null = 60_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (err) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: RpcId, result: unknown) {
    this.write({ id, result });
  }

  respondError(id: RpcId, code: number, message: string) {
    this.write({ id, error: { code, message } });
  }

  stop() {
    if (this.child && !this.exited) {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
    }
  }
}

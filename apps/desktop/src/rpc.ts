import type { DomainEvent, LiveDelta, RpcMethodName, RpcParams, RpcResult, RuntimeConnectionInfo, ServerMessage } from "@graphcode/protocol";
import { RPC_PROTOCOL_VERSION } from "@graphcode/protocol";

export type ConnState = "connecting" | "connected" | "disconnected";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class RpcCallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** Typed client for the runtime's WebSocket RPC. Reconnects automatically; the runtime keeps running regardless. */
export class RuntimeClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private retry = 0;
  private closed = false;
  runtimeVersion: string | null = null;

  constructor(
    private readonly getInfo: () => Promise<RuntimeConnectionInfo>,
    private readonly handlers: {
      onState: (s: ConnState, detail?: string) => void;
      onEvent: (e: DomainEvent) => void;
      onDelta: (d: LiveDelta) => void;
    },
  ) {}

  async connect() {
    this.handlers.onState("connecting");
    let info: RuntimeConnectionInfo;
    try {
      info = await this.getInfo();
    } catch (err) {
      this.handlers.onState("disconnected", (err as Error).message);
      return this.scheduleReconnect();
    }
    const ws = new WebSocket(info.url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ kind: "hello", token: info.token, protocolVersion: RPC_PROTOCOL_VERSION }));
    ws.onmessage = (m) => this.onMessage(JSON.parse(String(m.data)) as ServerMessage);
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const p of this.pending.values()) p.reject(new RpcCallError("disconnected", "Lost connection to the runtime"));
      this.pending.clear();
      this.handlers.onState("disconnected", e.reason || `Runtime not reachable at ${info.url}`);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const delay = Math.min(5000, 400 * 2 ** this.retry++);
    setTimeout(() => void this.connect(), delay);
  }

  private onMessage(m: ServerMessage) {
    switch (m.kind) {
      case "welcome":
        this.retry = 0;
        this.runtimeVersion = m.runtimeVersion;
        this.handlers.onState("connected");
        return;
      case "result":
        this.pending.get(m.id)?.resolve(m.result);
        this.pending.delete(m.id);
        return;
      case "error":
        if (m.id != null) {
          this.pending.get(m.id)?.reject(new RpcCallError(m.error.code, m.error.message));
          this.pending.delete(m.id);
        }
        return;
      case "event":
        this.handlers.onEvent(m.event);
        return;
      case "delta":
        this.handlers.onDelta(m.delta);
        return;
    }
  }

  call<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new RpcCallError("disconnected", "Not connected to the runtime"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ kind: "call", id, method, params }));
    });
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function connectionInfo(): Promise<RuntimeConnectionInfo> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<RuntimeConnectionInfo>("runtime_connection");
  }
  const res = await fetch("/__graphcode/connection", { cache: "no-store" });
  const body = (await res.json()) as RuntimeConnectionInfo & { error?: string };
  if (!res.ok) throw new Error(body.error ?? "Runtime not found");
  return body;
}

export async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ directory: true, multiple: false, title: "Open a Git repository" });
  return typeof r === "string" ? r : null;
}

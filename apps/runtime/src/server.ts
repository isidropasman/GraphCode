import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { ClientMessage, RPC_PROTOCOL_VERSION, RpcMethods, type RpcMethodName, type RpcResult, type ServerMessage } from "@graphcode/protocol";
import type { z } from "zod";
import { RUNTIME_VERSION } from "./config";
import type { EventStore } from "./store";
import { UserError } from "./orchestrator";

export type Handlers = { [M in RpcMethodName]: (params: z.infer<(typeof RpcMethods)[M]["params"]>) => Promise<RpcResult<M>> | RpcResult<M> };

const ALLOWED_ORIGIN = /^(tauri:\/\/localhost|https?:\/\/tauri\.localhost|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;

/**
 * Typed RPC over a local WebSocket. Binds to loopback only, requires the per-start token
 * from the connection file, and rejects browser origins other than the GUI.
 */
export function startServer(opts: { host: string; port: number; token: string; handlers: Handlers; store: EventStore; log: (m: string) => void }) {
  const { host, port, token, handlers, store, log } = opts;
  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: "graphcode-runtime", version: RUNTIME_VERSION }));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  const clients = new Set<WebSocket>();

  httpServer.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin;
    if (req.url !== "/rpc" || (origin && !ALLOWED_ORIGIN.test(origin))) {
      log(`[rpc] rejected upgrade url=${req.url} origin=${origin}`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    let authed = false;
    const send = (m: ServerMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    const authTimer = setTimeout(() => !authed && ws.close(4401, "auth timeout"), 5000);
    ws.on("close", () => {
      clients.delete(ws);
      clearTimeout(authTimer);
    });
    ws.on("message", async (raw) => {
      let msg: ClientMessage;
      try {
        msg = ClientMessage.parse(JSON.parse(String(raw)));
      } catch (err) {
        send({ kind: "error", id: null, error: { code: "bad_message", message: (err as Error).message } });
        return;
      }
      if (msg.kind === "hello") {
        if (msg.token !== token) {
          ws.close(4401, "bad token");
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        clients.add(ws);
        send({ kind: "welcome", protocolVersion: RPC_PROTOCOL_VERSION, runtimeVersion: RUNTIME_VERSION });
        return;
      }
      if (!authed) {
        ws.close(4401, "unauthenticated");
        return;
      }
      const def = RpcMethods[msg.method as RpcMethodName];
      if (!def) {
        send({ kind: "error", id: msg.id, error: { code: "unknown_method", message: `Unknown method ${msg.method}` } });
        return;
      }
      const parsed = def.params.safeParse(msg.params ?? {});
      if (!parsed.success) {
        send({ kind: "error", id: msg.id, error: { code: "invalid_params", message: parsed.error.message } });
        return;
      }
      try {
        const handler = handlers[msg.method as RpcMethodName] as (p: unknown) => Promise<unknown>;
        const result = await handler(parsed.data);
        send({ kind: "result", id: msg.id, result });
      } catch (err) {
        const e = err as Error;
        if (!(err instanceof UserError)) log(`[rpc] ${msg.method} failed: ${e.stack ?? e.message}`);
        send({ kind: "error", id: msg.id, error: { code: err instanceof UserError ? err.code : "internal", message: e.message } });
      }
    });
  });

  store.subscribe({
    onEvent(event) {
      const data = JSON.stringify({ kind: "event", event } satisfies ServerMessage);
      for (const c of clients) c.readyState === c.OPEN && c.send(data);
    },
    onDelta(delta) {
      const data = JSON.stringify({ kind: "delta", delta } satisfies ServerMessage);
      for (const c of clients) c.readyState === c.OPEN && c.send(data);
    },
  });

  return new Promise<http.Server>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve(httpServer));
  });
}

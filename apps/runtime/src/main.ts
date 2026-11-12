import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { RPC_PROTOCOL_VERSION, type RuntimeConnectionInfo } from "@graphcode/protocol";
import { CodexProvider } from "./codex/provider";
import { loadConfig, RUNTIME_VERSION } from "./config";
import { Database } from "./db";
import { Orchestrator } from "./orchestrator";
import { startServer, type Handlers } from "./server";
import { EventStore } from "./store";
import { OpenAITranscription } from "./voice";

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

async function main() {
  const config = loadConfig();
  const startedAt = new Date().toISOString();

  try {
    const res = await fetch(`http://${config.host}:${config.port}/health`, { signal: AbortSignal.timeout(800) });
    if (res.ok) {
      log(`A GraphCode runtime is already listening on ${config.host}:${config.port}; exiting.`);
      return;
    }
  } catch {
    /* nothing listening: continue */
  }

  const db = new Database(config.dbPath);
  const store = new EventStore(db);
  const provider = new CodexProvider(config.codexBinary, log);
  const stt = new OpenAITranscription(process.env.OPENAI_API_KEY);
  const orch = new Orchestrator(db, store, provider, config, log);
  orch.recover();

  const handlers: Handlers = {
    "system.status": async () => ({
      runtimeVersion: RUNTIME_VERSION,
      protocolVersion: RPC_PROTOCOL_VERSION,
      dataDir: config.dataDir,
      startedAt,
      codex: await provider.status(),
      voice: stt.status(),
    }),
    "project.list": () => db.projects(),
    "project.open": ({ path }) => orch.openProject(path),
    "project.inspect": ({ projectId }) => orch.inspectProject(projectId),
    "task.list": ({ projectId }) => orch.listTasks(projectId),
    "task.get": ({ taskId }) => orch.requireTask(taskId),
    "task.create": ({ projectId, objective, start }) => orch.createTask(projectId, objective, start),
    "task.updateObjective": ({ taskId, objective }) => (orch.updateObjective(taskId, objective), { ok: true as const }),
    "task.start": ({ taskId }) => orch.startTask(taskId),
    "run.interrupt": async ({ taskId }) => (await orch.interrupt(taskId), { ok: true as const }),
    "run.instruct": ({ taskId, text }) => orch.instruct(taskId, text),
    "approval.respond": async ({ taskId, approvalId, decision }) => (await orch.respondApproval(taskId, approvalId, decision), { ok: true as const }),
    "changes.refresh": async ({ taskId }) => (await orch.refreshChanges(taskId), { ok: true as const }),
    "changes.file": ({ taskId, path }) => orch.fileContents(taskId, path),
    "verification.candidates": ({ taskId }) => orch.verificationCandidates(taskId),
    "verification.run": ({ taskId, command }) => orch.runVerification(taskId, command),
    "question.ask": ({ taskId, text, source, context }) => orch.ask(taskId, text, source, context),
    "decision.review": ({ taskId, decisionId, status, selectedAlternativeId, note }) => (orch.reviewDecision(taskId, decisionId, status, selectedAlternativeId, note), { ok: true as const }),
    "integration.commit": ({ taskId, message }) => orch.commit(taskId, message),
    "voice.transcribe": async ({ audioBase64, mimeType }) => {
      const t0 = Date.now();
      const text = await stt.transcribe(Buffer.from(audioBase64, "base64"), mimeType);
      return { text, provider: stt.id, durationMs: Date.now() - t0 };
    },
  };

  const token = randomBytes(24).toString("hex");
  const server = await startServer({ host: config.host, port: config.port, token, handlers, store, log });
  const info: RuntimeConnectionInfo = { url: `ws://${config.host}:${config.port}/rpc`, token, pid: process.pid, startedAt, version: RUNTIME_VERSION };
  fs.writeFileSync(config.connectionFile, JSON.stringify(info, null, 2), { mode: 0o600 });
  log(`GraphCode runtime ${RUNTIME_VERSION} listening on ${info.url} (data: ${config.dataDir})`);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`Received ${signal}; shutting down.`);
    orch.shutdown();
    await provider.shutdown();
    server.close();
    try {
      const cur = JSON.parse(fs.readFileSync(config.connectionFile, "utf8")) as RuntimeConnectionInfo;
      if (cur.pid === process.pid) fs.unlinkSync(config.connectionFile);
    } catch {
      /* already gone */
    }
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

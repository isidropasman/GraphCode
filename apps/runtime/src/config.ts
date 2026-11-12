import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const RUNTIME_VERSION = "0.1.0";

export type RuntimeConfig = {
  dataDir: string;
  dbPath: string;
  worktreesDir: string;
  connectionFile: string;
  host: string;
  port: number;
  codexBinary: string;
  verificationTimeoutMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const dataDir = path.resolve(env.GRAPHCODE_HOME ?? path.join(os.homedir(), ".graphcode"));
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const worktreesDir = path.join(dataDir, "worktrees");
  fs.mkdirSync(worktreesDir, { recursive: true });
  return {
    dataDir,
    dbPath: path.join(dataDir, "state.sqlite"),
    worktreesDir,
    connectionFile: path.join(dataDir, "runtime.json"),
    host: "127.0.0.1",
    port: Number(env.GRAPHCODE_PORT ?? 47120),
    codexBinary: env.GRAPHCODE_CODEX_BIN ?? "codex",
    verificationTimeoutMs: Number(env.GRAPHCODE_VERIFY_TIMEOUT_MS ?? 10 * 60_000),
  };
}

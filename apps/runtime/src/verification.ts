import { spawn } from "node:child_process";

export type CommandResult = {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
};

const TAIL = 24_000;

/** Runs a user-confirmed verification command in the task worktree and records exactly what happened. */
export function runCommand(command: string, cwd: string, timeoutMs: number, onOutput?: (chunk: string) => void): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = "";
    let timedOut = false;
    const child = spawn(process.env.SHELL || "/bin/sh", ["-c", command], {
      cwd,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const onData = (b: Buffer) => {
      const s = b.toString("utf8");
      out = (out + s).slice(-TAIL);
      onOutput?.(s);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch (err) {
        onOutput?.(`\n[graphcode] failed to terminate process group: ${String(err)}\n`);
      }
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ command, cwd, exitCode: null, signal: null, timedOut, durationMs: Date.now() - started, outputTail: `${out}\n[graphcode] failed to start: ${err.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ command, cwd, exitCode: code, signal, timedOut, durationMs: Date.now() - started, outputTail: out });
    });
  });
}

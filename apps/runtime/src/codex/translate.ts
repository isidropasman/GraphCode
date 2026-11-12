import type { PlanStep, WorkItem } from "@graphcode/protocol";
import type { NormalizedItem } from "../agents/types";
import type { ThreadItem } from "./generated/v2/ThreadItem";
import type { TurnPlanStep } from "./generated/v2/TurnPlanStep";

const OUTPUT_LIMIT = 20_000;

const iso = (ms: number | null | undefined) => (typeof ms === "number" ? new Date(ms).toISOString() : null);

function mapStatus(s: string | undefined, phase: "started" | "completed"): WorkItem["status"] {
  switch (s) {
    case "inProgress":
      return phase === "completed" ? "completed" : "in_progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "declined":
      return "declined";
    default:
      return phase === "completed" ? "completed" : "in_progress";
  }
}

export function displayCommand(cmd: string): string {
  const m = /^(?:\/\S+\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(cmd.trim());
  return m ? m[2]! : cmd;
}

/** Codex ThreadItem → provider-independent WorkItem. Returns null for items that carry no execution meaning (echoed user input). */
export function translateItem(item: ThreadItem, phase: "started" | "completed"): NormalizedItem | null {
  const base = {
    id: item.id,
    startedAt: iso(item.startedAtMs),
    completedAt: phase === "completed" ? iso(item.completedAtMs) ?? new Date().toISOString() : null,
    providerType: item.type,
  };
  switch (item.type) {
    case "userMessage":
    case "hookPrompt":
      return null;
    case "commandExecution": {
      const out = item.aggregatedOutput ?? undefined;
      return {
        ...base,
        kind: "command",
        status: mapStatus(item.status, phase),
        title: displayCommand(item.command),
        command: displayCommand(item.command),
        cwd: item.cwd,
        exitCode: item.exitCode,
        durationMs: item.durationMs,
        output: out && out.length > OUTPUT_LIMIT ? `…${out.slice(-OUTPUT_LIMIT)}` : out,
      };
    }
    case "fileChange": {
      const files = item.changes.map((c) => ({ path: c.path, kind: c.kind.type, diff: c.diff }));
      const names = files.map((f) => f.path.split("/").pop()).slice(0, 3).join(", ");
      return {
        ...base,
        kind: "file_change",
        status: mapStatus(item.status, phase),
        title: `${files.length === 1 ? "Edit" : `Edit ${files.length} files`}: ${names}${files.length > 3 ? "…" : ""}`,
        files,
      };
    }
    case "agentMessage":
      return { ...base, kind: "message", status: mapStatus(undefined, phase), title: "Agent message", text: item.text };
    case "reasoning": {
      const text = item.summary.join("\n\n");
      return { ...base, kind: "reasoning", status: mapStatus(undefined, phase), title: "Reasoning summary", text };
    }
    case "plan":
      return { ...base, kind: "plan", status: mapStatus(undefined, phase), title: "Plan", text: item.text };
    case "mcpToolCall":
      return { ...base, kind: "tool", status: mapStatus(item.status, phase), title: `${item.server} · ${item.tool}` };
    case "dynamicToolCall":
      return { ...base, kind: "tool", status: mapStatus(item.status, phase), title: `${item.namespace ? `${item.namespace} · ` : ""}${item.tool}` };
    case "webSearch":
      return { ...base, kind: "web_search", status: mapStatus(undefined, phase), title: "Web search" };
    default:
      return { ...base, kind: "other", status: mapStatus(undefined, phase), title: humanize(item.type) };
  }
}

function humanize(t: string) {
  return t.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

export function translatePlan(steps: TurnPlanStep[]): PlanStep[] {
  return steps.map((s) => ({
    step: s.step,
    status: s.status === "inProgress" ? "in_progress" : s.status === "completed" ? "completed" : "pending",
  }));
}

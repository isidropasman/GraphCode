import type { PlanStep, WorkItem } from "@graphcode/protocol";

/**
 * Provider-independent agent contract. The orchestrator and the GUI only ever see these
 * normalized events; adapters translate provider-native protocols into them.
 */
export type ProviderStatus = {
  available: boolean;
  version: string | null;
  binary: string | null;
  account: { type: string; label: string | null } | null;
  requiresAuth: boolean;
  error: string | null;
};

export type NormalizedItem = Omit<WorkItem, "runId">;

export type ApprovalAsk = {
  id: string;
  kind: "command" | "file_change" | "permissions" | "other";
  summary: string;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  files: string[];
};

export type AgentEvent =
  | { type: "bound"; threadId: string; turnId: string | null; model: string | null; providerVersion: string | null }
  | { type: "plan"; explanation: string | null; steps: PlanStep[] }
  | { type: "item_started"; item: NormalizedItem }
  | { type: "item_completed"; item: NormalizedItem }
  | { type: "delta"; itemId: string; stream: "agent_message" | "command_output" | "reasoning" | "plan" | "file_change"; delta: string }
  | { type: "approval_requested"; approval: ApprovalAsk }
  | { type: "approval_resolved"; approvalId: string; status: "accepted" | "declined" | "cancelled" | "resolved_elsewhere" }
  | { type: "warning"; message: string }
  | { type: "finished"; status: "completed" | "failed" | "interrupted"; error: string | null; finalMessage: string | null };

export type RunRequest = {
  runId: string;
  cwd: string;
  prompt: string;
  developerInstructions: string;
  /** Read-only runs are used for questions about the result. */
  access: "workspace-write" | "read-only";
  outputSchema: unknown | null;
  /** Continue an existing provider conversation when present. */
  threadId: string | null;
};

export interface RunHandle {
  interrupt(): Promise<void>;
  respondApproval(approvalId: string, decision: "accept" | "decline"): Promise<void>;
}

export interface AgentProvider {
  readonly id: string;
  status(): Promise<ProviderStatus>;
  startRun(req: RunRequest, emit: (e: AgentEvent) => void): Promise<RunHandle>;
  shutdown(): Promise<void>;
}

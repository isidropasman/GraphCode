import { describe, expect, it } from "vitest";
import { routeUtterance, type IntentContext } from "../src";

const ctx: IntentContext = {
  hasTask: true,
  runActive: false,
  selected: null,
  decisions: [{ id: "d1", question: "How should sessions be stored?", alternatives: ["JWT", "Database sessions"] }],
  changedFiles: ["src/auth/session.ts", "src/server.ts"],
  concepts: [{ id: "c1", term: "token revocation" }],
};

describe("voice intent router", () => {
  it("routes navigation without confirmation", () => {
    expect(routeUtterance("Show me the parts that changed", ctx)).toMatchObject({ intent: { type: "view.show", view: "semantic-diff" }, requiresConfirmation: false });
    expect(routeUtterance("What are the risks?", ctx).intent).toMatchObject({ type: "view.show", view: "risk" });
    expect(routeUtterance("go back", ctx).intent.type).toBe("navigation.back");
    expect(routeUtterance("compare the two alternatives", ctx).intent).toMatchObject({ type: "decision.compare", decisionId: "d1" });
    expect(routeUtterance("open the session code", ctx).intent).toMatchObject({ type: "code.open", path: "src/auth/session.ts" });
  });

  it("routes questions to the matching decision or concept", () => {
    expect(routeUtterance("Why did you choose JWT?", ctx)).toMatchObject({ intent: { type: "decision.explain", decisionId: "d1" }, risk: "question" });
    expect(routeUtterance("Explain token revocation", ctx).intent).toMatchObject({ type: "concept.explain", term: "token revocation" });
    expect(routeUtterance("Explain this dependency", ctx).intent.type).toBe("question.ask");
  });

  it("requires confirmation for anything that changes code or runs commands", () => {
    expect(routeUtterance("Build an authentication system with revocable sessions", { ...ctx, hasTask: false })).toMatchObject({ intent: { type: "objective.create" }, risk: "mutation", requiresConfirmation: true });
    expect(routeUtterance("add rate limiting to login", ctx)).toMatchObject({ intent: { type: "agent.instruct" }, requiresConfirmation: true });
    expect(routeUtterance("run the tests", ctx)).toMatchObject({ intent: { type: "verification.run" }, requiresConfirmation: true });
  });

  it("never lets voice approve, merge or destroy", () => {
    for (const t of ["approve it", "merge the branch", "commit this", "push to main", "accept the command", "delete the worktree"]) {
      expect(routeUtterance(t, ctx).risk).toBe("blocked");
    }
  });
});

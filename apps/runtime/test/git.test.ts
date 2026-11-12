import { describe, expect, it } from "vitest";
import { categorize, extractImports, parseUnifiedHunks, slugify } from "../src/git";
import { displayCommand, translateItem, translatePlan } from "../src/codex/translate";

describe("git helpers", () => {
  it("categorizes files", () => {
    expect(categorize("src/a.ts")).toBe("source");
    expect(categorize("src/a.test.ts")).toBe("test");
    expect(categorize("package.json")).toBe("dependency");
    expect(categorize("README.md")).toBe("docs");
  });
  it("parses hunks per file", () => {
    const diff = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@ fn\n a\n+b\n";
    expect(parseUnifiedHunks(diff).get("x.ts")).toEqual([{ header: "fn", oldStart: 1, oldLines: 2, newStart: 1, newLines: 3 }]);
  });
  it("resolves relative imports textually and keeps package imports as-is", () => {
    const imports = extractImports("src/a.ts", 'import x from "./b";\nimport y from "react";\nconst z = require("../c.js");');
    expect(imports.map((i) => i.to).sort()).toEqual(["c.js", "react", "src/b"]);
  });
  it("slugifies", () => expect(slugify("Add JWT auth, please!")).toMatch(/^add-jwt-auth-please/));
});

describe("codex translation", () => {
  it("unwraps shell wrappers", () => expect(displayCommand("/bin/bash -lc 'npm test'")).toBe("npm test"));
  it("translates command items", () => {
    const item = translateItem({ type: "commandExecution", id: "i", command: "/bin/bash -lc 'ls'", cwd: "/w", processId: null, status: "completed", commandActions: [], aggregatedOutput: "a", exitCode: 0, durationMs: 3 } as never, "completed");
    expect(item).toMatchObject({ kind: "command", command: "ls", exitCode: 0, status: "completed" });
  });
  it("drops echoed user messages", () => expect(translateItem({ type: "userMessage", id: "u", clientId: null, content: [] } as never, "started")).toBeNull());
  it("normalizes plan status", () => expect(translatePlan([{ step: "a", status: "inProgress" }])).toEqual([{ step: "a", status: "in_progress" }]));
});

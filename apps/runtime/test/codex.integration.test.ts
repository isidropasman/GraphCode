import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CodexProvider } from "../src/codex/provider";

const bin = process.env.GRAPHCODE_CODEX_BIN ?? "codex";
let installed = false;
try {
  execFileSync(bin, ["--version"]);
  installed = true;
} catch {
  /* not installed */
}

describe.skipIf(!installed)("real Codex App Server", () => {
  it("handshakes and reports version and auth state", async () => {
    const p = new CodexProvider(bin, () => {});
    const s = await p.status();
    await p.shutdown();
    expect(s.available).toBe(true);
    expect(s.version).toMatch(/^\d+\.\d+/);
    expect(typeof s.requiresAuth).toBe("boolean");
  }, 30_000);
});

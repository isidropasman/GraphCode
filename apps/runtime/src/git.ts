import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChangeCategory, ChangeSnapshot, CodeChange, RepoInspection, Revision, VerificationCandidate, Worktree } from "@graphcode/protocol";

export class GitError extends Error {
  constructor(message: string, readonly args: string[], readonly stderr: string) {
    super(message);
  }
}

export function git(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; allowFail?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !opts.allowFail) {
          reject(new GitError(`git ${args.join(" ")} failed: ${stderr.trim() || err.message}`, args, stderr));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const out = await git(dir, ["rev-parse", "--is-inside-work-tree"], { allowFail: true }).catch(() => "");
  return out.trim() === "true";
}

export async function repoRoot(dir: string): Promise<string> {
  return (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
}

export async function inspectRepo(dir: string): Promise<RepoInspection> {
  const inspectedAt = new Date().toISOString();
  if (!(await isGitRepo(dir))) {
    return {
      path: dir, isGitRepo: false, headSha: null, branch: null,
      dirty: { staged: 0, unstaged: 0, untracked: 0 }, recentCommits: [], languages: [], trackedFiles: 0,
      verificationCandidates: detectVerification(dir), inspectedAt,
    };
  }
  const headSha = (await git(dir, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true })).trim() || null;
  const branch = (await git(dir, ["symbolic-ref", "--short", "-q", "HEAD"], { allowFail: true })).trim() || null;
  const status = await git(dir, ["status", "--porcelain=v1"]);
  const dirty = { staged: 0, unstaged: 0, untracked: 0 };
  for (const line of status.split("\n")) {
    if (!line) continue;
    if (line.startsWith("??")) dirty.untracked++;
    else {
      if (line[0] !== " ") dirty.staged++;
      if (line[1] !== " ") dirty.unstaged++;
    }
  }
  const log = headSha ? await git(dir, ["log", "-n", "8", "--format=%H%x1f%s%x1f%an%x1f%aI"]) : "";
  const recentCommits = log.split("\n").filter(Boolean).map((l) => {
    const [sha = "", subject = "", author = "", date = ""] = l.split("\x1f");
    return { sha, subject, author, date };
  });
  const files = (await git(dir, ["ls-files"])).split("\n").filter(Boolean);
  const counts = new Map<string, number>();
  for (const f of files) {
    const ext = path.extname(f).toLowerCase() || path.basename(f);
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  const languages = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([ext, n]) => ({ ext, files: n }));
  return { path: dir, isGitRepo: true, headSha, branch, dirty, recentCommits, languages, trackedFiles: files.length, verificationCandidates: detectVerification(dir), inspectedAt };
}

/** Commands the repository itself declares. Nothing here is executed without an explicit user action. */
export function detectVerification(dir: string): VerificationCandidate[] {
  const out: VerificationCandidate[] = [];
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
      for (const s of ["test", "typecheck", "lint", "build"]) {
        const script = pkg.scripts?.[s];
        if (script && !/no test specified/.test(script)) {
          out.push({ command: pm === "npm" && s !== "test" ? `npm run ${s}` : `${pm} ${s === "test" ? "test" : `run ${s}`}`, source: "package.json", reason: `scripts.${s}: ${script}` });
        }
      }
    } catch {
      out.push({ command: "npm test", source: "package.json", reason: "package.json present but could not be parsed" });
    }
  }
  if (has("Cargo.toml")) out.push({ command: "cargo test", source: "Cargo.toml", reason: "Rust crate" });
  if (has("go.mod")) out.push({ command: "go test ./...", source: "go.mod", reason: "Go module" });
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.cfg")) out.push({ command: "python -m pytest -q", source: "pyproject", reason: "Python project" });
  if (has("Makefile")) {
    const mk = fs.readFileSync(path.join(dir, "Makefile"), "utf8");
    if (/^test:/m.test(mk)) out.push({ command: "make test", source: "Makefile", reason: "Makefile has a test target" });
  }
  return out;
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "task";
}

export async function createWorktree(repo: string, worktreesDir: string, taskId: string, title: string): Promise<Worktree> {
  const baseSha = (await git(repo, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true })).trim();
  if (!baseSha) throw new Error("Repository has no commits yet. Create an initial commit before starting a task.");
  const baseRef = (await git(repo, ["symbolic-ref", "--short", "-q", "HEAD"], { allowFail: true })).trim() || baseSha;
  const short = taskId.slice(0, 8);
  const branch = `graphcode/${slugify(title)}-${short}`;
  const wtPath = path.join(worktreesDir, `${path.basename(repo)}-${short}`);
  if (fs.existsSync(wtPath)) throw new Error(`Worktree path already exists: ${wtPath}`);
  await git(repo, ["worktree", "add", "-b", branch, wtPath, baseSha]);
  return { path: wtPath, branch, baseRef, baseSha, createdAt: new Date().toISOString() };
}

/**
 * Content-addresses the full worktree (tracked + untracked, honoring .gitignore) without
 * touching the user's index: a throwaway index file is used for `git add -A` + `write-tree`.
 */
export async function snapshotRevision(worktree: string, baseSha: string): Promise<Revision> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "graphcode-idx-"));
  const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
  try {
    await git(worktree, ["read-tree", "HEAD"], { env });
    await git(worktree, ["add", "-A"], { env });
    const treeSha = (await git(worktree, ["write-tree"], { env })).trim();
    return { baseSha, treeSha };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function categorize(file: string): ChangeCategory {
  const f = file.toLowerCase();
  const base = path.basename(f);
  if (/(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.(toml|lock)|go\.(mod|sum)|requirements.*\.txt|poetry\.lock|pyproject\.toml|gemfile(\.lock)?)$/.test(f)) return "dependency";
  if (/(^|\/)(__tests__|tests?|spec)\//.test(f) || /\.(test|spec)\.[a-z]+$/.test(f) || /_test\.(go|py)$/.test(f) || /^test_.*\.py$/.test(base)) return "test";
  if (/\.(md|mdx|rst|txt|adoc)$/.test(f) || f.startsWith("docs/")) return "docs";
  if (/\.(json|ya?ml|toml|ini|cfg|conf|env|lock)$/.test(f) || base.startsWith(".") || /config\.[a-z]+$/.test(base) || base === "dockerfile" || base === "makefile") return "config";
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|rb|php|c|cc|cpp|h|hpp|cs|scala|vue|svelte|css|scss|html|sql|sh)$/.test(f)) return "source";
  return "other";
}

export function parseUnifiedHunks(diff: string): Map<string, CodeChange["hunks"]> {
  const result = new Map<string, CodeChange["hunks"]>();
  let current: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      current = p === "/dev/null" ? current : p.replace(/^b\//, "");
      if (current && !result.has(current)) result.set(current, []);
    } else if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      current = p === "/dev/null" ? null : p.replace(/^a\//, "");
    } else if (line.startsWith("@@") && current) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (!m) continue;
      if (!result.has(current)) result.set(current, []);
      result.get(current)!.push({
        header: (m[5] ?? "").trim(),
        oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]),
      });
    }
  }
  return result;
}

export async function captureChanges(worktree: string, baseSha: string): Promise<ChangeSnapshot> {
  const revision = await snapshotRevision(worktree, baseSha);
  const range = [baseSha, revision.treeSha];
  const nameStatus = await git(worktree, ["diff", "--name-status", "-M", "-z", ...range]);
  const numstat = await git(worktree, ["diff", "--numstat", "-M", "-z", ...range]);
  const unified = await git(worktree, ["diff", "-U0", "-M", "--no-color", ...range]);
  const hunks = parseUnifiedHunks(unified);

  const stats = new Map<string, { ins: number; del: number; binary: boolean }>();
  const ns = numstat.split("\0");
  for (let i = 0; i < ns.length; i++) {
    const entry = ns[i];
    if (!entry) continue;
    const [ins = "0", del = "0", p = ""] = entry.split("\t");
    let file = p;
    if (p === "") {
      // rename: "ins\tdel\t" followed by old\0new\0
      i += 2;
      file = ns[i] ?? "";
    }
    stats.set(file, { ins: ins === "-" ? 0 : Number(ins), del: del === "-" ? 0 : Number(del), binary: ins === "-" });
  }

  const changes: CodeChange[] = [];
  const parts = nameStatus.split("\0");
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    if (!code) continue;
    let oldPath: string | null = null;
    let file: string;
    if (code.startsWith("R") || code.startsWith("C")) {
      oldPath = parts[i++] ?? null;
      file = parts[i++] ?? "";
    } else {
      file = parts[i++] ?? "";
    }
    const st = stats.get(file) ?? { ins: 0, del: 0, binary: false };
    changes.push({
      path: file,
      oldPath,
      status: code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : code.startsWith("R") ? "renamed" : "modified",
      insertions: st.ins,
      deletions: st.del,
      binary: st.binary,
      category: categorize(file),
      hunks: hunks.get(file) ?? [],
    });
  }

  const imports: ChangeSnapshot["imports"] = [];
  for (const c of changes) {
    if (c.status === "deleted" || c.binary || !/\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(c.path)) continue;
    const content = await fileAt(worktree, revision.treeSha, c.path);
    if (content) imports.push(...extractImports(c.path, content));
  }

  return {
    revision,
    capturedAt: new Date().toISOString(),
    changes,
    totals: {
      files: changes.length,
      insertions: changes.reduce((a, c) => a + c.insertions, 0),
      deletions: changes.reduce((a, c) => a + c.deletions, 0),
    },
    imports,
  };
}

/** Static, textual import extraction. Only relative specifiers are resolved; nothing is guessed. */
export function extractImports(file: string, content: string): ChangeSnapshot["imports"] {
  const out: ChangeSnapshot["imports"] = [];
  const dir = path.posix.dirname(file);
  const seen = new Set<string>();
  const add = (spec: string) => {
    if (seen.has(spec)) return;
    seen.add(spec);
    const to = spec.startsWith(".") ? path.posix.normalize(path.posix.join(dir, spec)) : spec;
    out.push({ from: file, to, specifier: spec });
  };
  if (file.endsWith(".py")) {
    for (const m of content.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) add((m[1] ?? m[2])!);
  } else {
    for (const m of content.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      add((m[1] ?? m[2] ?? m[3] ?? m[4])!);
    }
  }
  return out;
}

export async function fileAt(repo: string, rev: string, file: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["show", `${rev}:${file}`], { cwd: repo, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

export async function commitAll(worktree: string, message: string): Promise<string> {
  await git(worktree, ["add", "-A"]);
  await git(worktree, ["commit", "-m", message]);
  return (await git(worktree, ["rev-parse", "HEAD"])).trim();
}

export function languageFor(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", md: "markdown", py: "python", rs: "rust", go: "go", css: "css", scss: "scss", html: "html",
    yml: "yaml", yaml: "yaml", toml: "ini", sh: "shell", sql: "sql", java: "java", rb: "ruby", c: "c", h: "c", cpp: "cpp",
  };
  return map[ext] ?? "plaintext";
}

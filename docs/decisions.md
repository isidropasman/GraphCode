# Engineering decisions (v0)

Each entry: decision, alternatives considered, why.

1. **Runtime as an independent Node.js process, GUI talks to it over a local WebSocket.**
   Alternatives: Tauri Rust backend; logic inside React. Node lets the runtime reuse the Zod
   contracts and the reducer the GUI uses, and it survives window reloads. WebSocket gives
   push events for both Tauri and browser mode.

2. **Event log in SQLite as the source of truth; projections derived by a shared pure reducer.**
   Alternative: mutable task rows. Events give replay, crash recovery and an audit trail of who
   decided what. Uses Node's built-in `node:sqlite` (no native addon build step). Trade-off:
   `node:sqlite` is newer than better-sqlite3; Node ≥ 22.13 required.

3. **One worktree + branch per task, created from the repository's HEAD.**
   Untracked/uncommitted user changes are not carried over (shown on Project Home). Worktrees
   are isolation for review, not security: Codex sandboxing and approvals still apply.

4. **Revision = base commit + git tree of the whole worktree.** Computed with a temporary index,
   so evidence can be pinned to exact content without committing.

5. **Decisions come from the agent's structured final message, labeled `after_run`.**
   Codex App Server does not emit decision events, so GraphCode asks for a JSON report via
   `outputSchema` and labels every entry as an agent claim reconstructed after the work. No
   decisions are synthesized when the agent reports none.

6. **Deterministic risks over LLM-generated ones.** GraphCode adds only risks it can derive from
   observed data (diff categories, verification evidence, unmatched command claims).

7. **Questions run as read-only Codex turns in the same thread.** Gives the agent its own context;
   answers are marked as agent claims.

8. **Voice routing is deterministic and local.** STT is a replaceable provider; intent routing is
   rule-based so its safety behavior is testable. Dangerous verbs are blocked for voice.

9. **Commit, never merge/push.** Integration = commit on the task branch after explicit two-step
   confirmation. Hooks run.

10. **Monaco bundled locally** (no CDN) to stay local-first; only the base editor worker is
    bundled, so diff view has syntax highlighting but no language services.

11. **System map shows only observed relative-import edges** between changed files and what they
    import. No call graph or inferred architecture.

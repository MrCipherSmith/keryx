# Flow Journal

- 2026-09-23T05:23:48.097Z - flow created
- 2026-09-23T05:24:39.832Z - frozen: 5 criteria; checksum recorded
- 2026-09-23T05:24:40.073Z - started
- 2026-09-23T05:24:40.345Z - task-added: T5: Implement the frozen criteria
- 2026-09-23T05:24:40.601Z - task-added: T6: Verification: CI green, keryx health run
- 2026-09-23T05:24:40.867Z - task-attempt: T5: started (attempt 1)
- 2026-09-23T05:45:00.000Z - T5 implemented: moved the saved-credential-by-name strip into the one shared `buildMcpChildEnv` (src/mcp-servers/spawn-env.ts), which every launch surface (`keryx shell`'s `createMcpRuntime`, `keryx mcp doctor`, and ACP's `startAcpSessionMcp`) already funnels through via `defaultConnect`. Deleted the ACP-only duplicate `acpMcpParentEnv` (src/acp/session-mcp.ts) — one shared function now, not two copies (AC3). Explicit server `env` still applied last, so it wins over both strips (AC2). Added AC1/AC2 unit tests to spawn-env.test.ts (including one against the real `noteSavedCredentialEnv`/`savedCredentialEnvKeys` singleton) and a real-process end-to-end test in src/acp/mcp-servers.process.test.ts (extended fixtures/mcp-servers/echo-server.ts with an opt-in `ECHO_SERVER_REPORT_VAR` hook to observe a var's absence). Verified by hand that AC1's tests fail without the fix (temporarily commented out the `saved.has(key)` line, ran both suites, restored). Documented the env contract in docs/docs/cli-reference.md's "mcp (consumer)" section (AC4). typecheck clean; eslint clean on changed files; touched suites (spawn-env, session-mcp, mcp-servers.process, plus mcp-servers/, acp/, bus/ac10-child-env, harness/process/shell-env) all green, 1130+ pass. Mutation-sweep script (scripts/mutation-sweep.ts) could not be run: it refuses to start on a dirty src/ tree, and this worktree's rules forbid git add/commit/stash — substituted a manual single-mutant revert/restore cycle on the changed line instead.
- 2026-09-23T05:39:33.784Z - task-done: T5: Implement the frozen criteria

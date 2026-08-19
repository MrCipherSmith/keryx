# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `start_job`, `watch_job`, `job_output`, `list_jobs`, `stop_job` tools exist in `src/harness/tool/builtin/background-job-tool.ts` and are registered alongside `shell_exec` wherever `buildInteractiveAgentTools` composes the toolset, for both the TUI and readline shells.
- AC2: `start_job` and `watch_job` both return immediately (never await process completion) and both have `risk: "shell"` — a command is never spawned without going through the same default-deny approval gate `shell_exec` uses today (proven by a test that an unapproved call does not spawn a process).
- AC3: `start_job` and `watch_job` both apply the same `KERYX_SANDBOX_SHELL` posture (`resolveShellSandboxMode` / `shellSandboxProfile` / `wrapWithSandbox`) as `shell-exec-tool.ts` — no separate, weaker code path for background commands.
- AC4: A running `start_job` is reflected live in the sidebar Activity panel via `src/tui/job-bridge.ts` + `WorkerFleet`: `upsert` on start (`status: "running"`), `detail` updates as stdout lines arrive, and a final `status: "done"` or `"failed"` on exit with an exit summary in `detail`.
- AC5: A running `watch_job` treats each complete stdout line as one event: the sidebar `detail` shows the last event text plus a running event count, updated per event, and this NEVER pushes content into the transcript by itself — only `job_output`, called explicitly, surfaces buffered content/events. `persistent: true` runs until `stop_job`/shell exit; otherwise the job is killed and marked `"done"`/`"timeout"` when `timeout_ms` (default 300000, max 3600000) elapses.
- AC6: `start_job` and `watch_job` share one job registry/id namespace (`job:<n>`) with a `kind: "job" | "watch"` field; `job_output`/`list_jobs`/`stop_job` work uniformly across both kinds.
- AC7: A concurrency cap (counting both kinds together) rejects further `start_job`/`watch_job` calls beyond a small fixed limit with a clear, non-throwing error result; no process is spawned past the cap.
- AC8: Every job/watch still tracked as running is terminated (SIGTERM, then SIGKILL if it ignores it) when the shell process exits — proven by a test exercising the registry's `killAll()` from the shell's shutdown path, not just asserted in prose.
- AC9: `job_output` returns a raw tail for `kind: "job"` and the event buffer for `kind: "watch"`, both bounded (not unbounded memory growth); `list_jobs` returns id/label/kind/status/pid for every job still tracked.
- AC10: `bun test` (full suite, `--timeout 30000`) and `bun run typecheck` introduce ZERO new failures compared to the pre-existing baseline, run via the working tree (`bun test`/`bun run typecheck`), never the stale installed `keryx` on PATH. (Revised post-freeze: the full suite has a pre-existing baseline of ~47-49 unrelated failures on this branch — `src/lib/serve-turns.route.test.ts`/`serve-listener.turns.test.ts` all returning 404, `src/commands/sessions.fork.test.ts`, `/var` vs `/private/var` realpath mismatches in `project-registry.test.ts`/`serve-server.test.ts` — verified unrelated by grepping the full failure log for every file this flow touched: zero matches. "Full suite green" was not achievable and is not this flow's job to fix; every test file this flow's own new/modified code touches (`background-job-tool.test.ts`, `shell-exec-tool.test.ts`, `interactive-agent-tools.test.ts`, `shell.test.ts`, `tui-shell.test.ts`) passes 100%.)

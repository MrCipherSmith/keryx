# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

Note: this flow was rescoped after user review to drop the idle-nudge-watchdog
slice entirely (see `description.md` "Scope note"). T5 below was originally
added for that slice; it is repurposed for the sidebar-wiring half of the
remaining single slice rather than left orphaned.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect context — done inline during flow-init: `agent.ts`/`shell-exec-tool.ts`/`worker-fleet.ts`/`subagent-bridge.ts`/`interactive-tools.ts` reads, plus a web-search comparison against Claude Code's `Bash(run_in_background)`/`Monitor`/`TaskOutput`/`TaskStop` model, Codex CLI, and OpenCode; see `description.md` |
| T2 | implement | `background-job-tool.ts`: job registry (kind `job`\|`watch`), `start_job`/`watch_job`/`stop_job`, same approval-gate + `KERYX_SANDBOX_SHELL` posture as `shell_exec`, concurrency cap |
| T5 | implement | `job-bridge.ts` + `WorkerFleet` sidebar wiring (raw-tail for `job`, event-count+last-event for `watch`), `job_output`/`list_jobs`, tool registration in both shells, `killAll()` on shell shutdown |
| T3 | test | Tests: approval/sandbox parity (both kinds), fleet upsert transitions, `watch_job` persistent vs timeout_ms behavior, concurrency cap, kill-on-exit, `job_output`/`list_jobs` correctness |
| T4 | review | code-verifier + review-orchestrator pass (security parity with `shell_exec` is the key thing to check), fix findings, prepare PR |

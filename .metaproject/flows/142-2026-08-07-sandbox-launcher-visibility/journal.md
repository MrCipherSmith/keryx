# Flow Journal

- 2026-08-07T09:10:11.077Z - flow created
- 2026-08-07T09:11:48.514Z - task-added: T5: Failing tests for the frozen criteria
- 2026-08-07T09:11:48.602Z - task-added: T6: Implement the fix
- 2026-08-07T09:11:48.690Z - task-added: T7: Verify: focused tests + keryx health run
- 2026-08-07T09:11:48.872Z - task-added: T8: Confirm the matrix in output and in the runbook share one source (AC4)
- 2026-08-07T09:11:49.312Z - frozen: 6 criteria; checksum recorded
- 2026-08-07T09:11:49.398Z - started
- 2026-08-07T09:27:00.000Z - task-implementer: implemented P4. New: `keryx sandbox status` (src/commands/sandbox.ts) — report-only, never sets process.exitCode; reuses detectSandboxLauncher from src/harness/process/sandbox/detect.ts (no reimplementation). Single-source capability matrix at src/harness/process/sandbox/capability-matrix.ts, cross-checked against docs/verification/linux-sandbox-verification.md's "Scope on Linux" table by capability-matrix.doc-sync.test.ts (AC4). scripts/install.sh gained report_sandbox_status(), called from both --project and --global paths (AC1), tested in scripts/install-global.test.ts with a PATH filtered to exclude any bwrap-containing dir (works regardless of the test machine's real bwrap state) plus a falsifiable pair test. Registered in src/standard/command-registry.ts as module "sandbox", command "sandbox status" (AC6) — NOT nested under "harness": that verb is deliberately excluded from the descriptor registry (command-registry.coverage.test.ts) because it spawns arbitrary subprocesses, so "harness sandbox" would have contradicted that exclusion. Named `sandbox status` over the spec's suggested `keryx doctor` because `keryx standard doctor` already exists with an unrelated meaning (Metaproject Standard compliance); `status` matches the existing subcommand convention (`wiki status`, `test status`, `modules status`, `ctx status`). AC3 encoded as two named constants (LAUNCHER_NOT_INSTALLED / NOT_IMPLEMENTED_ON_PLATFORM) asserted mutually exclusive per capability row in sandbox.test.ts. AC5 untouched by design — no edits to shell-exec-tool.ts / sandbox-config.ts / command-risk.ts; existing detect.test.ts and shell-exec-tool.test.ts fail-closed coverage re-run green. Verification: focused tests 32/32 pass (sandbox.test.ts 11, capability-matrix.doc-sync.test.ts 5, install-global.test.ts 5, detect+adapter+shell-exec-tool 25 pass/2 skip, command-registry(+coverage) 24), `bun run typecheck` clean, `keryx health run` → WARN (score 91, pre-existing regression fully attributable to the untouched docs/requirements/keryx-shell-benchmark/harness/wt/ benchmark worktree — new files show 0 findings, score 0). Full untargeted `bun test` was not usable as a signal: it also walks that same stale benchmark worktree (missing deps: @anthropic-ai/sdk, grammy, pino, postgres) and Bun itself segfaulted partway through — pre-existing environment noise, unrelated to this change.

## Orchestrator note — 2026-08-07

Command name accepted: `keryx sandbox status`, not `keryx doctor` as the
specification suggested. The worker found two reasons the spec did not know
about, and both are better than the spec's guess: `harness` is deliberately
excluded from `COMMAND_DESCRIPTORS`, so `harness sandbox` would have failed the
coverage test it was meant to satisfy; and `keryx standard doctor` already exists
meaning Metaproject Standard compliance, so "doctor" would have collided.
`status` matches `wiki status`, `test status`, `modules status`, `ctx status`.
The specification's suggestion is superseded, not ignored.

The worker also surfaced something bigger than its own flow, in passing: of 2736
health findings, **2604 lived under `harness/wt/`** — 42 leftover benchmark
worktrees, 323 MB, sitting inside this repository. They are gitignored, so
`git status` never showed them, but the health scanner and `bun test` walk the
filesystem, not the index. That is why every worker in this batch saw a red gate
and a segfaulting test run, and why I could not tell a real regression from
noise.

Removed: 42 worktrees deregistered from the target repo and pruned. Evidence was
never at risk — the collector copies each bundle into `evidence/run-2/` and the
frames live in `harness/runs/`, neither of which is under `wt/`.

This is a harness defect, not a one-off: `drive.py` passes `--keep`, so every
leg leaves its worktree behind forever. Recorded in the run-3 runbook.
- 2026-08-07T09:35:49.388Z - task-done: T7: Verify: focused tests + keryx health run
- 2026-08-07T09:35:49.474Z - task-done: T4: Self-review and prepare draft PR

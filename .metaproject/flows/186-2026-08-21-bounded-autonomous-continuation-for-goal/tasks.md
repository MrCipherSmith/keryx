# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

T1-T4 are `keryx flow init`'s standard scaffolded umbrella tasks (mirrors
flow 182's own T1-T4); T5-T15 are this flow's real breakdown.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan (umbrella; closed once T6-T12 land) |
| T3 | test | Add/adjust tests and make them pass |
| T4 | review | Self-review and prepare draft PR (umbrella) |
| T5 | context | ~~Confirm SLATE numbering~~ (done — SLATE-22). ~~Confirm `flow plan`'s task-breakdown granularity~~ — moot: T7 dropped `flow plan` entirely (advisory-only, writes no flow state). ~~Confirm token/turn-budget accounting to reuse~~ — resolved as deliberately out of scope for v1: round-count capping (AC5, tested) is the only budget mechanism; no token/cost budget was built, consistent with "a concrete graft, not a rebuild." |
| T6 | implement | `parseGoalArgs`: recognize trailing `--auto [N]`, composable with `--workspace` (plan step 1, AC1) |
| T7 | implement | Auto-provision + bind a Task Manager flow when `--auto` has none bound (plan step 2, AC2). Revised: drops the never-viable `flow plan` step (advisory-only, confirmed during implementation); uses `flow init`'s default scaffold + one goal-tied AC instead. |
| T8 | implement | Arm `SlateSessionRef.autoGoalRounds`, in-memory only (plan step 3, AC7) |
| T9 | implement | Continuation loop in `runGoalCommand`: observe `slateSession.opened` (closeSlateOnFlowDone's own signal, not a second isCourseDone call), synthesize continuation message via `FlowService.get()`, re-invoke `runAgentTurn`, decrement round budget (plan step 4, AC3/AC5). Revised: AC3's mechanism description corrected from "re-call isCourseDone" to "observe the existing call's side effect." |
| T10 | implement | Verifier `spawn_subagent` call before final stop; surface `gaps`; verifier-triggered rounds count against the same cap (plan step 5, AC4/AC5). Adds reopen+rebind (T8's `boundFlowRef`/`boundWorkspaceId` snapshot) when the course had already closed — a detail plan.md's pre-implementation wording left implicit. |
| T11 | implement | Confirm `closeSlateOnFlowDone`/wrap-up dispatch path needs no change once the loop stops (plan step 6, AC8) |
| T12 | implement | Per-surface progress-line wiring in `shell.ts`/`tui-shell.ts` for a multi-round `--auto` run (plan step 8). Confirmed live, no code change needed: both call sites already reuse the same `io`/`history` plumbing unchanged. |
| T13 | test | Unit tests for T6-T11 against every ACn; a fixed-round-count fixture that never resolves (AC5); a forked-session test proving no silent inheritance (AC7); confirm the existing SLATE-18 wrap-up suite passes unmodified (AC8). Done incrementally across T6-T10: 49 tests in `goal-command.test.ts` (31 new), plus a live end-to-end smoke test in both shells (T12). Full project suite: 5281 pass / 47 pre-existing unrelated fail / 18 skip — 0 regressions from this flow's diff. |
| T14 | review | Self-review and prepare draft PR (duplicates T4's umbrella — kept as the CLI-recorded task since a title can't be edited after `flow task add`; close both together). `code-boss-reviewer` found 2 real bugs, fixed: (1) `slateSession.autoGoalRounds` was never cleared after consumption — since `slateSession` is a per-session object reused across every `/goal` call, an armed budget silently hijacked the NEXT call too, even without `--auto`; now `delete`d the moment the loop reads it. (2) the verifier's reopen+rebind block (`ensureSlateOpened`/`readSlate`/`writeSlate`) was unguarded, unlike everything else in this file, risking the exact bare-`void`-no-`.catch` TUI crash "Review finding 3" (a few lines above it) exists to prevent; now wrapped in its own try/catch, degrading to "skip the extra round" on failure. Also fixed: `boundFlowRef`/`boundWorkspaceId` now derive from already-in-scope values instead of a second `readSlate` that raced the "does not arm on failure" contract; documented (not fixed — no safe cleanup exists) the orphaned-flow-dir gap on a partial `autoProvisionFlow` failure; extended `runGoalCommand`'s top docstring to mention `--auto`. Added 2 new regression tests exercising the real failure paths (not just asserting the fix's absence of symptoms). |
| T15 | docs | Update `docs/requirements/goal-continuation/` with the as-built design if it diverges from this plan; cross-link from `docs/requirements/slate/README.md`'s SLATE-N table once the real number is confirmed (T5). Done: `docs/requirements/goal-continuation/as-built.md` written; SLATE-22 row added to `docs/requirements/slate/specification.md`'s table (the actual SLATE-N table — README.md has no per-number breakdown). |

## AC coverage map

- AC1 -> T6
- AC2 -> T7
- AC3 -> T9
- AC4 -> T10
- AC5 -> T9, T10, T13
- AC6 -> T9 (no change — verified by T13 asserting the existing gate path is untouched)
- AC7 -> T8, T13
- AC8 -> T11, T13
- AC9 -> T6 (mirrors the existing `/goal` AGENT_ONLY rejection path)

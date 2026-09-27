# Review Report — flow 347, round 1

## Verdict: REQUEST_CHANGES

## Summary

The branch closes all nine incident mechanisms, and 11 of 13 acceptance criteria are met in code; AC3 and AC7 are partial. No blockers. Four majors: one security gap in the new `spawn_subagent` `cwd` allowlist (unvalidated `git worktree list` entries), one ordering mismatch with AC3, and two missing tests that leave the incident's own failure modes (child tools reading the wrong tree; a silent empty reviewer inventory) able to regress unnoticed. The rest is wrap-up-round mislabelling, quarantine gaps, and structure in `agent.ts`.

## Review Scope

- Branch: `flow/review-shell-fail-closed`
- Parent ref: `origin/main`
- Merge-base: `0b7fc0b6`
- Head: `6f9d2e12` (+ flow-package commits)
- Scope mode: explicit-hash-range, report-only (no PR)
- Reviewers dispatched: review-spec-gate, review-logic, review-architecture, review-security-code, review-testing-practices, review-style — all via `general-purpose` fallback (no native agent types); all returned a schema-valid result on the first dispatch
- Skipped reviewers: review-core-boundaries / review-flow-graph (no matching paths), review-frontend* (no UI), legacy profiles (user declined)
- Changed files: ~18 source/doc/test files (+ flow package)
- Context mode: `light` + flow package (description, plan, context, journal, AC)
- Model strategy: `per-reviewer`
- Current model: `claude-opus-5-5` (orchestrator)
- Model assignment: opus for spec-gate/logic/architecture/security; sonnet for testing-practices/style

## Stats

- blocker: 0
- major: 4
- minor: 14
- info: 7

## Major Issues

### [F-001] `cwd` allowlist trusts unvalidated `git worktree list` entries — SEC-1
- **File**: `src/harness/tool/builtin/spawn-subagent-tool.ts` (`resolveSubagentCwd`, `git worktree list --porcelain` parse)
- **Problem**: every `worktree ` line is accepted, including `prunable` entries whose path comes from a writable `.git/worktrees/<id>/gitdir`, and lines injected by a worktree path containing a newline (output parsed without `-z`).
- **Why it matters**: one write under `.git/` moves the child's read confinement to any directory (e.g. `$HOME`), and read results flow back to the parent. Reproduced by the reviewer with git 2.51.0.
- **Fix**: parse `--porcelain -z`; skip `prunable`; verify the candidate's `.git` gitfile points into this repo's `<common-dir>/worktrees/<id>` and that entry's `gitdir` points back — by reading files, never running git in the candidate.

### [F-002] AC3 order: `pending` and `proposed` share a rank — S-1
- **File**: `src/session/execution-plan.ts` (`SNAPSHOT_STATUS_RANK`)
- **Problem**: frozen AC3 orders `in_progress`, `blocked`, `pending`, `proposed`; the code interleaves pending/proposed in plan order, and the test asserts the interleaving.
- **Why it matters**: under the 7-row cap, items awaiting approval can push actionable items out of the snapshot.
- **Fix**: `proposed: 3`, finished `4`; update the test.

### [F-003] No test proves the child's file tools follow `cwd` — S-2
- **File**: `src/harness/tool/builtin/spawn-subagent-cwd.test.ts`
- **Problem**: acceptance tests check only the `Project root:` prompt line; no scripted child calls `read_file`/`list_dir` on a relative path.
- **Why it matters**: re-binding tools to the parent cwd — the exact incident — would pass the suite.
- **Fix**: a scripted child reads a relative file that exists only under the supplied cwd/worktree; assert on the tool result.

### [F-004] `not-found` exit code untested — S-8
- **File**: `src/commands/review.ts` (`runReviewers`), `src/review/reviewers.ts`
- **Problem**: the only `not-found` test calls the pure renderer; neither `process.exitCode === 1` nor `--json` output is covered.
- **Why it matters**: the fail-closed exit that stops agents reading "no reviewers" as success can regress silently.
- **Fix**: make the package lookup injectable and add command tests for text and `--json`.

## Minor & Info

| ID | Sev | Where | Finding | Fix |
|---|---|---|---|---|
| F-005 (L-1) | minor | `agent.ts` `finishWithSubmitResult` | provider error in the wrap-up round is reported as "made no submit_result call" | carry the provider error into `submitResultError` |
| F-006 (L-2) | minor | `agent.ts` `finishSubagentWithSubmitResult` | abort during the last call still sends the wrap-up; interrupt reported as `BudgetExhausted` | early `isAborted()` return; check `signal.aborted` in catch |
| F-007 (L-3) | minor | `spawn-subagent-tool.ts` schema | `max_tool_calls: 0` → unbounded child, no warning, prompt says "about 0 calls" | schema minimum 1, or treat 0 as unset |
| F-008 (SEC-2) | minor | `spawn-subagent-tool.ts` no-result branch | `submitResultError` echoes child-controlled tool name / JSON keys outside `foldChildSummary` | fold the whole block |
| F-009 (SEC-3) | minor | `agent.ts` `withBudgetWarning`, `quarantine.ts` | shell envelope appended to tool content and not a quarantine pattern → forgeable by file/child text | add envelope to quarantine patterns; neutralise it in tool/child text |
| F-010 (A-3) | minor | `agent.ts` `finishWithSubmitResult` | third hand-copied stream consumer, already drops reasoning events | shared `streamOneRound` helper |
| F-011 (A-1) | minor | `agent.ts` `subagentBudget` | turn loop branches on one caller's protocol at four stop sites | caller-supplied stop strategy on `AgentDeps` |
| F-012 (A-2) | minor | `agent.ts` | `SUBMIT_RESULT_TOOL_DEFINITION` / validator live in the shell command | move to `src/harness/tool/builtin/` |
| F-013 (S-7) | minor | `agent.ts` `turnExecutedToolCall` | set for calls that never ran (refused/unknown) | set from `executedAny` |
| F-014 (S-3) | minor | provider port | forced tool choice not wired; port has no `toolChoice` | record interpretation in journal, or add optional `toolChoice` |
| F-015 (S-4) | minor | `journal.md` | demo scripts outside the repo; output paraphrased | paste verbatim output / keep scripts in the flow dir |
| F-016 (S-5) | minor | `agent.ts` `[plan]` note | multi-line where AC1 says one line | one line with item ids |
| F-017 (S-6) | minor | review-orchestrator `SKILL.md` | "the rest `skipped`" ambiguous vs bridge rule | name steps 0–5 vs 6–14 explicitly, both copies |
| F-018 (T-1) | minor | `spawn-subagent-tool.test.ts` | asserts description wording (`ADVISORY`) | keep only the env-name check |
| F-019 (ST-1) | minor | `reviewers.ts` `bundledSourceNote` | leading-`+` concatenation, unlike the file | trailing `+` |
| F-020 (L-5) | info | `agent.ts` `isCompleteStructuredAnswer` | a one-line bullet stall (`- Checking…`) suppresses the reprompt | require 2 list items or a heading for short replies |
| F-021 (L-4) | info | `agent.ts` stop branches | unattended vs subagent precedence differs by branch (latent) | one precedence |
| F-022 (A-6/L-6) | info | `reviewers.ts` package fallback | reported `path` is a source-tree path, not the resolved file; comment overstates install.ts sharing | report resolved file; fix comment |
| F-023 (A-5) | info | `spawn-subagent-tool.ts` deps `cwd` | docs point to a doc comment that does not exist | add it |
| F-024 (A-4) | info | `agent.ts` | +370 net lines to a god file | extract nudge helpers + subagent wrap-up |
| F-025 (T-2) | info | budget tests | hard-cap test inverted to advisory | intended by AC4 — no action |

## Positive Notes

- Round math, single wrap-up, top-level hard stops, warning thresholds, default-off plan path and provenance round-trip were traced and hold.
- `cwd` realpath/descendant checks handle macOS `/private/tmp`, and git runs only in the parent root.
- Skill and rule copies are byte-identical; new tests assert observable behaviour with good negative coverage.

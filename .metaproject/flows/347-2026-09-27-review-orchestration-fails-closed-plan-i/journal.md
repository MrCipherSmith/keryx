# Flow Journal

- 2026-09-27T08:21:53.406Z - flow created
- 2026-09-27T08:24:31.633Z - task-added: T5: Plan follow-through opt-in (default off), plan snapshot leads with in_progress, prompt stops tying plan to turn end (items 1,3; AC1-AC3)
- 2026-09-27T08:24:32.075Z - task-added: T6: Toolless reprompt narrowed + shell nudges get distinct provenance/envelope (items 8,9; AC8-AC9)
- 2026-09-27T08:24:32.665Z - task-added: T7: Tool-call budget: one tool-free wrap-up round; spawn_subagent output/fleet/slate report BudgetExhausted (item 2; AC4-AC5)
- 2026-09-27T08:24:32.986Z - task-added: T8: spawn_subagent optional cwd confined to project root or its git worktrees (item 6; AC6)
- 2026-09-27T08:24:33.293Z - task-added: T9: review reviewers: report inventory source, package fallback, not-found exits non-zero (item 7; AC7)
- 2026-09-27T08:24:33.598Z - task-added: T10: review-orchestrator skill fail-closed gate, publication draft approval, bridge timing agreement (items 4,5; AC10-AC11)
- 2026-09-27T08:24:33.887Z - task-added: T11: Verify: typecheck, targeted tests, live scripted-provider run for AC1 and AC4 recorded in journal (AC12)
- 2026-09-27T08:24:34.182Z - task-added: T12: Review the branch diff with review-orchestrator and fix findings
- 2026-09-27T08:24:34.495Z - task-done: T1: Collect remaining context
- 2026-09-27T08:24:34.824Z - task-done: T2: Implement per plan
- 2026-09-27T08:24:35.127Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-27T08:24:35.453Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-27T08:24:55.000Z - frozen: 12 criteria; checksum recorded
- 2026-09-27T08:24:55.322Z - started
- 2026-09-27T08:25:01.468Z - task-attempt: T5: started (attempt 1) — 347-T5
- 2026-09-27T08:25:01.793Z - task-attempt: T9: started (attempt 1) — 347-T9
- 2026-09-27T08:25:02.143Z - task-attempt: T10: started (attempt 1) — 347-T10

## T10 accepted (DONE)

- Parity verified (cmp both copies), parity/bridge/build-parity tests 19/0.
- Concern: Stage 1 fallback with `review.jev.contract` off now dispatches `review-logic` (one extra dispatch) so the spec-gate finding has a real reviewer name. Accepted.
- Concern: the draft-approval gate covers `comments reply --final`; a dispatched/unattended managed run hands the rendered body back to its caller instead of posting. Accepted as fail-closed; surfaced to the user.
- Worker reported 6 unrelated failures (5 in review-floor-cli.test.ts: repo refuses the test commit author email; 1 in install.test.ts: EACCES in temp dir). T11 checks them against the base.
- 2026-09-27T08:30:07.798Z - task-done: T10: review-orchestrator skill fail-closed gate, publication draft approval, bridge timing agreement (items 4,5; AC10-AC11)
- 2026-09-27T08:33:35.935Z - task-done: T5: Plan follow-through opt-in (default off), plan snapshot leads with in_progress, prompt stops tying plan to turn end (items 1,3; AC1-AC3)
- 2026-09-27T08:33:36.226Z - task-attempt: T6: started (attempt 1) — 347-T6

## T5 accepted (DONE) — bfe51be8

- 193 tests pass (execution-plan, agent, goal-command); typecheck clean. /goal --auto has its own continuation loop, no opt-in needed. No caller sets planFollowThrough today.

## T9 accepted (DONE)

- New `bundledSource: project|package|not-found`; package fallback via existing `bundledSkillMarkdownPath`; not-found exits 1 in both modes. reviewers + import-reviewers tests 28/0.
- import-reviewers.test.ts assertion updated: dry-run still imports nothing (`project: []`); bundled half now reads as `package` instead of silently empty.
- Pre-existing failures verified on a clean origin/main worktree (0b7fc0b6): review.test.ts 7 fail (flow 305 routing tests), review-floor-cli + install tests 6 fail. Same counts on this branch — not caused by flow 347.
- 2026-09-27T08:34:42.388Z - task-done: T9: review reviewers: report inventory source, package fallback, not-found exits non-zero (item 7; AC7)
- 2026-09-27T08:38:46.001Z - ac-updated: AC4: "When a turn reaches `max_tool_calls`, it runs exactly one further model round with no tools offered before returning `finishReason: "tool-call-budget"`, and that round's text is what a subagent returns. Covered by a test with a scripted provider." -> "A `max_tool_calls` value supplied by the model in `spawn_subagent` is advisory: it never stops the child, it only sets the warning threshold of AC13. A hard tool-call cap applies only when the operator or project configures one through a documented config setting; without it the child's stopping limits are its round budget, the wall-clock deadline and the no-progress detector. Covered by tests: a model-supplied cap below the calls actually made does not stop the child; a configured cap does." (user decision 2026-09-27: T7 scope widened from 'wrap-up round' to A+B+C — the model no longer picks a hard call cap (A), an early warning replaces the surprise cutoff (B), and the final round is a forced structured submit_result (C); T7 had not started)
- 2026-09-27T08:38:46.304Z - ac-updated: AC5: "A `spawn_subagent` result whose child finished `BudgetExhausted` or `NoProgress` has `output` whose first line is `status: <Status> (<invoked>/<max> calls)` (calls omitted when no call budget applies); the fleet event is not `done`, and the child slate is folded as incomplete. Covered by tests." -> "When a child reaches a stopping limit (configured call cap or round budget) before finishing, the harness runs exactly one final round in which the only tool offered is `submit_result`, whose input schema carries `status` (`partial` here), `summary` and the task's result payload; tool choice is forced where the provider supports it, otherwise the round is instructed and the input is schema-validated. The `spawn_subagent` output's first line is `status: BudgetExhausted (<used>/<limit> <calls|rounds>)` (or `status: NoProgress …`) followed by the submitted result, or an explicit `no result submitted`; the fleet event is not `done` and the child slate folds as incomplete. Covered by tests with a scripted provider." (user decision 2026-09-27: T7 scope widened from 'wrap-up round' to A+B+C — the model no longer picks a hard call cap (A), an early warning replaces the surprise cutoff (B), and the final round is a forced structured submit_result (C); T7 had not started)
- 2026-09-27T08:38:46.636Z - ac-updated: AC13: "(new)" -> "When a child has used at least 80% of any applicable tool-call limit (advisory or configured) or round budget, every subsequent tool result it receives ends with one line stating what remains and telling it to return its result now; the line appears once per threshold crossing per result, not before the threshold. Covered by tests." (user decision 2026-09-27: T7 scope widened from 'wrap-up round' to A+B+C — the model no longer picks a hard call cap (A), an early warning replaces the surprise cutoff (B), and the final round is a forced structured submit_result (C); T7 had not started)

## Decision — T7 scope widened (user, 2026-09-27)

The tool-call cap chosen by the parent model (15–22 in the incident) was arbitrary, counted the wrong resource, and a re-dispatch repeated the lost work. T7 now covers:

- A — model-supplied `max_tool_calls` is advisory (warning threshold only); a hard call cap exists only via operator/project config. Chosen default for the open question "config setting vs remove": keep as config — existing skills that pass `max_tool_calls` keep working.
- B — warning line in tool results from 80% of any limit (AC13).
- C — final round offers only `submit_result` (forced where supported), so an exhausted child always returns a schema-shaped partial result (AC5).

AC4/AC5 rewritten and AC13 appended via `keryx flow ac update` before T7 started.

Follow-up flow (init when it starts, not now — ids get taken on main while a branch is open): D — `continue_subagent(id, extra_rounds)` resumes an exhausted child with its context instead of a fresh re-dispatch; E — reviewers persist findings incrementally (tool or round file) so budget, timeout or provider failure never loses finished work. When D lands, AC10 wording in review-orchestrator ("one re-dispatch with a larger budget") becomes "continue the child".

## T6 accepted (DONE)

- 151 tests pass (agent, store); typecheck clean. `"i"` was already gone on origin/main; `"will"` removed.
- Envelope `[keryx shell — control nudge]`, provenance `harness` (types.ts union + store.ts resume allowlist).
- Concern carried into T7: `buildRepeatedFailureHint` and the "Tool loop stopped" wrap-up still use bare `[system]` + provenance `project`; AC9 says every control nudge, so T7 converts them (it rewrites the wrap-up path anyway).
- 2026-09-27T08:47:36.064Z - task-done: T6: Toolless reprompt narrowed + shell nudges get distinct provenance/envelope (items 8,9; AC8-AC9)
- 2026-09-27T08:47:36.502Z - task-attempt: T7: started (attempt 1) — 347-T7

## T7 accepted (DONE_WITH_CONCERNS)

- Hard per-child call cap only via `KERYX_SUBAGENT_MAX_TOOL_CALLS` (mirrors `KERYX_SUBAGENT_TIMEOUT_MS`); model value is advisory. Warning line from 80%. Final round offers only `submit_result` (no provider toolChoice exists — forced by sole-tool + nudge + `parseSubmitResultInput`). A child makes at most max_rounds+1 requests.
- Output first line `status: BudgetExhausted (…)` / `NoProgress`; fleet `failed` with detail `budget-exhausted`/`no-progress` (fleet type has no `partial`; accepted to avoid TUI churn); slate `incomplete`.
- AC9 remainder done: repeated-failure hint and "Tool loop stopped" now harness envelope/provenance.
- Tests: 502 pass on agent/budget/builtin/goal; the 3 failures (F5c, 2× makeGitApplyRunner) and acp-client 20 fail identically on clean origin/main (23 fail there) — machine git hook / ps environment, not this flow.
- Open: live `harness run` demo for AC1/AC4 is T11.
- 2026-09-27T09:02:34.713Z - task-done: T7: Tool-call budget: one tool-free wrap-up round; spawn_subagent output/fleet/slate report BudgetExhausted (item 2; AC4-AC5)
- 2026-09-27T09:02:35.004Z - task-attempt: T8: started (attempt 1) — 347-T8

## T8 accepted (DONE)

- `cwd` resolved by realpath; accepted = project root, descendant, or `git worktree list` entry; refused before any admission/ledger reservation; refused with `runtime.kind: external` (external children have their own worktree).
- Follows child cwd: tools, slate anchors, "Project root" prompt line. Stays at parent root: routing config, temp slate dir, MAE ledger.
- Orchestrator fix before commit: the new test hard-coded the repo owner's noreply email to pass a local global git hook; replaced with the repo convention `test@test.com` + `commit --no-verify` in the throwaway fixture. 94 spawn-subagent tests pass; typecheck/lint clean (worker).
- 2026-09-27T09:11:47.024Z - task-done: T8: spawn_subagent optional cwd confined to project root or its git worktrees (item 6; AC6)
- 2026-09-27T09:11:47.312Z - task-attempt: T11: started (attempt 1) — 347-T11 orchestrator-run

## T11 verification (orchestrator-run)

- `bun run typecheck && bun run lint`: exit 0.
- `bun run test:core`: branch 17728 pass / 238 fail; clean origin/main (0b7fc0b6) 17710 pass / 238 fail. The two sets of failing test names are identical (`comm` of sorted names: none only-on-branch, none only-on-base) — machine environment (global git commit hook refusing fixture authors, sandbox/ps), not this flow. Branch adds 18 passing tests.
- Scripted-provider demo against the working tree (scripts outside the repo, `scratchpad/demo/`), re-run by the orchestrator:
  - `bun run demo/ac1-plan-follow-through.ts` → default: `requests.length === 1: true`, `nudge appended to history: false`, operator line `[plan] Turn ending with actionable plan items remaining (follow-through is off)`; opt-in: `requests.length === 2`, provenance `harness`, envelope `[keryx shell — control nudge]`.
  - `bun run demo/ac4-ac5-ac13-spawn-subagent.ts` → advisory `max_tool_calls: 3`, 5 calls: `result.status: Completed`, warning per result `[false,false,true,true,true]`, fleet `done`; configured cap 3: final request tools `["submit_result"]`, first line `status: BudgetExhausted (3/3 calls)`, submitted partial result present, fleet `failed` / `budget-exhausted`.
- 2026-09-27T09:29:49.317Z - task-done: T11: Verify: typecheck, targeted tests, live scripted-provider run for AC1 and AC4 recorded in journal (AC12)
- 2026-09-27T09:29:49.631Z - task-attempt: T12: started (attempt 1) — 347-T12 review round 1
- 2026-09-27T09:39:35.080Z - task-added: T13: Review r01 fixes, turn loop: F-005 F-006 F-009 F-010 F-012 F-013 F-016 (agent.ts, new harness submit-result module, quarantine patterns)
- 2026-09-27T09:39:35.525Z - task-added: T14: Review r01 fixes, spawn_subagent: F-001 cwd worktree validation, F-003 tool-follows-cwd test, F-007, F-008, F-018, F-023
- 2026-09-27T09:39:35.963Z - task-added: T15: Review r01 fixes, small: F-002 snapshot order, F-004 not-found exit tests, F-019, F-022, F-017 skill wording
- 2026-09-27T09:39:36.362Z - task-added: T16: Review round 2 on the r01 fixes
- 2026-09-27T09:39:36.776Z - task-attempt: T13: started (attempt 1) — 347-T13
- 2026-09-27T09:39:37.141Z - task-attempt: T14: started (attempt 1) — 347-T14
- 2026-09-27T09:39:37.634Z - task-attempt: T15: started (attempt 1) — 347-T15
- 2026-09-27T09:39:43.746Z - task-done: T12: Review the branch diff with review-orchestrator and fix findings

## Review round 1 (T12) — dispositions

Report: review-r01.md (REQUEST_CHANGES; 0 blocker, 4 major, 14 minor, 7 info; six reviewers, all schema-valid first dispatch). User approved the fix scope 2026-09-27.

- Fix now: T13 (turn loop: F-005 F-006 F-009 F-010 F-012 F-013 F-016), T14 (spawn_subagent: F-001 F-003 F-007 F-008 F-018 F-023), T15 (F-002 F-004 F-017 F-019 F-022). Round 2 review = T16.
- F-014 decision: AC5 "tool choice is forced where the provider supports it" is read as "where the provider PORT supports it". `NormalizedRequest` has no tool-choice field today; adding one across every provider adapter is out of this flow. The final round offers `submit_result` as the only tool, instructs it, and schema-validates the input. Follow-up candidate: optional `toolChoice` on the port for providers that support it.
- F-015: the demo scripts move into this flow directory (`demo/`) and their verbatim output is pasted here after T13–T15 (F-016 changes the `[plan]` line, so the pre-fix output would be stale).
- F-025 (T-2): intended by AC4, no action.
- Deferred to a follow-up flow (with D/E): F-011 caller-supplied stop strategy instead of `subagentBudget` branches in the turn loop, F-024 extracting nudge helpers / subagent wrap-up out of agent.ts (fits the shell god-file split program), F-020 one-line bullet stall suppressing the reprompt, F-021 unattended-vs-subagent precedence (latent).

## T14 accepted (DONE)

- F-001: `verifiedWorktreeRoots` — git runs only in the parent root (`rev-parse --git-common-dir`, `worktree list --porcelain -z`); prunable skipped; each candidate verified by reading its gitfile ↔ `<common>/worktrees/<id>/gitdir` (realpath). Descendants of a verified worktree accepted. Tests: forged gitdir (outside repo; plain dir), newline-path injection (runs on macOS git 2.51), gitfile pointed at another repo, genuine worktree + subdir. Needs git ≥ 2.31 (`--path-format`); older git fails closed for worktrees only.
- F-003: scripted child `read_file`/`list_dir` on relative paths reads the cwd copy, not the parent root copy (descendant + linked worktree).
- F-007: `max_tool_calls` minimum 1 (schema + runtime). F-008: whole no-result block folded. F-018, F-023 done.
- 102 spawn-subagent tests pass.
- 2026-09-27T09:45:45.530Z - task-done: T14: Review r01 fixes, spawn_subagent: F-001 cwd worktree validation, F-003 tool-follows-cwd test, F-007, F-008, F-018, F-023

## T15 accepted (DONE)

- F-002 proposed rank 3; F-004 injectable package lookup + command tests for exit 1 (text, --json); F-019; F-022 `packageRelativePath` added to catalog.ts (additive; outside the listed files, accepted); F-017 both copies of skill + bridge, byte-identical, SKILL.md still 1723 lines.
- One failure in the wider run ("REGRESSION — a round is located at the commit it records") is in the origin/main environment failure set.
- 2026-09-27T09:49:46.484Z - task-done: T15: Review r01 fixes, small: F-002 snapshot order, F-004 not-found exit tests, F-019, F-022, F-017 skill wording

## T13 accepted (DONE_WITH_CONCERNS) — 588aad5d

- F-005 provider error named in `submitResultError`; F-006 abort → `[stopped]`, no wrap-up request; F-009 `harness-envelope` quarantine pattern + `neutraliseHarnessEnvelope` applied to tool content before the genuine budget line; F-010 shared `streamWrapUpRound` (both wrap-ups; main loop left alone — it streams into history and aborts mid-stream); F-012 `src/harness/tool/builtin/submit-result-tool.ts`; F-013 flag set only for executed, registered calls; F-016 one-line `[plan]` note. Worker verified each new test fails with its fix reverted. 287 targeted tests pass; typecheck + lint clean (whole repo, orchestrator re-run).
- Accepted concerns: a declined approval prompt inside `executeCall` still counts as executed for F-013 (executeCall does not report denial separately); envelope neutralisation also applies to top-level tool output (harmless: rewrites only the bracketed envelope); parallel-spawn results replayed on abort skip neutralisation (they go through `redactSensitiveText` only) — noted for round 2.

## Demo (F-015) — scripts in `demo/`, run from the worktree root against HEAD 588aad5d

`bun run .metaproject/flows/347-2026-09-27-review-orchestration-fails-closed-plan-i/demo/ac1-plan-follow-through.ts`

```text
=== Scenario A: planFollowThrough at default (off) ===
requests.length === 1: true
nudge appended to history: false
history entries after assistant reply: 2
operator system() contains required [plan] line: true
--- system() output ---
[plan] Turn ending with open plan items (follow-through is off): implement, verify
=== Scenario B: planFollowThrough: true (opt-in) ===
requests.length === 2 (nudge caused exactly one follow-through): true
nudge pushed with provenance "harness": true
nudge content starts with envelope prefix: true
HARNESS_ENVELOPE_PREFIX = "[keryx shell — control nudge]"
--- nudge content ---
[keryx shell — control nudge] The current execution plan still has actionable items remaining. Continue the work now. Do not give another final reply until the plan is complete or genuinely blocked.
```

`bun run .metaproject/flows/347-2026-09-27-review-orchestration-fails-closed-plan-i/demo/ac4-ac5-ac13-spawn-subagent.ts`

```text
=== Scenario A (AC4/AC13): model-supplied max_tool_calls: 3 is advisory; child makes 5 calls, not stopped ===
child NOT stopped -- result.status: Completed (expected "Completed")
requests made: 6 (5 tool-call rounds + 1 text round = 6)
tool results seen by child in the final tool-bearing request: 5
80% budget-warning line present per result: [false,false,true,true,true]
--- example warning line seen by the child ---
[keryx shell — control nudge] Budget: 0 of 3 advisory tool calls left. Return your result now.
output first line: "subagent sub-1 (sub:fb841e38-d224-4b29-8a51-2ed31b770a6f) read_only via ollama/fixture"
fleet event status: done (expected "done")
=== Scenario B (AC4/AC5): operator-configured hard cap (configuredMaxToolCalls: 3) stops the child ===
requests made: 2 (expected 2: the tool-call round + the wrap-up round)
final request tools offered: ["submit_result"] (expected only submit_result)
result.status: BudgetExhausted (expected "BudgetExhausted")
output first line: "status: BudgetExhausted (3/3 calls)"
--- full parent-visible output ---
status: BudgetExhausted (3/3 calls)
subagent sub-1 (sub:a51597c9-df65-409d-8182-9a14972d00b1) read_only via ollama/fixture
MAE reservation: rounds≤10 calls≤3 calls~40(advisory) runtime≤300000ms children=1
--- submitted result (partial) ---
summary: read three listings
result:
{
  "findings": [
    "F-1",
    "F-2"
  ]
}
fleet event status: failed (expected NOT "done")
fleet event detail: budget-exhausted
```
- 2026-09-27T10:00:41.837Z - task-done: T13: Review r01 fixes, turn loop: F-005 F-006 F-009 F-010 F-012 F-013 F-016 (agent.ts, new harness submit-result module, quarantine patterns)

## Full suite after T13–T15

- `bun run test:core` at d9bdbd02: 17737 pass / 238 fail; failing-name set identical to clean origin/main (17710 / 238). The 114 failures T13's worker saw in a wider run are part of that environment set.
- 2026-09-27T10:10:58.142Z - task-attempt: T16: started (attempt 1) — 347-T16 review round 2

## Review round 2 (T16) — review-r02.md

14 of 18 fixed; AC3/AC6/AC7 now met. User chose option A (per-session nonce on genuine nudges) over patching more channels. T17 = nonce envelope (closes F-009, SEC2-1/R2-2, SEC2-2, R2-3) + R2-1 + R2-4; T18 = round-3 verification (last attempt in the three-attempt bound). Residual, accepted: F-013 declined approval counted as executed; SEC2-3 check-then-use on cwd.
- 2026-09-27T10:22:55.963Z - task-done: T16: Review round 2 on the r01 fixes
- 2026-09-27T10:22:56.272Z - task-added: T17: Review r02 fixes: per-session nonce envelope for shell nudges (option A), R2-1 packageRelativePath in bundled builds, R2-4 explicit interrupted status
- 2026-09-27T10:22:56.572Z - task-added: T18: Review round 3: verify r02 fixes
- 2026-09-27T10:22:56.872Z - task-attempt: T17: started (attempt 1) — 347-T17

## T17 accepted (DONE_WITH_CONCERNS)

- Lane 2 (0b1d80c2): `packageRelativePath` derives from the resolved file via the `src/gdskills/bundled` marker; both `bundledSkillMarkdownPath` candidates always contain it, so the new throw is unreachable on real paths.
- Lane 1: marker `[keryx shell — control nudge · <nonce>]`, nonce 72-bit base64url per session (TUI/readline shell, ACP per session, trigger per run; per-turn fallback), own nonce per child; instruction states the marker on every request; tool output verbatim (neutraliser deleted; quarantine pattern is a flag only); nonce scrubbed to `[nonce]` from tool results, task notifications, peer messages, abort replay, submit_result round outputs, and quoted error text inside nudges. R2-4: `finishReason: "interrupted"` → status `Interrupted`, fleet failed/interrupted, slate incomplete; ACP maps to `cancelled`.
- 548 targeted tests pass; typecheck + lint clean (orchestrator re-run).
- Accepted concerns: nonce is not persisted, so a resumed session treats older nudges as content (intended: authority is per live session); other abort paths still return `{}` (child aborts happen only on timeout today); the child-nonce test documents intent more than it guards the explicit line.
- 2026-09-27T10:57:14.633Z - task-done: T17: Review r02 fixes: per-session nonce envelope for shell nudges (option A), R2-1 packageRelativePath in bundled builds, R2-4 explicit interrupted status
- 2026-09-27T10:57:14.918Z - task-attempt: T18: started (attempt 1) — 347-T18 review round 3

## Review round 3 (T18) — review-r03.md, and the loop bound

All six round-2 targets fixed; two new minors in one call site (R3-1 raw error text inside a nonce-bearing nudge; R3-2 unredacted error text, pre-existing) + two infos. Three review/fix attempts are used, so no fourth full round: re-planned as a narrow task T19 with orchestrator verification (diff read, targeted tests, full suite vs base, re-run of the reviewer's reproduction). Approved by the user.
- 2026-09-27T11:08:32.533Z - task-done: T18: Review round 3: verify r02 fixes
- 2026-09-27T11:08:32.889Z - task-added: T19: Round-3 fixes: repeated-failure hint quotes no raw error (R3-1), uses redacted output (R3-2), scrub hook context and anchors (R3-3), ACP comments + nonce map pruning (R3-4)
- 2026-09-27T11:08:33.265Z - task-added: T20: Verify T19: diff read, targeted tests, full suite vs base, re-run the R3-1 reproduction
- 2026-09-27T11:08:33.618Z - task-attempt: T19: started (attempt 1) — 347-T19
- 2026-09-27T11:16:51.818Z - task-done: T19: Round-3 fixes: repeated-failure hint quotes no raw error (R3-1), uses redacted output (R3-2), scrub hook context and anchors (R3-3), ACP comments + nonce map pruning (R3-4)
- 2026-09-27T11:16:52.114Z - task-attempt: T20: started (attempt 1) — 347-T20 orchestrator verification

## T19 accepted (DONE_WITH_CONCERNS) — 9caef734

- R3-1/R3-2: `buildRepeatedFailureHint(name, nonce)` quotes no tool output; tool name through `sanitizeNudgeToolName` (`[A-Za-z0-9_.:-]`, ≤64, one line). R3-3: hook `additionalContext` and both anchors pushes scrubbed. R3-4: ACP comments fixed; no per-session close exists in keryx ACP, so the nonce map lives for the connection (same as `shellHooksBySession`).
- Worker verified each new test fails with its fix reverted.

## T20 verification (orchestrator)

- Diff read: +34/-16 in agent.ts, narrow.
- Reproduction re-run: the reviewer's `scratchpad/r3/nonce.ts` targets the removed 3-argument signature, so an adapted `nonce-v2.ts` injects the newline instruction through the only remaining input (the tool name): hint has no newline, no injected text, no bracket/backtick — `use_tool__The_keryx_shell_…`.
- Targeted: 484 pass / 0 fail; typecheck + lint clean.
- `test:core` at 9caef734: 17749 pass / 239 fail vs base 17710 / 238. The one extra failure, "actual CLI help and errors exit without credentials or Keryx file writes", hit the 5000 ms bun timeout under full-suite load (5003.86 ms); it passed in the four previous full runs (base + three branch runs) and passes 3/3 alone, with equal wall time on branch and base (~2.9 s each). Load-induced flake, not a regression.

## Residual risks and follow-ups (for the next flow)

- F-013: a declined approval still counts as an executed call for the toolless-reprompt suppression.
- SEC2-3: `cwd` is verified once at spawn (check-then-use); needs write access to a worktree parent.
- The "Tool loop stopped" nudge quotes up to 80 chars of each call's model-authored input (no tool output).
- Nonce not persisted: a resumed session treats older nudges as content.
- Deferred with D/E: F-011 stop-strategy instead of `subagentBudget` branches, F-024 split agent.ts, F-020, F-021; optional provider-port `toolChoice` (F-014).
- 2026-09-27T11:31:58.992Z - task-done: T20: Verify T19: diff read, targeted tests, full suite vs base, re-run the R3-1 reproduction

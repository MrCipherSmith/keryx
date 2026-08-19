# Flow Journal

- 2026-08-19T04:56:34.997Z - flow created
- 2026-08-19T04:58:03.659Z - frozen: 8 criteria; checksum recorded
- 2026-08-19T04:58:03.748Z - started
- 2026-08-19T04:58:06.215Z - task-done: T1: Collect remaining context

## 2026-08-19 — T2 implement result + scope addendum (operator request, mid-flight)

T2 (implement) dispatched to task-implementer and returned STATUS:
DONE_WITH_CONCERNS:
- Change applied cleanly per TRD §1.3 (confirmed via read-back), all 5 new
  arms present, all 6 pre-existing busy commands + idle-path arms untouched.
- `tsc --noEmit` clean.
- `bun test`: 1 failure in `src/sac/fwk-service.test.ts` ("same-size
  historical receipt corruption invalidates the checkpoint and refuses
  append"). Investigated by the implementer: passes in isolation (24/24),
  fails only in the full-suite run WITH the tui-shell.ts diff present,
  reproduced twice; baseline (diff stashed) full suite is 0 fail, reproduced
  twice. Unrelated module (SAC access-receipt-ledger checksum logic), no
  logical dependency on tui-shell.ts. Working theory: pre-existing
  cross-file test-isolation/scheduling sensitivity in bun's concurrent
  runner, not a defect introduced by this diff. Flagged for re-check at T3
  (verify) rather than dismissed.

While T2 was in flight, the operator asked (voice) to (a) add explicit test
coverage for runLine's busy-branch dispatch — since none exists for any of
its 24 commands, not just the 5 new ones — and (b) asked about the
diff-tool/renderer gap noted in Q1 of the original investigation.

Resolution recorded and reported back to the operator:
- (a) Accepted as a scoped addendum. prd.md §12 (FR-9/FR-10/NFR-5) and
  trd.md §8 now specify extracting the busy-branch decision into a new pure,
  exported `classifyBusyDispatch` function (`src/tui/busy-dispatch.ts`),
  unit-tested directly (13 cases) without mounting any renderer/chrome —
  `runLine`'s busy branch becomes a thin switch over its result, every arm's
  body still a verbatim copy of the existing/planned code. This flow's scope
  now includes that extraction + its tests, added as a new task.
- (b) NOT added to this flow's scope — structured diff generation for an
  Edit tool + renderer work is a separate, materially larger feature
  (already flagged as an explicit Non-Goal / README "Known limitation").
  Told the operator a separate investigation/PRD would follow if they want
  it prioritized; holding until they answer.

## 2026-08-19 — T5 result + fwk-service.test.ts root-caused (not a regression)

T5 (task-implementer) returned STATUS: DONE_WITH_CONCERNS: created
`src/tui/busy-dispatch.ts` (pure `classifyBusyDispatch`) and
`src/tui/busy-dispatch.test.ts` (13 cases, all pass), rewired `runLine`'s
busy branch to a thin switch over the classifier's result, all 11 arm bodies
relocated verbatim (confirmed via read-back). `tsc --noEmit` clean. Full
suite: 4194 pass / 1 fail (`src/sac/fwk-service.test.ts`, same test T2 had
already flagged), reproduced twice by the implementer.

I (flow-orchestrator) investigated this myself before accepting T5, since
"reproduces 2/2 with diff, need a clean-main baseline" was the implementer's
own open question:
- `git stash push -u`, ran full suite on clean `main`: **0 fail**, 398 files
  (matches the earlier finding).
- `git stash pop`, ran full suite again with the full T2+T5 diff: **1 fail**
  (same test), 399 files — reproduced.
- This made "diff-triggered" look plausible, so I dug further: ran
  `bun test src/sac/fwk-service.test.ts` ALONE (no other file, no diff
  relevance possible) **three times in a row**: fail, pass, fail. ~66%
  failure rate running completely in isolation, with zero other code
  involved.
- **Conclusion: this is a pre-existing, self-contained flaky test in
  `fwk-service.test.ts` itself** (line 341, "same-size historical receipt
  corruption invalidates the checkpoint and refuses append" —
  `expect(...).rejects.toThrow(...)` intermittently receives a resolved
  promise). It has nothing to do with this flow's diff; the earlier
  "diff-triggered" appearance was coincidental — different full-suite runs
  land in different random/scheduling states regardless of what diff is
  present. Out of scope to fix here (unrelated SAC module); flag as a
  separate, real pre-existing bug for whoever owns `src/sac/` next.
- Both T3 and T5 marked done. Proceeding to T4 (code-verifier +
  review-orchestrator), noting this flaky test in the review dispatch so it
  isn't mistaken for a regression caused by this PR.

## 2026-08-19 — T4: code-verifier + review-orchestrator, both clean

code-verifier: PASS — typecheck 0 errors, full suite 4195 pass/0 fail (the
fwk-service.test.ts flake did not reproduce on this run), no circular
imports introduced (busy-dispatch.ts has zero dependencies, confirming the
pure-classifier design), lint skipped (no lint tooling configured repo-wide).

review-orchestrator dispatched 2 parallel `code-reviewer` agents (native
review-logic/review-style/review-frontend-conventions agent types are not
available in this runtime, matching the established fallback used in prior
flows this session):
- review-logic: verified order-preservation (no input can resolve
  differently under the new classify+switch vs. the old if-chain — the 4
  readonly-matcher commands are also registered agent-mode commands but
  none collide with the 7 literal-name checks ahead of them), verbatim-body
  correctness (all 11 switch cases byte-identical to their prior busy/idle
  bodies), deferred/not-a-command correctness, busy-dispatch.ts purity
  (zero imports), idle-path untouched, and full 13-case test coverage.
  Zero findings.
- review-style/conventions: naming matches existing `classify*` pattern
  (classifyCommand, classifyDiffLine, classifyPage, etc.), duplication is
  the deliberate documented trade-off (TRD §1.4), dead code fully removed
  (isBusyReadonlyCommand has zero orphaned references), comments still
  correct in their new position, test file style matches
  queue-nav.test.ts/main-queue.test.ts precedent, file organization matches
  the existing pure-helper-plus-test-file pattern. Zero findings.

**Verdict: APPROVE.** No blockers, majors, or minors from either reviewer.
Proceeding to commit, push, and open the PR per the operator's standing
instruction (PR → review orchestrator clean → only then merge).
- 2026-08-19T05:10:50.805Z - ac-updated: Operator requested explicit test coverage for runLine's busy-branch dispatch (none existed for any of its 24 commands); PRD addendum §12 / TRD §8 resolve this via a new pure classifyBusyDispatch function, unit-tested directly.
- 2026-08-19T05:11:10.624Z - ac-updated: Added AC9/AC10 for the classifyBusyDispatch extraction + its unit tests; revised AC8 wording since new test files are now expected.
- 2026-08-19T05:11:13.786Z - task-added: T5: Extract classifyBusyDispatch + write busy-dispatch.test.ts (operator-requested test coverage addendum)
- 2026-08-19T05:11:20.776Z - task-done: T2: Implement per plan
- 2026-08-19T05:21:12.832Z - task-done: T5: Extract classifyBusyDispatch + write busy-dispatch.test.ts (operator-requested test coverage addendum)
- 2026-08-19T05:21:12.918Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-19T05:33:02.242Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-19T05:33:22.126Z - ac-confirmed: AC1: Verified by code review: /think switch case toggles newest thought block (unchanged from idle-path body).
- 2026-08-19T05:33:22.329Z - ac-confirmed: AC2: Verified by code review: /expand switch case toggles newest output block (unchanged from idle-path body).
- 2026-08-19T05:33:22.536Z - ac-confirmed: AC3: Verified by code review: /copy switch case copies newest block (unchanged from idle-path body).
- 2026-08-19T05:33:22.729Z - ac-confirmed: AC4: Verified by code review: /workspace switch case calls showWorkspace() (unchanged from idle-path body).
- 2026-08-19T05:33:22.917Z - ac-confirmed: AC5: Verified by code review: /review switch case calls showReview() (unchanged from idle-path body).
- 2026-08-19T05:33:23.113Z - ac-confirmed: AC6: Verified by code review: /model and other unnamed commands resolve to classifyBusyDispatch='deferred', unchanged message/behavior.
- 2026-08-19T05:33:23.308Z - ac-confirmed: AC7: Verified: idle-path arms for all 5 commands are byte-identical, untouched by this diff (confirmed by both reviewers + code-verifier).
- 2026-08-19T05:33:23.510Z - ac-confirmed: AC8: code-verifier: tsc --noEmit clean, bun test 4195 pass/0 fail. src/sac/fwk-service.test.ts flake independently root-caused as pre-existing/unrelated (fails ~66% in total isolation, no diff involvement).
- 2026-08-19T05:33:23.704Z - ac-confirmed: AC9: src/tui/busy-dispatch.ts exports classifyBusyDispatch, zero deps on @opentui/core/renderer/chrome, confirmed by review-logic; order-preservation vs. original if-chain verified (no collision between literal-name and readonly-matcher checks).
- 2026-08-19T05:33:23.897Z - ac-confirmed: AC10: src/tui/busy-dispatch.test.ts: 13 tests, one per BusyDispatchTarget, all passing; verified non-vacuous by review-logic.
- 2026-08-19T05:37:26.647Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/342 (warning: PR is not a draft)
- 2026-08-19T05:37:28.933Z - completing
- 2026-08-19T05:37:30.881Z - done: all gates passed

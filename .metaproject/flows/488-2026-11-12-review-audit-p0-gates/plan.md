# Implementation Plan

Status: ready

State × event matrix: not applicable — CLI gates over a file package, no new lifecycle states.

## Premise

`review-premise` judged the seven audit findings (`premise/1.json`). A-01 and A-02 were challenged (agent-written report lines are a deliberate disclosure design, flows 451 and d7125889d), A-03 was owner-decision (flow 448's `--head` recovery), A-04 was downgraded to minor, A-05..A-07 upheld. The operator upheld A-01 and A-02 as operator waivers and chose "operator act when different" for A-03 (journal, 2026-11-12). Every finding is in scope.

## Approach

Reuse the readiness waiver as the one operator act. No new confirmation channel.

1. **T5 — verifier and head become waivers.**
   - `verifierCheck` (`src/review/readiness.ts:230`) stops accepting `Not verified: N`; repair: run review-verifier, or the operator waives `verifier`.
   - `completeHeadGate` loses the first-line escape (`complete-head-gate.ts:56-58`). It reports moved/merged as a refusal message; tracker errors stay warnings.
   - At complete, the gate's refusal must not throw before the waivers are applied (`managed.ts:1074`), and `waiveReadiness` must see `head` as failing (today `headChecked: true` makes it pass). Pass the computed gate result into readiness (for example `ReadinessOptions.headGate`) so `headCheck` fails with it and a `head` waiver covers it, without a second tracker call.
   - Update the guide checklist (`docs/docs/guides/review-with-a-record.md` items 4 and 7, "five gates" section) and any skill line offering the report-line path, without adding lines to the orchestrator SKILL.md (ceiling 1571) and keeping bundled and installed copies identical.
2. **T6 — `--head` needs an operator quote when it differs.** A new option (CLI `--head-reason "<operator quote>"`, gated like `--waive`: TTY or `--answered-by`; keryx shell card tool if `review complete` has one) is required when `--head` differs from the recorded head. The refusal names both SHAs. The manifest records `head_override: { from, to, operator_quote, time, confirmedVia? }`.
3. **T7 — waiver scope.** `packageResearchErrors` returns errors tagged by readiness item (ledger → `ledger`; dispatch, mismatch-of-reviewers and coverage-gate → `reviewers`; coverage completeness → `files-covered` / `blast-radius`; artifact-locator and manifest/research mismatch → untagged integrity). `managed.ts:1105-1107` drops only errors whose item is waived.
4. **T8 — one gate evaluation for complete and publish.** Extract the tamper check, evidence level and readiness into one function used by `completeManagedReviewLocked` and `publishReview`; publish keeps `--partial` for readiness only (tamper and evidence still refuse). Published body gains a line naming host-question decisions (premise decisions, readiness waivers, coverage waiver) as "recorded from the agent's host question; keryx did not verify the operator's answer".
5. **T9 — spawn field.** SKILL.md:118 names `model_class` with the mapping light→light, standard→standard, deep→expert (same line count). Contract test scans bundled review skills for `spawn_subagent` field names and checks each against the tool's accepted, non-ignored fields.

## Risks

- Tests that rely on `Not verified: N` or the first-line escape (`readiness.test.ts`, `complete-head-gate.test.ts`, `review-parity-cli.test.ts`, bot tests) must change on purpose, not be deleted.
- Existing closed packages are not re-gated; only new closes and publishes see the stricter items.
- `review-with-a-record.md` repeats sections (flow 491); edit both copies.

# Review depth: why reviewers return no coverage

Status: reduced to the product fixes by the operator's decision of 2026-10-12 (include in the release with flow 429).
Source: user description (origin: human-request)

## Problem

Flow 428 ("Review depth parity") shipped in 0.3.112, and its live rerun on the private frontend bench
failed the acceptance bar. The default run dispatched all 18 reviewers and ran the mutation pass
(0 killed, 2 survived), so the main item came out as a major with a surviving mutant and the
role-not-run class (A) was empty. It still reproduced only 4 of the 19 items of the reference review
(bar: 12), and `keryx review complete` refused the package after the shell had followed the
official recovery path (`ledger build`, `retry-plan`, `ingest --research`).

Four causes were found by reading the run's artefacts and the code (details in context.md; the
bench is private and is not quoted here):

1. 8 of 18 reviewers became `not-run` because `retry-plan` reads a result's `slices` as strings only
   (`asStrings`, src/review/retry-plan.ts), while the reviewer output contract
   (`reviewer-finding.schema.json`) does not define `slices` at all. The 8 that wrote them as
   `{id, status, coverage}` objects were counted as having covered nothing, twice in a row, and
   were retired as `not-run` although their `status` was DONE.
2. All 18 reviewers fail "resolved rule evidence": `ledger build` reads a top-level `definition` key of
   `drivers/<reviewer>.json`; the orchestrator skill never documents that key, and the shell wrote the
   dispatch payload under `payload` with a `skill_path`, so `unresolvedRules` stayed full.
3. A verification payload was filed in the reviewer raw directory; the ledger demands a
   `REVIEW_RESULT` in every file there and cannot tell it from a reviewer reply, so raw observations
   stay unreconciled. Three reference items were seen in raw replies and then lost after the answer
   (class C) for the same reason.
4. 18 reviewers produced 11 findings. Every reviewer states "read-only static review, no tests or
   probes", the session tier resolved to `standard`, and the regression reviewer got a blast radius
   capped to 40 of 793 candidate files. 12 reference items are class B (role ran, nothing matched).

## Expected Outcome

A default review on the same bench either reproduces at least 12 of 19 reference items and passes
`review complete` through the official commands alone, or refuses for a reason the operator can read
in one line and fix in one command. Which share of the gap is the model, the driver or the product is
settled by counts before any depth lever (tier, blast-radius cap, probes) is changed.

## Outcome criteria

- Запрос (дословно): «Зафиксировать AC9 как не достигнут, открыть флоу на разбор причин (рекомендую)» (source: the chat bot poll 131, 2026-10-12T14:27Z)
- Эффект (формализация агента): a reviewer that reports its slice coverage in either shape (ids, or objects with an id) is not retired for a stall it did not have; a driver payload written by the documented dispatch step resolves its rule file; a file in the raw directory that is not a reviewer reply is named and set aside instead of blocking reconciliation; and the 4-of-19 gap is attributed to model, driver or product with counts.
- Как наблюдать (предложение агента): `keryx review ledger build` on the rerun package lists no blocker for a role that ran, and `keryx review compare-reference` on it reports reproduced ≥ 12 of 19 with class A = 0, or the attribution table says which lever is still open.

## Out of Scope

- Changing the model, the provider or the permission mode of the operator's shell.
- The depth levers behind cause 4 (tier, blast-radius cap, probes): no file under `src/review/blast-radius.ts` or `src/gdskills/model-tier.ts` changes here.
- The control run on the second PR (AC10 of flow 428): postponed by the operator.
- The round limit (flow 429).
- Any copy of the private bench's content into this repository.

## Follow-up (not in this flow)

- A read-only `keryx review diagnose <review-id>` that prints, per reviewer, the retry decision, the slice shape read, the rule-file resolution and the counts.
- An anonymous attribution table (model, driver or product) for the 4-of-19 gap, one row per cause, summing to 19.
- TUI and sidebar surfaces for a `not-run` reviewer's retry reason and slice shape, beyond the messages the fixes above produce.
- A live rerun on the private bench with the released build, judged by the operator against the depth bar of flow 428 AC9.

# Review engine speedup, step 2: count every reply of a reviewer (R3, E4.1-E4.4)

Status: draft (flow-init skill formalizes this)
Source: user description (origin: human-request)

## Problem

On the closed vantage-frontend round #8174 `keryx review next` reports six reviewers as `[missing]` although their slices were covered. `next` keeps one reply per reviewer, the one with the largest mtime, and evaluates only it; slices covered by the older waves (`-w1`, `-w2`) are never counted, and the package's mtimes are not in wave order. Three neighbouring defects feed the same wrong answer: a `*.prev*.txt` copy can win the selection, an object in `needs_context` is dropped by the ledger but counted as open by the late-result collector, and a finished reply with no `slices` array is accepted silently. Each one sends a covered scope back to a reviewer (a wasted wave) or hides an uncovered one.

## Expected Outcome

- `next` takes every valid, not-yet-counted reply of a reviewer in wave order (wave number from `-w<n>`, mtime only when there is no number) and takes coverage and escalations from each of them; a repeated call gives the same output.
- `*.prev*.txt` files do not take part in the choice of a result.
- `needs_context` entries that are objects are read as questions in one shared place (retry plan, late-result collector, ledger), so an open question gives decision `context` everywhere.
- A finished reply with no `slices` array is not accepted silently: `next` rejects it and prints the reason.
- A package with a `retry-state.json` written by an older build is handled, and no reviewer becomes `notRun` while its slices are covered.

## Outcome criteria

- Запрос (дословно): «/home/altsay/arena/ideas/pr-review-management/23_KERYX_IMPLEMENTATION_PROMPT.md» (source: Helyx message 226364, 2026-10-25; R3 order: poll 293; start after the R1+R2 draft PR: poll 299)
- Эффект (формализация агента): `next` answers from everything a reviewer has written, not from its newest file, so a covered scope is never re-dispatched and an uncovered one is never counted.
- Как наблюдать (предложение агента): `keryx review next --package <dir>` on a copy of vantage-frontend #8174 shows no spurious `[missing]` and prints the same text on a second run; a copy of a `security-code` reply with object `needs_context` gives decision `context`; a `DONE` reply without `slices` is listed as rejected with a reason.

## Out of Scope

R4-R6 of the package (they wait for the operator's word), E3.1-E3.6, E4.5-E4.7 (excluded by poll 278), E5, E6, E7, the PR-management service. `keryx review ledger build` still reads `*.prev` files when it loads raw replies: that is outside the R3 text and is listed as remaining. No change to operator cards, the round ceiling or `decideReviewGate`.

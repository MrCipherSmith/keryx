**No blockers, merge-ready — 1 Minor.** The SQL refactor returns the same rows and the stale-indicator defect is gone, but its fix introduced the opposite defect: with a saved Merged, Closed or period filter the tab indicator misses open requests after the board opens.
Reviewed `086335a01` against `1b994df18` · round 3 (delta `33fd9647a..086335a01`) · 7 files, +134/−26 · CI: 25 passed, 2 pending (`AC8 remaining tests`, `Core tests (4/4, offline)`), none failed at review time.
Evidence level: ran — the test files of the round's blast radius (two `keryx review verify-run` records, both exit 0), `bun test src` in `apps/desktop` (756 pass), both typechecks, and one mutation run of the board DOM tests with the write-back effect removed; reviewers themselves were static only; did not run: the F-027 scenario in the app or in a test, the SQL timing after the refactor, the remaining mutant candidates.

### Prior findings

| Id | Finding | Status | Evidence |
|---|---|---|---|
| F-015 | Indicator lit again for a handled request | regressed | removals are stored again; the fix dropped seeding on load — F-027 |
| F-016 | List row computed the reason four times | closed | `reason` and `note` computed once per row |
| F-017 | `outdated` named a string | closed | local renamed `note` |
| F-018 | State lists repeated in the badge SQL | closed | lists are columns of `scoped`; rows equal term by term, NULLs included |
| F-025 | PR description stale | closed | description rewritten; checked by the orchestrator, no reviewer read it |
| F-019 | Docs say the toolbar never wraps (info) | open | not addressed |
| F-020 | PR count hidden under 760px (question) | open | not addressed, no answer recorded |
| F-021 | `publication()` called for the outdated row (info) | open | not addressed |
| F-022 | Test gaps of the round 2 delta (info) | open | not addressed; continued by F-029 |
| F-023 | Portal detection by class names (info) | open | not addressed |
| F-024 | Note de-duplication by string equality (info) | open | not addressed |
| F-026 | Docs say "awaiting merge" (info) | open | not addressed |

## Regressions the fixes introduced

- **F-027 (regressed from F-015).** See Minor.

### Minor

- **F-027. With a saved Merged, Closed or period filter the tab indicator misses open requests** (regressed from F-015) — [`apps/desktop/src/review/ReviewBoard.tsx`](https://github.com/MrCipherSmith/keryx/blob/086335a01cc6ccd4c97672215d4db86d5c308dce/apps/desktop/src/review/ReviewBoard.tsx). The load callback now only clears the carried set; cards are judged only while their snapshot is shown. The first load of a board mount is always Open, and the same callback applies the saved filters. If they select Merged only, Closed only or a period, the Open snapshot is never shown, the set stays empty, and the next load neither replaces it nor contains the open pull requests. Result: an open pull request that requests the viewer's review does not light the tab until the viewer switches to Open or All. At `33fd9647a` and `53c96b8af` it did. Seed the set from the loaded cards on a replacing load, keep the memo and the write-back effect, and add a DOM test with saved Merged filters. Traced in code; not reproduced.

<details><summary><b>Verified clean</b></summary>

- The refactored `attachBadges` statement equals the statement at `33fd9647a` row for row: `kept`, `finished` and `supersedes` compared term by term under three-valued logic by five reviewers (`runs.state` is NOT NULL); each run's `details` is still parsed once; only bound parameters and literal fragments; repository, viewer and pull request scope intact.
- The write-back effect converges after one extra render, does not loop, and is safe under StrictMode; identity change and access loss still clear the set; no number from another repository or account can survive.
- Removing the write-back effect fails an existing DOM test (orchestrator mutation run: 43 pass, 1 fail).
- F-016 and F-017 change no output.
- Info notes kept in the findings block: the new DOM test does not pin the write-back by itself, the reset on a replacing load is unpinned, and the test sleeps 5 ms (F-028); the store tests have no fixture that separates the `reviewed` terms (F-029).

</details>

<details><summary><b>How this review was run</b></summary>

- **Workflow:** `review-orchestrator`; severity per the canonical rubric in the skill.
- **Scope:** delta `33fd9647a..086335a01` of PR #1294, round 3 (previous round found in the local package). Six slices: one fix, two new, three second-look. Unchecked commits: none.
- **Models:** opus — review-logic on the fix and new slices, review-premise. sonnet — every other dispatch.
- **Tools:** `keryx review plan`, `override-reviewers`, `context-collect`, `verify-run`, `next`, `ingest`, `ledger build`; `gh` for PR state and checks.
- **Skills:** review-orchestrator, six reviewer skills, review-premise.
- **Subagents:** 7 reviewer dispatches (waves of one reviewer merged into one dispatch) and one premise judge.
- **Fallback:** every reviewer via `general-purpose` with its `SKILL.md` path, because the host has no agent type per reviewer.
- **Not run:** by operator decision, eight reviewers of the planned roster: review-architecture, review-clean-code, review-degradation, review-highload, review-layout, review-performance, review-style, review-ui-ux. review-pr-contract — the rewritten description was not reviewed. review-verifier — no blocker or major. Mutation pass — 7 candidates proposed, 1 executed by the orchestrator.
- **Selection:** reviewers — six of fourteen (operator, recorded in `operator-decisions.json`); models — chosen by the orchestrator.
- **Verification:** annotate. No review-verifier pass ran. F-027 rests on a code trace by review-logic, the premise judge and the orchestrator, without a reproduction. One review-frontend finding was narrowed from minor to info by the orchestrator's mutation run.
Not verified: 1
- **Stage counts:** 7 raw findings from 7 dispatches (two written twice, once per merged wave); 3 retained after merging; 1 narrowed.
- **Context:** `.metaproject/flows/516-2026-11-23-desktop-review-v2-stage0/`
- **Follow-up file:** none
- **Reviewed at:** 2026-11-23T11:40Z

</details>

```json keryx:findings
[
 {
  "id": "F-027",
  "reviewer": "review-logic",
  "severity": "minor",
  "file": "apps/desktop/src/review/ReviewBoard.tsx",
  "line": 231,
  "quote": "if (replaceAttention) setCarriedAttention(new Set());",
  "problem": "Regressed from F-015. The load callback no longer judges the loaded cards; it only clears carriedAttention on a replacing load, and cards are judged only by the attentionPrs memo, which sees the snapshot only while it is shown. The first load of every board mount uses EMPTY_FILTERS (open) and, in the same callback, applies the saved filters. When the saved filters select Merged only, Closed only or a period, the scope changes in the same batched update: the open snapshot is never shown, nothing is written back, and the carried set stays empty. The following merged, closed or period load does not replace the set and does not contain the open pull requests.",
  "impact": "Saved filter State = Merged (or a 7/30/90-day period). An open pull request requests review from the viewer. The viewer opens the project or picks another repository (the board remounts per cwd, viewer and repo). The tab indicator shows nothing instead of 'attention' and stays that way until the viewer switches to an Open or All view. At 33fd9647a and at 53c96b8af the load callback added the card and the indicator showed 'attention'. This is the reverse of F-015: a missed request instead of a stale one.",
  "suggested_fix": "Seed the set on a replacing load instead of clearing it: `if (replaceAttention) setCarriedAttention(new Set(loaded.cards.filter(c => needsViewerAttention(c, loaded.viewer, unreadCount(loaded, c))).map(c => c.number)));` and keep the memo and the write-back effect. Add a DOM test: saved filters with state merged, a load that returns an open card requesting the viewer for 'open' and nothing for 'merged', assert the last indicator is 'attention'.",
  "evidence": "ReviewBoard.tsx at head: :97 useState(EMPTY_FILTERS); :230 replaceAttention true on the first load; :231 the only write in the callback; :233-236 setFilters(readReviewFilters(...)) on the first load of a mount; :276 snapshot is null when read.scope !== scope; :339-352 the memo and the effect act only on a shown snapshot. Traced by review-logic and re-read by the orchestrator; not reproduced in the app, no test written. The shape of the F-015 fix (load callback only resets) was suggested in the orchestrator's own worker brief.",
  "confidence": "medium",
  "dedupe_key": "carried-attention-unseeded-when-first-load-hidden",
  "blocking_merge": false,
  "degradation_class": "behaviour-delta",
  "evidence_kind": "consumer-trace"
 },
 {
  "id": "F-028",
  "reviewer": "review-frontend",
  "severity": "info",
  "file": "apps/desktop/src/review/ReviewBoard.dom.test.tsx",
  "line": 1006,
  "quote": "test(\"a request handled after the load stays out of the tab signal when the scope switches to a historical view\"",
  "problem": "Narrowed from a minor report. The new test alone passes with the write-back effect deleted (the carried set then stays empty for the whole test). The effect is pinned by an existing test instead. Still unpinned: the reset of the carried set on a replacing load, and the 5 ms sleep the new test uses to wait for the read receipt.",
  "impact": "A reader takes the new test for the guard of the write-back; it guards only against the pre-fix design. Dropping the reset on replace keeps the suite green.",
  "suggested_fix": "In the new test keep a second pull request that still needs attention and assert the indicator stays 'attention' after the switch; add a case where a pull request absent from a replacing load leaves the indicator; wait on state instead of sleeping.",
  "evidence": "Orchestrator mutation run at 086335a01: with the effect line removed, `bun test src/review/ReviewBoard.dom.test.tsx` gives 43 pass, 1 fail — the failing test is 'a historical filter retains known open requests and removes them when their PR is observed as merged', the new test passes. File restored afterwards. Reported by review-frontend and review-testing-practices.",
  "confidence": "high",
  "dedupe_key": "f015-test-does-not-pin-writeback",
  "blocking_merge": false,
  "degradation_class": "blind-test",
  "evidence_kind": "red-test"
 },
 {
  "id": "F-029",
  "reviewer": "review-testing-practices",
  "severity": "info",
  "file": "src/review/desk-run-store.test.ts",
  "line": 489,
  "quote": "test(\"the outdated lookup ignores newer finished runs of another PR, another viewer, hidden runs and runs without a result\", async () => {",
  "problem": "The store tests have no run whose details lack baseSha/headSha, and in the fixtures the range a run was requested for equals the range it reviewed, so the `reviewed` terms of the refactored statement are redundant with `live` in the suite. Continues F-022 (a).",
  "impact": "Dropping `reviewed` from `kept` or `supersedes` may keep the suite green. The refactor itself was checked equal term by term by five reviewers.",
  "suggested_fix": "Add a fixture where a run was requested on one range and reviewed another, and one with NULL requested SHAs.",
  "evidence": "Read by review-testing-practices; no mutant run.",
  "confidence": "medium",
  "dedupe_key": "store-tests-reviewed-term-redundant",
  "blocking_merge": false,
  "degradation_class": "blind-test"
 }
]
```

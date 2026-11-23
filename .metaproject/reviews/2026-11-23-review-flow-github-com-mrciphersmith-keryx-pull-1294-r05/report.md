**No blockers, merge-ready — 6 Minor.** The fix of F-030/F-031 closes the reported paths and the operator's three answers are in place, but returning to an earlier account still misses open requests, the hint can miscount and mislead, and none of the seed code's race guards is pinned by a test.
Reviewed `8e6ecf1aa` against `1b994df18` · round 5 (new: `91c37c81b`, `85bd13a03`, `8e6ecf1aa`) · CI: not run — local commits, not pushed.
Evidence level: ran — `bun test src` in `apps/desktop` (766 pass, `verify-run` record), `bunx tsc --noEmit`, five mutations of the fix at `91c37c81b` (all killed) and eight more at this head (all survive), toolbar measurements on rebuilt markup with the real stylesheets; reviewers themselves were static only; did not run: any scenario in the app, a screen reader.

### Prior findings

| Id | Finding | Status | Evidence |
|---|---|---|---|
| F-030 | Indicator misses open requests after access loss or account change on a historical view | partial | reported paths closed; return to an earlier account still open (F-034) |
| F-031 | Write-back from a cached snapshot | closed | `stale` fallback never writes back; cleared by every successful load |
| F-032 | Threshold wording | closed | deviation (c) gives content-box and panel widths |
| F-033 | Unpinned test terms | partial | identity term pinned; seed races unpinned (F-039) |
| F-012 | Indicator counts filtered-out cards | closed by decision | hint and reset added; defects in it are F-035, F-037 |
| F-013 | "Review changes" wording | closed | "Review again" in board, list and detail |
| F-020 | Count hidden on a narrow toolbar | closed by decision | bare number; accessible name defect is F-036 |

## Regressions the fixes introduced

- **F-034 (incomplete fix of F-030).** See Minor.

### Minor

- **F-034. Returning to an earlier account on a saved historical filter misses its open requests** — [`apps/desktop/src/review/ReviewBoard.tsx`](https://github.com/MrCipherSmith/keryx/blob/8e6ecf1aa3dae3dc1ce6ed9c1512cec88da590ec/apps/desktop/src/review/ReviewBoard.tsx). An identity change on a Merged, Closed or period load empties the carried set, but the `seeded` marker still names the identity seeded before the switch, so no seed is requested when the board returns to it. Clear the marker where the set is emptied for a new identity. Traced; not reproduced.
- **F-035. The hint miscounts on a cached Open snapshot** — [`apps/desktop/src/review/ReviewBoard.tsx`](https://github.com/MrCipherSmith/keryx/blob/8e6ecf1aa3dae3dc1ce6ed9c1512cec88da590ec/apps/desktop/src/review/ReviewBoard.tsx). After an `unavailable:` error on the Open view the hint counts carried requests that the old snapshot lacks as "hidden by filters"; its reset reloads nothing and wipes the saved filters for no effect.
- **F-036. The bare count has no unit for assistive technology** — [`apps/desktop/src/review/ReviewBoard.tsx`](https://github.com/MrCipherSmith/keryx/blob/8e6ecf1aa3dae3dc1ce6ed9c1512cec88da590ec/apps/desktop/src/review/ReviewBoard.tsx). `aria-label` on a role-less span is not a reliable name, and the hidden word is `display:none`. Use the visually-hidden pattern instead.
- **F-037. The hint does not say what its click does, and drops focus** — [`apps/desktop/src/review/ReviewBoard.tsx`](https://github.com/MrCipherSmith/keryx/blob/8e6ecf1aa3dae3dc1ce6ed9c1512cec88da590ec/apps/desktop/src/review/ReviewBoard.tsx). The click overwrites the saved filters and the search; the label names only the cause, the narrow form is an icon and a number, and focus falls to the page body after the click.
- **F-038. The seed load is restarted by every historical load** — [`apps/desktop/src/review/ReviewBoard.tsx`](https://github.com/MrCipherSmith/keryx/blob/8e6ecf1aa3dae3dc1ce6ed9c1512cec88da590ec/apps/desktop/src/review/ReviewBoard.tsx). A new `seedFor` object per load aborts and re-issues the seed; an account switch on a historical view costs three requests instead of two. Request budget only.
- **F-039. The seed code's race guards are not pinned** — `apps/desktop/src/review/ReviewBoard.dom.test.tsx`. Executed: 8 single-line mutations of the new code (both `setSeedFor(null)` calls, each of the three seed-guard clauses, the catch cleanup, `setQuery("")` in the reset, `stale` always true) each leave the DOM test file green. Add tests with held load promises for the seed races and hint tests for search and the stale fallback.

<details><summary><b>Verified clean</b></summary>

- No number of one account or repository can reach another's carried set or indicator; the seed is applied only for the current, still unseeded identity; access loss resets the seed state (security, logic, frontend).
- Seed vs main load ordering, abort on cleanup, no state update after unmount; `stale` kept or dropped correctly at every `setRead` site (frontend, regression, logic).
- Seeded identities behave as at `1d3d65420`; "Review again" is renamed consistently; the hint's reset clears only this board's saved filters and search (regression, security).
- Deviations (c) and (d) match the stylesheet, the hint code and the measurements (logic, second look).
- Info kept in the findings block: the hint wraps the toolbar to two rows at about 560, 820 and 1180px while shown, its hover removes the fill, and the 80px search field truncates its placeholder (F-040).

</details>

<details><summary><b>How this review was run</b></summary>

- **Workflow:** `review-orchestrator`; severity per the canonical rubric in the skill.
- **Scope:** head `8e6ecf1aa`. The planner cut slices against `33fd9647a`; reviewers were told which commits are new and not to re-report rounds 3 and 4.
- **Models:** opus — review-logic on the new code, review-premise. sonnet — every other dispatch.
- **Subagents:** 8 reviewer dispatches and one premise judge; every reviewer via `general-purpose` with its `SKILL.md` path.
- **Not run:** by operator decision, eight reviewers of the planned roster: review-architecture, review-backend, review-clean-code, review-degradation, review-highload, review-performance, review-pr-contract, review-style. review-verifier — no blocker or major.
- **Selection:** seven of fifteen reviewers (operator, recorded in `operator-decisions.json`); models — chosen by the orchestrator.
- **Verification:** annotate. F-039 rests on an executed mutation run; F-034, F-035, F-038 on code traces upheld by the premise judge.
Not verified: 1
- **Stage counts:** 22 distinct raw findings from 8 dispatches; 7 retained after merging.
- **Context:** `.metaproject/flows/516-2026-11-23-desktop-review-v2-stage0/`
- **Follow-up file:** none
- **Reviewed at:** 2026-11-23T12:40Z

</details>

```json keryx:findings
[
 {
  "id": "F-034",
  "reviewer": "review-logic",
  "severity": "minor",
  "file": "apps/desktop/src/review/ReviewBoard.tsx",
  "line": 245,
  "quote": "if (identity.current !== nextIdentity) setCarriedAttention(new Set());",
  "problem": "Incomplete fix of F-030 (T22). On a non-replacing load an identity change empties the carried attention set, but the `seeded` ref keeps the identity seeded earlier, and a seed is requested only when `seeded.current !== nextIdentity`. When the board returns to an identity seeded before a switch, the set is emptied and no seed follows; a late seed of the other identity is dropped by the guard.",
  "impact": "Accounts A and B both have saved filter State = Merged. A is seeded at mount. The account switches to B; a merged load empties the set and requests B's seed, which fails or is still in flight. The account switches back to A; the next merged load empties the set again and requests nothing, because `seeded` still says A. A's open pull request that requests A's review does not light the tab until A opens the Open or All view — the F-030 false negative, for the account the viewer returns to.",
  "suggested_fix": "Clear the seed marker wherever the set is emptied for a new identity: `if (identity.current !== nextIdentity) { setCarriedAttention(new Set()); seeded.current = \"\"; }` before the seed check. DOM test: A seeded, switch to B on Merged with B's seed failing, switch back to A on Merged, assert an open request was issued and the indicator is 'attention'.",
  "evidence": "ReviewBoard.tsx at 8e6ecf1aa: :118 `seeded`; :193 and :241 are its only resets; :245-246; :248-252 setFilters(readReviewFilters(...)) restores the saved historical filter after clearPrivateView(true); :280 seed guard. Traced by review-logic and re-read by the orchestrator; not run.",
  "confidence": "high",
  "dedupe_key": "seeded-marker-not-invalidated-on-identity-change",
  "blocking_merge": false,
  "degradation_class": "behaviour-delta",
  "evidence_kind": "consumer-trace",
  "location_class": "in-diff"
 },
 {
  "id": "F-035",
  "reviewer": "review-logic",
  "severity": "minor",
  "file": "apps/desktop/src/review/ReviewBoard.tsx",
  "line": 427,
  "quote": "const hiddenAttention = snapshot ? [...attentionPrs].filter(n => !shownNumbers.has(n)).length : 0;",
  "problem": "The F-012 hint counts carried numbers absent from the shown snapshot. That is right for historical and period views (the reset moves to the open scope, where they load) but wrong when the shown snapshot is the open scope itself as a stale cached fallback after an `unavailable:` error: the hint reports requests 'hidden by filters' that no filter hides, and its reset keeps the same scope, reloads nothing and shows nothing new.",
  "impact": "After an `unavailable:` error on the Open view the toolbar can show '1 waiting on you hidden by filters'; clicking it changes nothing visible, the button stays, and the viewer's saved filters are wiped for no effect.",
  "suggested_fix": "While the snapshot is a fallback (`read.stale` or `error` set) count only cards present in the snapshot that the filters hide, or hide the hint. DOM test for the scenario.",
  "evidence": "ReviewBoard.tsx :262-266 stale fallback; :375-384 attentionPrs; :425-427 reset and hint; model.ts EMPTY_FILTERS maps to scope 'open'. Traced by review-logic; also noted as info by review-ui-ux and review-frontend.",
  "confidence": "medium",
  "dedupe_key": "hidden-attention-hint-on-stale-open-snapshot",
  "blocking_merge": false,
  "evidence_kind": "consumer-trace",
  "location_class": "in-diff"
 },
 {
  "id": "F-036",
  "reviewer": "review-frontend",
  "severity": "minor",
  "file": "apps/desktop/src/review/ReviewBoard.tsx",
  "line": 441,
  "quote": "<div className=\"flows-heading\"><h1>Pull requests</h1>{snapshot && <span className=\"count-label\" aria-label={countText} title={countText}>",
  "problem": "The count is named with aria-label on a plain span, which has no role that accepts a name (ARIA 1.2), and under the 760px container query the visible word is removed with display:none, which also removes it from the accessibility tree.",
  "impact": "On the narrow toolbar — the default window with the PR panel open — a screen reader announces a bare number next to the heading, with no unit. The title tooltip helps pointer users only.",
  "suggested_fix": "Hide `.count-word` visually (the existing `.sr-only` pattern) instead of display:none under the container query, and drop aria-label and title from the span.",
  "evidence": "ReviewBoard.tsx count span; review.css `@container (max-width: 760px)` rule hiding `.count-word`. Reported by review-frontend, review-ui-ux and review-layout; review-testing-practices notes the test asserts only the attribute. Not checked with a screen reader.",
  "confidence": "medium",
  "dedupe_key": "count-label-aria-on-span",
  "blocking_merge": false,
  "degradation_class": "behaviour-delta",
  "location_class": "in-diff"
 },
 {
  "id": "F-037",
  "reviewer": "review-ui-ux",
  "severity": "minor",
  "file": "apps/desktop/src/review/ReviewBoard.tsx",
  "line": 425,
  "quote": "const reset = () => { applyFilters(EMPTY_FILTERS); setQuery(\"\"); };",
  "problem": "The hint button names the cause ('N waiting on you hidden by filters') but not what a click does: it overwrites the viewer's saved filters with the defaults and clears the search, with no undo. Under 1100px it shrinks to an alert icon and a number right after the bare pull request count, with its meaning only in a tooltip. After the click the focused button unmounts and keyboard focus falls to the page body.",
  "impact": "A viewer with tuned saved filters clicks a warning chip to see two requests and loses the filter set; on the default window the chip reads as a second unlabelled number; keyboard and screen reader users lose their place.",
  "suggested_fix": "Label the action: 'Show N waiting on you' with the accessible name 'Show N waiting on you — clears filters and search'; keep one short word at the narrow width (e.g. icon + 'N hidden'); move focus to the search field after the reset.",
  "evidence": "ReviewBoard.tsx hint markup and reset; review.css `.toolbar-label` hidden under 1100px. Reported by review-ui-ux (label, narrow form) and review-frontend (focus loss). Not rendered, not run with assistive technology.",
  "confidence": "high",
  "dedupe_key": "hint-label-effect-and-focus",
  "blocking_merge": false,
  "location_class": "in-diff"
 },
 {
  "id": "F-038",
  "reviewer": "review-regression",
  "severity": "minor",
  "file": "apps/desktop/src/review/ReviewBoard.tsx",
  "line": 246,
  "quote": "if (seeded.current !== nextIdentity) setSeedFor({ identity: nextIdentity });",
  "problem": "Each non-replacing load of an unseeded identity creates a new `seedFor` object, and the seed effect depends on object identity: every such load aborts the running seed and issues a new open request. On an identity change seen on a historical view the seed is requested even when the same callback's filter reset already starts an open load.",
  "impact": "Extra GitHub list requests (rate-limit budget): an account switch on a historical view costs three requests instead of two, and repeated historical loads before the first open load restart the seed each time. No wrong state.",
  "suggested_fix": "Keep `seedFor` stable per identity (`setSeedFor(old => old?.identity === nextIdentity ? old : { identity: nextIdentity })`); skip it when the same callback resets the filters to the open scope.",
  "evidence": "ReviewBoard.tsx :246 and the seed effect deps `[seedFor, cwd, repo, expectedViewer, load]`. Reported by review-regression and review-frontend; request counts derived by reading.",
  "confidence": "medium",
  "dedupe_key": "seed-restarted-per-historical-load",
  "blocking_merge": false,
  "degradation_class": "behaviour-delta",
  "location_class": "in-diff"
 },
 {
  "id": "F-039",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "file": "apps/desktop/src/review/ReviewBoard.dom.test.tsx",
  "line": 1140,
  "quote": "test(\"an open seed answered for another account does not enter the tab signal\", async () => {",
  "problem": "The new tests pin the named scenarios but never build the races the seed code guards: every load double resolves at once, so the seed always lands after its main load and never overlaps a scope switch, a second historical load or an open load. The hint tests cover one trigger (a saved author filter) and not the search, the saved-filter wipe or the stale-fallback case.",
  "impact": "Executed by the orchestrator, each alone, file restored after each: removing `setSeedFor(null)` on an open load, removing it after an applied seed, dropping any one of the three seed-guard clauses (`identity.current !== key`, `seeded.current === key`, `key !== seedFor.identity`), removing the catch cleanup, dropping `setQuery(\"\")` from the reset, and marking every `unavailable:` fallback stale — all 8 leave `ReviewBoard.dom.test.tsx` green. These are the lines added for F-030, on code that regressed in earlier rounds.",
  "suggested_fix": "Add tests with held (manually resolved) load promises: a seed in flight when the viewer switches to Open; a seed in flight across an account change; a seed landing after an open load already replaced the set. Add hint tests for the search trigger, the saved-filter result and the stale fallback.",
  "evidence": "Orchestrator mutation run at 8e6ecf1aa: 8 of 8 candidates survive (0 fail each). Reported by review-testing-practices by reading.",
  "confidence": "high",
  "dedupe_key": "seed-races-unpinned",
  "blocking_merge": false,
  "degradation_class": "blind-test",
  "evidence_kind": "red-test",
  "location_class": "in-diff"
 },
 {
  "id": "F-040",
  "reviewer": "review-layout",
  "severity": "info",
  "file": "apps/desktop/src/styles/review.css",
  "line": 99,
  "quote": ".review-board .flows-toolbar .review-hidden-attention:hover { background: transparent; }",
  "problem": "Toolbar notes: the hint lives inside the non-shrinking heading and wraps the toolbar to two rows at about 560, 820 and 1180px while shown (measured, no clipping); its hover removes the fill instead of strengthening it like sibling buttons; at 80px the search field shows only the first letters of its placeholder.",
  "impact": "Cosmetic; the review.css comment says the 80px rule keeps one row at 560px, which holds only without the hint.",
  "suggested_fix": "Use an existing hover token; state in the comment and in deviation (d) that the hint may wrap the toolbar.",
  "evidence": "layout-measurements-t23.md; review.css. Reported by review-layout and review-ui-ux.",
  "confidence": "medium",
  "dedupe_key": "toolbar-hint-cosmetics",
  "blocking_merge": false,
  "location_class": "in-diff"
 }
]
```

## Token spend

token spend: unknown (19 dispatch(es), none reported usage)

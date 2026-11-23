**No blockers, merge-ready.** The four new commits introduce no defect; the fix of F-027 holds, and one gap of the same shape that predates this pull request is recorded below.
Reviewed `be26765ae` against `1b994df18` · round 4 (new since round 3: `086335a01..be26765ae`, 10 files, +182/−13; the planner cut the slices against `33fd9647a`) · CI: not run — these commits are local and not pushed; the last pushed head `622c914b7` had 19 checks passed and 8 pending when last read.
Evidence level: ran — the test files of the round's blast radius (two `keryx review verify-run` records, both exit 0), `bun test src` in `apps/desktop` (759 pass), both typechecks, the store, badge and publication test files, and four mutation runs of the board DOM tests; reviewers themselves were static only; did not run: any scenario in the app, the SQL timing, the remaining mutant candidates, the F-030 scenario as a test.

### Prior findings

| Id | Finding | Status | Evidence |
|---|---|---|---|
| F-027 | Indicator misses open requests with a saved historical filter | closed | replacing load seeds the set; DOM test fails with the seeding removed |
| F-015 | Indicator lit again for a handled request | closed | write-back stores removals; DOM test fails with the effect removed |
| F-016, F-017, F-018 | List row locals, local name, SQL state lists | closed | as in round 3 |
| F-019 | Docs say the toolbar never wraps | closed | deviation (c) recorded; wording corrected after the round (F-032) |
| F-021 | `publication()` read for the outdated row | closed | read only when the reviewed range is the card's; output unchanged |
| F-023 | Portal detection by class names | closed | `data-review-board-dialog` on both portaled dialogs only |
| F-026 | Docs say "awaiting merge" | closed | wording removed |
| F-025 | PR description stale | closed | rewritten at `622c914b7`; not updated for this round's commits; no reviewer read it |
| F-022 | Test gaps of round 2 | partial | (a) and (c) closed; (b) the SQL saving is still not asserted |
| F-028 | New test did not pin the write-back | partial | pinned now; reset on replace and the 5 ms sleep remain |
| F-029 | Store tests: `reviewed` term | partial | pinned in `kept`; not in `supersedes`; no NULL-SHA run |
| F-020 | PR count hidden under 760px (question) | open | recorded in deviation (c); no operator answer |
| F-024 | Note de-duplication by string equality (info) | open | not addressed, by choice |

### Questions

- **F-020.** Unchanged from round 2: accept that the pull request count and the watcher status are hidden on a narrow toolbar, or keep the bare number?

<details><summary><b>Pre-existing (not blocking)</b></summary>

- **F-030 (minor). After an access error or an account change on a Merged, Closed or period view, the tab indicator misses open requests** — [`apps/desktop/src/review/ReviewBoard.tsx`](https://github.com/MrCipherSmith/keryx/blob/be26765ae0deaaae0dc379eb5befde79d6fe41ed/apps/desktop/src/review/ReviewBoard.tsx). A load counts as replacing whenever the identity is unknown or changed, whatever its scope. After `accessLost` the state filter is kept, so the next load can be a historical one; it replaces the carried set with nothing, and with saved historical filters no open load follows. Same on the merge base. Fix: on an unknown or changed identity with a historical scope, run one open load that only seeds the set, or reset the filters in `accessLost`. Traced in code; not reproduced.

</details>

<details><summary><b>Verified clean</b></summary>

- Seeding on a replacing load and the memo use the same predicate on the same snapshot; the write-back converges after one write; no stale closure (frontend, regression, logic).
- Skipping `publication()` cannot change a badge: its only badge-path reader requires the reviewed range to equal the card's range, which is the new guard; `cardByPr` is built per 200-card chunk from the slice the query receives (backend, logic, regression, security).
- The dialog marker is inside the `role="dialog"` node of both portaled dialogs and absent from the non-portaled ones; it gates nothing but focus restore.
- Mutation runs by the orchestrator, file restored each time: write-back removed → 1 fail; seeding removed → 1 fail; seeding on every load → 3 fail; PR watcher marker removed → 1 fail.
- Info notes kept in the findings block: on an `unavailable:` error the write-back persists verdicts of a cached snapshot (F-031); the threshold wording of deviation (c), corrected in `200f2b395` after this head (F-032); what the suites still leave unpinned (F-033).

</details>

<details><summary><b>How this review was run</b></summary>

- **Workflow:** `review-orchestrator`; severity per the canonical rubric in the skill.
- **Scope:** head `be26765ae` of PR #1294. The planner labelled this round 3 with delta `33fd9647a..be26765ae` because the package of the previous round did not pass the completion gate; reviewers were told which commits are new (`20b535531`, `251d494ac`, `f72f23f73`, `be26765ae`) and that the rest was reviewed in the previous round. Commit `200f2b395` (a one-sentence docs correction) was made after the reviewed head and is not reviewed.
- **Models:** opus — review-logic on the fix and new slices, review-premise. sonnet — every other dispatch.
- **Tools:** `keryx review plan`, `override-reviewers`, `verify-run`, `ingest`, `ledger build`; `gh` for PR checks.
- **Skills:** review-orchestrator, six reviewer skills, review-premise.
- **Subagents:** 7 reviewer dispatches and one premise judge.
- **Fallback:** every reviewer via `general-purpose` with its `SKILL.md` path, because the host has no agent type per reviewer.
- **Not run:** by operator decision, nine reviewers of the planned roster: review-architecture, review-clean-code, review-degradation, review-highload, review-layout, review-performance, review-pr-contract, review-style, review-ui-ux. review-verifier — no blocker or major. Mutation pass — 9 further candidates proposed, none executed. `comments collect` and `context-collect` were not re-run for this package. review-regression read the commits and not its slices in full; review-logic (second look) read one of its three slices in full.
- **Selection:** reviewers — six of fifteen (operator, recorded in `operator-decisions.json`); models — chosen by the orchestrator.
- **Verification:** annotate. No review-verifier pass ran. F-030 rests on a code trace by review-logic and the premise judge, without a reproduction.
Not verified: 1
- **Stage counts:** 8 distinct raw findings from 7 dispatches; 4 retained after merging.
- **Context:** `.metaproject/flows/516-2026-11-23-desktop-review-v2-stage0/`
- **Follow-up file:** none
- **Reviewed at:** 2026-11-23T12:05Z

</details>

```json keryx:findings
[
 {
  "id": "F-030",
  "reviewer": "review-logic",
  "severity": "minor",
  "file": "apps/desktop/src/review/ReviewBoard.tsx",
  "line": 230,
  "quote": "const replaceAttention = identity.current !== nextIdentity || (!period && (state === \"open\" || state === \"all\"));",
  "problem": "Sibling of F-027 that predates this pull request. Seeding the carried attention set on a replacing load is right only when that load holds every open pull request. The first disjunct makes any load with an unknown or changed identity replacing, whatever its scope. Two paths reach such a load on a Merged, Closed or period scope: (1) accessLost clears identity.current and calls clearPrivateView() without a reset, which keeps the state filter, so the next load runs on the kept historical scope; (2) an identity change detected on a historical-scope load resets to the default filters, but the saved filters of the new identity are applied in the same batch. In both the set is filled from a snapshot that cannot hold open requests, and with saved historical filters no open load follows.",
  "impact": "Saved filter State = Merged. A badge poll, the rules dialog or the watcher reports an access or configuration error; the viewer re-authenticates and presses Refresh. An open pull request that requests the viewer's review is not in the merged snapshot, the carried set is replaced with nothing, and the tab indicator stays off until the viewer switches to Open or All. The same holds for a saved open + period filter and requests on pull requests not updated in the period. The merge base behaves the same way.",
  "suggested_fix": "Seed only from a scope that can hold every open request and make sure such a load happens once per identity: on an unknown or changed identity with a historical scope, clear the set and run a one-off open load whose result only seeds it. Smaller alternative for path (1): call clearPrivateView(true) in accessLost so the first load after recovery is open, as on mount. DOM test: apply Merged, make the next load throw an access error, then return nothing for merged and an open card requesting the viewer for open, press Refresh, assert the indicator is 'attention'.",
  "evidence": "ReviewBoard.tsx at be26765ae: :128-136 clearPrivateView keeps the state unless resetState; :182-193 accessLost; :207-209 identity change; :230-236 replaceAttention, the seed and setFilters(readReviewFilters(...)). model.ts:37-38 needsViewerAttention is false for non-open cards. The same three lines exist at the merge base 1b994df18. Traced by review-logic; not reproduced in the app, no test written. The reviewer did not check whether the app shell remounts the board on access loss, which would rule out path (1).",
  "confidence": "medium",
  "dedupe_key": "carried-attention-seeded-from-historical-replacing-load",
  "blocking_merge": false,
  "location_class": "pre-existing",
  "evidence_kind": "consumer-trace"
 },
 {
  "id": "F-031",
  "reviewer": "review-logic",
  "severity": "info",
  "file": "apps/desktop/src/review/ReviewBoard.tsx",
  "line": 247,
  "quote": "setRead((old) => ({ scope, snapshot: (old.scope === scope ? old.snapshot : null) ?? snapshots.current.get(scope) ?? null, error: message, loading: false }));",
  "problem": "On an `unavailable:` error after a scope switch the board shows the cached snapshot of that scope from an earlier visit. The attention memo judges it as current and the write-back effect copies the result into the carried set. A pull request seen as merged in the meantime is added back from the older open snapshot and stays carried after the viewer leaves the open view.",
  "impact": "While the stale board is shown the indicator matches what is on screen; the cost is that the stale entry persists until the next successful open load. Before the write-back existed an error never changed the set.",
  "suggested_fix": "Skip the write-back while the shown snapshot is an error fallback (read.error is set).",
  "evidence": "ReviewBoard.tsx :124-126, :247, :276, :339-352. Traced by review-logic only.",
  "confidence": "medium",
  "dedupe_key": "attention-writeback-from-stale-cached-snapshot",
  "blocking_merge": false,
  "degradation_class": "behaviour-delta",
  "evidence_kind": "consumer-trace"
 },
 {
  "id": "F-032",
  "reviewer": "review-logic",
  "severity": "info",
  "file": "docs/requirements/keryx-desktop-review-v2/implementation-plan.md",
  "line": 24,
  "quote": "(c) Панель инструментов доски не гарантированно остаётся в одну строку, и меню для второстепенных элементов нет.",
  "problem": "Deviation (c) gave the thresholds 1100px and 760px as panel widths. The container queries measure the toolbar's content box, so labels hide for a panel up to about 1140px and the count and watcher status up to about 800px.",
  "impact": "A reader sizing a window from the document expected labels at a 1120px panel. No runtime effect.",
  "suggested_fix": "State the thresholds as content-box widths with the matching panel widths.",
  "evidence": "review.css lines 85-95; layout-measurements.md 'After the fix'. Corrected by the orchestrator in the commit that follows this round's head; the wrong wording came from the orchestrator's own brief.",
  "confidence": "high",
  "dedupe_key": "docs-toolbar-threshold-content-box",
  "blocking_merge": false,
  "degradation_class": "diff-vs-description"
 },
 {
  "id": "F-033",
  "reviewer": "review-testing-practices",
  "severity": "info",
  "file": "src/review/desk-run-store.test.ts",
  "line": 516,
  "quote": "test(\"each term of the outdated lookup is pinned by its own fixture\", async () => {",
  "problem": "What the suites still leave unpinned after this round, by reading: the `done AND reviewed` term of `supersedes` and the F-021 publication gate (neither changes the badge, only the rows read); a run with NULL requested SHAs; the identity, period and `all` terms of `replaceAttention` and a pull request absent from a replacing load (reset versus union); the Review rules dialog marker was not mutated; the handled-request DOM test still sleeps 5 ms for the read receipt.",
  "impact": "Each of these single-line changes is expected to keep the suites green. None gives a wrong badge or indicator today except the replaceAttention terms, which F-030 is about.",
  "suggested_fix": "Count returned rows or publication reads through a seam; add the missing fixtures; wait on state instead of sleeping.",
  "evidence": "Read by review-testing-practices and review-logic (second look); no mutant run for these.",
  "confidence": "medium",
  "dedupe_key": "round4-tests-unpinned",
  "blocking_merge": false,
  "degradation_class": "blind-test"
 }
]
```

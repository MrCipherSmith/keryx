**Changes requested — 1 Major, 7 Minor, 2 questions.** The six board fixes do what the description says and the SQL is scoped correctly; the risk is the toolbar, which now overflows at the default window size with the detail panel open.
Reviewed `53c96b8af` against `1b994df18` · round 1 · 29 files, +2170/−198 · CI green (29 checks passed, 1 skipped).
Evidence level: ran — the 26 test files of the round's blast radius (two `keryx review verify-run` records, both exit 0), a SQLite version probe, and browser measurements of the toolbar on a board without data; reviewers themselves were static only; did not run: mutation pass, query plan, the app with board data.

### Major

- **F-001. The board toolbar overflows at the default window size with the detail panel open** — [`apps/desktop/src/styles/review.css`](https://github.com/MrCipherSmith/keryx/blob/53c96b8af161a9aa7550f6d8f7c2ed739baaf110/apps/desktop/src/styles/review.css). The toolbar is now `nowrap` with fixed-size children. At a board width of 560px (default 1180px window, 60px rail, 560px detail panel) the content is wider than the toolbar: measured `scrollWidth` 567 vs `clientWidth` 560 on a board without data, with the Refresh button ending 7px past the edge. With data the Review rules button is added, so more is clipped and from a wider board. On the base commit the toolbar wrapped here. Fix: restore wrapping below the width where the collapsed toolbar stops fitting (about 760px), or let the search field and the watcher status text shrink; re-measure at 560, 700 and 820px with data.

### Minor

- **F-002. Focus is no longer returned to the search field** — [`apps/desktop/src/review/ReviewBoard.tsx`](https://github.com/MrCipherSmith/keryx/blob/53c96b8af161a9aa7550f6d8f7c2ed739baaf110/apps/desktop/src/review/ReviewBoard.tsx). `clearPrivateView` looks for focus inside `.review-workspace [role="dialog"]`; the Review rules and PR watcher dialogs are now portaled to `document.body` and no longer match. On an account or repository change with one of them focused, focus falls to `body`. Use `overlayOpen()` or a marker on the two dialogs.
- **F-003. "Outdated review" hides the reason a card is in Needs attention** — [`apps/desktop/src/review/model.ts`](https://github.com/MrCipherSmith/keryx/blob/53c96b8af161a9aa7550f6d8f7c2ed739baaf110/apps/desktop/src/review/model.ts). `laneReason` returns the outdated text before `attentionReason`, while the lane is still chosen by `attentionReason`. A card with failed checks, changes requested or an unread reply shows only `Outdated review · sha`. Rank the outdated text after the attention reason or show it as a second line.
- **F-004. The requirements package says nothing is implemented** — [`docs/requirements/keryx-desktop-review-v2/README.md`](https://github.com/MrCipherSmith/keryx/blob/53c96b8af161a9aa7550f6d8f7c2ed739baaf110/docs/requirements/keryx-desktop-review-v2/README.md). README, the implementation plan and the roadmap 0.29.38 entry say nothing is implemented although this pull request implements stage 0; PRD R12 and the specification still say team review requests light the tab indicator, which stage 0 deliberately excludes. Mark stage 0 implemented and record the exclusion.
- **F-005. The collapsed toolbar shows two identical icons and drops both counts** — [`apps/desktop/src/review/ReviewBoard.tsx`](https://github.com/MrCipherSmith/keryx/blob/53c96b8af161a9aa7550f6d8f7c2ed739baaf110/apps/desktop/src/review/ReviewBoard.tsx). Below 1100px Filters and Review rules are the same checklist glyph, and the active-filter count and the pull request count disappear with the labels.
- **F-006. The outdated lookup runs for every card and its cost is unmeasured** — [`src/review/desk-run-store.ts`](https://github.com/MrCipherSmith/keryx/blob/53c96b8af161a9aa7550f6d8f7c2ed739baaf110/src/review/desk-run-store.ts). The subquery runs even for cards with an active or current-range run, where its result is discarded, and parses `details` (which embeds the report) about six times per finished run. Bounded by the `(repo, viewer, pr)` index and `LIMIT 1`; no query plan or timing exists.
- **F-007. A lane test asserts nothing** — [`apps/desktop/src/review/model.test.ts`](https://github.com/MrCipherSmith/keryx/blob/53c96b8af161a9aa7550f6d8f7c2ed739baaf110/apps/desktop/src/review/model.test.ts). `expect(reviewLane(outdated("completed"))).toBe(reviewLane(pr))` compares two cards that are both in Needs attention for another reason. Use a neutral card.
- **F-008. The attention set has two writers** — [`apps/desktop/src/review/ReviewBoard.tsx`](https://github.com/MrCipherSmith/keryx/blob/53c96b8af161a9aa7550f6d8f7c2ed739baaf110/apps/desktop/src/review/ReviewBoard.tsx). `attentionPrs` is derived state written by the load callback and by a new effect with the same predicate. Derive it once.

### Questions

- **F-012.** The tab indicator counts every card in the snapshot, the list is filtered. With the filter bypass removed, a card waiting on the viewer can be hidden by a saved filter while the tab shows attention. Accept, or add a "hidden by filters" hint?
- **F-013.** A card with an outdated review offers "Review changes", which starts a new run on the updated head. Is that the wording wanted here and in the detail panel?

### Refuted and narrowed

- **Overflow just above the 1100px breakpoint. Narrowed** — three reviewers predicted overflow when the labels return. Measured without board data at 1150px: about 330px of slack. **Remains:** not measured with board data in the 1101–1300px band.
- **`AS MATERIALIZED` raises the SQLite floor. Narrowed** — the runtime on the review host reports SQLite 3.51.0. **Remains:** the oldest supported macOS and the packaged CLI were not checked.

<details><summary><b>Pre-existing (not blocking)</b></summary>

- **F-011.** Only the two toolbar dialogs are portaled; Filters and PR subscription stay inside `.review-workspace`, whose `container-type` already confines their overlay. Dialogs on one screen dim different areas.
- **F-014.** The set of runs that count for a badge is written twice: `source IN ('manual','scheduled')` in SQL and `source !== "existing"` in TypeScript.

</details>

<details><summary><b>Verified clean</b></summary>

- Security: every value in `attachBadges` is bound; only literal aliases are interpolated; the outdated subquery keeps the repository, viewer and pull request scope; no report text crosses the SQLite boundary.
- Regression: the `localBadge` refactor is behaviour-preserving for inputs that existed before; all consumers of `localReview` handle a card with `outdated` and no `runState`; no card can land in the Done lane while it is hidden.
- The SQL path and the live-history path agree on ordering, visibility and precedence, and two store tests assert it.
- Test notes (info, F-009, F-010): the repository predicate and the state filter of the subquery have no separating fixture; the subquery checks only the reviewed head while the projection needs base and head.

</details>

<details><summary><b>How this review was run</b></summary>

- **Workflow:** `review-orchestrator`; severity per the canonical rubric in the skill.
- **Scope:** `1b994df18..53c96b8af`, round 1, PR #1294. Unchecked commits: none.
- **Models:** sonnet — review-architecture, review-degradation, review-frontend, review-highload, review-layout, review-logic (slices 01, 02), review-performance, review-pr-contract, review-regression, review-testing-practices, review-ui-ux. opus — review-logic (slice 03), review-security-code, review-premise.
- **Tools:** `keryx review plan`, `comments collect`, `context-collect`, `verify-run`, `next`, `ledger build`, `ingest`; `gh` for PR state; a browser on the Vite dev build for measurements.
- **Skills:** review-orchestrator and the eleven reviewer skills of the roster, review-pr-contract, review-premise.
- **Subagents:** 17 reviewer dispatches and one premise judge.
- **Fallback:** every reviewer via `general-purpose` with its `SKILL.md` path, because the host has no agent type per reviewer.
- **Not run:** review-verifier — no reviewer reported a blocker or major; the one major was raised to that severity by the orchestrator after measuring it. Mutation pass — 23 candidates proposed, none executed. Not reviewed: the 58 files of the earlier review package `.metaproject/reviews/2026-11-23-review-flow-feat-desktop-review-v2-stage0/` that this pull request also adds (review artifacts, outside the round's scope of 29 files).
- **Selection:** start question: reviewers — full roster (operator); counterpart verification — default; models — chosen by the orchestrator, `keryx review tier` had no session baseline.
- **Verification:** annotate. No review-verifier pass ran. F-001 rests on the orchestrator's own browser measurement (research-evidence/layout-measurements.md), which is not a verifier claim.
Not verified: 1
- **Stage counts:** pre-filter dropped not recorded. 55 raw findings from 17 dispatches; 14 retained after merging duplicates; 2 narrowed; 2 out of scope.
- **Context:** `.metaproject/flows/516-2026-11-23-desktop-review-v2-stage0/`
- **Follow-up file:** none
- **Reviewed at:** 2026-11-23T09:55Z

</details>

```json keryx:findings
[
 {
  "id": "F-001",
  "reviewer": "review-layout",
  "severity": "major",
  "file": "apps/desktop/src/styles/review.css",
  "quote": ".review-board .flows-toolbar { flex-wrap: nowrap; }",
  "problem": "The board toolbar changed from wrap to nowrap with every child flex:none except the spacer and the search field (min 96px). At a board width of 560px - the default 1180px window minus the 60px rail minus the 560px detail panel - the toolbar content is wider than the toolbar.",
  "impact": "At the default window size with the detail panel open, the right-hand toolbar buttons are pushed past the toolbar edge and under the detail panel; on the base commit the toolbar wrapped to a second row and nothing was clipped. Measured without board data: scrollWidth 567 vs clientWidth 560, Refresh ends 7px past the toolbar. With data the toolbar also holds the Review rules button, so the overflow is larger and starts at a wider board.",
  "suggested_fix": "Below a container width where the collapsed toolbar no longer fits (about 760px) restore flex-wrap: wrap, or let the search field and the watcher status text shrink to zero and hide the watcher status text in the collapsed state. Re-measure at 560, 700 and 820px with board data.",
  "evidence": "research-evidence/layout-measurements.md: viewport 620x800, toolbar clientWidth 560, scrollWidth 567, last child right 627 vs toolbar right 620; 760x800 fits with 24px to spare, without the Review rules button. tauri.conf.json default window 1180, minWidth 720; ReviewDetail default width 560.",
  "confidence": "high",
  "dedupe_key": "toolbar-nowrap-overflow-narrow-board",
  "blocking_merge": true,
  "degradation_class": "behaviour-delta",
  "evidence_kind": "probe",
  "class_scope": {
   "sites": [
    "apps/desktop/src/styles/review.css: `.review-board .flows-toolbar { flex-wrap: nowrap; }` — the Pull requests board toolbar rendered by apps/desktop/src/review/ReviewBoard.tsx (`<div className=\"flows-toolbar\">`)"
   ],
   "enumeration_method": "`keryx ctx rg \"flex-wrap: nowrap|flows-toolbar\" apps/desktop/src`: every `.flows-toolbar` user (FlowsBoard.tsx, IssuesBoard.tsx, MetaprojectView.tsx, ReviewBoard.tsx) and every `flex-wrap: nowrap` rule. Only the review board overrides the shared `.flows-toolbar { flex-wrap: wrap }` of flows.css to nowrap; Flows, Issues and Metaproject keep wrapping. The other nowrap rule, `.sheet-actions.review-detail-actions` in ReviewDetail.css, predates this change and is not a toolbar of the board."
  }
 },
 {
  "id": "F-002",
  "reviewer": "review-frontend",
  "severity": "minor",
  "file": "apps/desktop/src/review/ReviewBoard.tsx",
  "quote": "restoreFocus.current = !!document.activeElement?.closest('.review-workspace [role=\"dialog\"], .review-detail-panel');",
  "problem": "clearPrivateView decides whether to return focus to the search field by testing whether focus is inside `.review-workspace [role=\"dialog\"]`. This change portals the Review rules and PR watcher dialogs to document.body, so focus inside them no longer matches the selector.",
  "impact": "When the board identity changes (account switch, access lost) while one of those two dialogs holds focus, the dialog unmounts and focus falls to body instead of the search field; before the change it was restored. Keyboard and screen-reader users lose their place. No data effect; narrow trigger.",
  "suggested_fix": "Detect the portaled dialogs too: use overlayOpen(), or a marker class on the two dialogs, instead of an ancestor selector under .review-workspace.",
  "evidence": "ReviewBoard.tsx clearPrivateView selector (unchanged line) vs createPortal(..., document.body) in ProjectReviewRules.tsx and ReviewWatcher.tsx. Read, not run. Reported independently by seven reviewers.",
  "confidence": "medium",
  "dedupe_key": "restore-focus-selector-portaled-dialogs",
  "blocking_merge": false,
  "degradation_class": "behaviour-delta",
  "evidence_kind": "base-diff"
 },
 {
  "id": "F-003",
  "reviewer": "review-ui-ux",
  "severity": "minor",
  "file": "apps/desktop/src/review/model.ts",
  "quote": "const outdated = c.localReview?.outdated;",
  "problem": "laneReason returns the outdated-review text before attentionReason, while reviewLane still places the card by attentionReason. An open pull request with an outdated review and a GitHub reason (review requested, changes requested, failed checks, unread reply) sits in Needs attention but shows only \"Outdated review · sha\".",
  "impact": "The card and the list Reason column no longer say why the card is in Needs attention; \"New reply to you\" has no other cue on the card. The ordering was chosen by the implementing worker (journal, T7), not by the operator.",
  "suggested_fix": "Rank the outdated text after attentionReason, or show it as a secondary line or badge beside the lane reason.",
  "evidence": "model.ts laneReason order vs reviewLane; journal.md \"T7 decision: the outdated reason ranks ... before every GitHub-derived reason\". Not seen on a render.",
  "confidence": "high",
  "dedupe_key": "lane-reason-outdated-masks-attention",
  "blocking_merge": false,
  "degradation_class": "behaviour-delta",
  "evidence_kind": "consumer-trace"
 },
 {
  "id": "F-004",
  "reviewer": "review-logic",
  "severity": "minor",
  "file": "docs/requirements/keryx-desktop-review-v2/README.md",
  "quote": "Ничего из этого пакета не реализовано.",
  "problem": "README, implementation-plan and the roadmap 0.29.38 entry state that nothing in the package is implemented, while this pull request implements stage 0 of that plan. PRD R12, the specification indicator section and acceptance criterion 16 say the tab indicator lights for a request to the user or their team, while stage 0 deliberately matches the login only.",
  "impact": "After merge a reader of the requirements package is told the board still has the bypass, the sort and the empty Done lane, and nothing records that stage 0 drops team requests on purpose.",
  "suggested_fix": "Mark stage 0 as implemented in README, implementation-plan and the roadmap entry, and record the team-request exclusion as a stage 0 deviation in the plan.",
  "evidence": "slice-02: README.md line 4, roadmap changelog 0.29.38, prd.md R12, specification.md indicator section and criterion 16 vs model.ts needsViewerAttention and the DOM test expecting null for org/team.",
  "confidence": "high",
  "dedupe_key": "docs-stage0-status-team-indicator",
  "blocking_merge": false
 },
 {
  "id": "F-005",
  "reviewer": "review-ui-ux",
  "severity": "minor",
  "file": "apps/desktop/src/review/ReviewBoard.tsx",
  "quote": "<Icon name=\"checklist\" size={14} /> <span className=\"toolbar-label\">Filters",
  "problem": "Below a toolbar width of 1100px the labels and the count label are hidden. Filters and Review rules both use the checklist icon, so they become identical glyphs, and the active-filter count and the pull request count disappear with the labels.",
  "impact": "With the detail panel open in a 1440px window (toolbar about 820px) the user cannot tell the two buttons apart without hovering and loses both counts. Accessible names stay correct.",
  "suggested_fix": "Give Review rules a distinct icon, keep the filter count as a badge on the icon, and keep the pull request count outside the collapsing set.",
  "evidence": "ReviewBoard.tsx and ProjectReviewRules.tsx both render Icon name=\"checklist\"; review.css container query hides .toolbar-label and .count-label. Not measured with board data.",
  "confidence": "high",
  "dedupe_key": "collapsed-toolbar-identical-icons-counts",
  "blocking_merge": false
 },
 {
  "id": "F-006",
  "reviewer": "review-performance",
  "severity": "minor",
  "file": "src/review/desk-run-store.ts",
  "quote": "WITH wanted AS MATERIALIZED (",
  "problem": "The outdated lookup runs for every requested card, including cards that already have an active or current-range run, where localBadge discards its result. For each finished run of the pull request it evaluates json_extract on `details` about six times, and `details` embeds the review report. No query plan or timing was produced for the new statement.",
  "impact": "attachBadges runs on every board load and refresh in chunks of 200 cards. The added cost is a multiple of the previous per-row parse cost, proportional to cards x finished runs per pull request x report size; whether it is noticeable on a large store is unmeasured.",
  "suggested_fix": "Measure EXPLAIN QUERY PLAN and wall time on a store with a few hundred pull requests and large reports. If it matters, read the JSON fields once per row and skip the lookup for pull requests that have an active run.",
  "evidence": "slice-03 desk-run-store.ts attachBadges hunk; board-badges.ts drops the result when latest or ready; index review_history(repo, viewer, pr) bounds the scan to one pull request. Not executed. Runtime SQLite is 3.51.0 on this host (research-evidence/verify-sqlite-version-1.txt), so MATERIALIZED is supported here.",
  "confidence": "medium",
  "dedupe_key": "outdated-subquery-per-card-cost",
  "blocking_merge": false,
  "degradation_class": "performance"
 },
 {
  "id": "F-007",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "file": "apps/desktop/src/review/model.test.ts",
  "quote": "expect(reviewLane(outdated(\"completed\"))).toBe(reviewLane(pr))",
  "problem": "The assertion that an outdated badge does not change the lane compares against `pr`, which is CHANGES_REQUESTED with a requested reviewer, so both sides are \"attention\" whatever the outdated branch does.",
  "impact": "A change that sends outdated cards to Needs attention would keep the suite green, although the plan says lanes are out of scope for this stage.",
  "suggested_fix": "Use a neutral card (no decision, no reviewers, CI passed) whose lane is \"open\".",
  "evidence": "slice-02 model.test.ts; read, no mutation run.",
  "confidence": "medium",
  "dedupe_key": "vacuous-lane-assertion",
  "blocking_merge": false
 },
 {
  "id": "F-008",
  "reviewer": "review-architecture",
  "severity": "minor",
  "file": "apps/desktop/src/review/ReviewBoard.tsx",
  "quote": "if (needsViewerAttention(c, snapshot.viewer, unreadCount(snapshot, c))) next.add(c.number);",
  "problem": "attentionPrs is derivable from the snapshot and the read receipts but is stored as state and written from two places with the same predicate (the load callback and the new effect), plus a render-time ref write.",
  "impact": "Two writers must be kept in step by hand; changing the predicate or the replace rule in one place reintroduces the indicator flicker fixed in this branch. Maintainability only.",
  "suggested_fix": "Derive the set once with useMemo over the snapshot and the receipt version, keeping only the cross-scope retention as state.",
  "evidence": "Two needsViewerAttention call sites in ReviewBoard.tsx.",
  "confidence": "medium",
  "dedupe_key": "attention-derived-state-two-writers",
  "blocking_merge": false
 },
 {
  "id": "F-009",
  "reviewer": "review-testing-practices",
  "severity": "info",
  "file": "src/review/desk-run-store.ts",
  "quote": "WHERE o.repo=?2 AND o.viewer=?3 AND o.pr=w.n AND o.state IN ('completed','partial','budget')",
  "problem": "Test gaps, from reading only: no fixture separates the o.repo predicate or the state filter of the outdated subquery; the viewer-side lowercase in needsViewerAttention, the order of the outdated and partial labels, the hidden merged pull request under the default filter and the reload in the reply carry-over test are not pinned either.",
  "impact": "Dropping one of those predicates would keep the suite green. Predictions, not mutation results: the mutation pass did not run.",
  "suggested_fix": "Add a newer finished run in another repository and a newer failed run with a recorded result to the store decoys; add the listed model and DOM cases; run the proposed mutants.",
  "evidence": "review-testing-practices w1 F-002..F-005 and w2 F-001, F-002 with 23 mutant candidates; none executed.",
  "confidence": "medium",
  "dedupe_key": "test-gaps-unpinned-predicates",
  "blocking_merge": false
 },
 {
  "id": "F-010",
  "reviewer": "review-logic",
  "severity": "info",
  "file": "src/review/desk-run-store.ts",
  "quote": "AND json_extract(o.details,'$.result.reviewed.headSha') IS NOT NULL",
  "problem": "The outdated-candidate subquery requires only a reviewed head, while the row projection keeps a result only when both base and head are present. A run with a reviewed head and no base would be selected and then dropped, so the SQL path and the live-history path could disagree.",
  "impact": "Parity break with no known trigger: no producer writes a reviewed range without a base.",
  "suggested_fix": "Also require a non-null reviewed base in the subquery.",
  "evidence": "desk-run-store.ts subquery predicate vs the row mapping in the same method.",
  "confidence": "medium",
  "dedupe_key": "outdated-subquery-head-only-predicate",
  "blocking_merge": false
 },
 {
  "id": "F-011",
  "reviewer": "review-layout",
  "severity": "info",
  "file": "apps/desktop/src/review/ReviewWatcher.tsx",
  "quote": "</Dialog>, document.body)}",
  "problem": "Only the Review rules and PR watcher dialogs are portaled to the body. The Filters and PR subscription dialogs stay inside .review-workspace, which already has container-type: inline-size, so their fixed overlay is confined to the workspace.",
  "impact": "Dialogs opened from the same screen dim different areas. The confinement of the non-portaled dialogs predates this change and was not measured.",
  "suggested_fix": "Portal all board dialogs alike, or record why only these two need it.",
  "evidence": "ReviewDetail.css line 1; ReviewBoard.tsx renders ReviewFilters and PrSubscriptionDialog inside .review-workspace. Measured only for the watcher dialog.",
  "confidence": "medium",
  "dedupe_key": "dialog-portal-inconsistent",
  "blocking_merge": false,
  "location_class": "pre-existing"
 },
 {
  "id": "F-012",
  "reviewer": "review-degradation",
  "severity": "info",
  "file": "apps/desktop/src/review/ReviewBoard.tsx",
  "quote": "if (needsViewerAttention(c, snapshot.viewer, unreadCount(snapshot, c))) next.add(c.number);",
  "problem": "The tab indicator is computed over all snapshot cards while the list is filtered. With the active-review filter bypass removed, a card awaiting the viewer can be hidden by a saved filter while the tab shows attention.",
  "impact": "The indicator may point at a card the board does not show. It follows from the operator decision to remove the bypass.",
  "suggested_fix": "Accept and document, or show a \"N hidden by filters need you\" hint.",
  "evidence": "attentionPrs is fed from snapshot.cards; visible applies filterReviews afterwards.",
  "confidence": "medium",
  "dedupe_key": "indicator-points-at-filtered-card",
  "blocking_merge": false,
  "degradation_class": "behaviour-delta",
  "evidence_kind": "consumer-trace"
 },
 {
  "id": "F-013",
  "reviewer": "review-ui-ux",
  "severity": "info",
  "file": "apps/desktop/src/review/ReviewResults.tsx",
  "quote": "card.localReview?.outdated ? \"Review changes\" : \"Run review\";",
  "problem": "The action label \"Review changes\" on a card with an outdated review does not say that it starts a new run on the updated head.",
  "impact": "Wording ambiguity; the detail panel uses the same label for the same case.",
  "suggested_fix": "Decide on one wording for both places, for example \"Re-run review\".",
  "evidence": "ReviewAction label chain in the diff; ReviewRuns.tsx launchAction returns \"Review changes\".",
  "confidence": "medium",
  "dedupe_key": "outdated-action-label",
  "blocking_merge": false
 },
 {
  "id": "F-014",
  "reviewer": "review-architecture",
  "severity": "info",
  "file": "src/review/desk-run-store.ts",
  "quote": "json_extract(${r}.details,'$.source') IN ('manual','scheduled')",
  "problem": "The set of runs that count for a badge is expressed twice: in SQL as source IN (manual, scheduled) and in TypeScript as source !== \"existing\". They agree for the three current values.",
  "impact": "A new source value would make the SQL path and localBadge disagree.",
  "suggested_fix": "Share one predicate or add a guard test over the source union.",
  "evidence": "board-badges.ts localBadge filter; desk-run-store.ts visible(); desk-run-types.ts source union.",
  "confidence": "high",
  "dedupe_key": "visible-source-duplication",
  "blocking_merge": false,
  "location_class": "pre-existing"
 }
]
```

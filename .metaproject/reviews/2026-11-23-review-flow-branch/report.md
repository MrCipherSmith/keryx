**Changes requested — 1 Major, 17 Minor; 4 more findings wait for the operator's answer.** No crash, data loss, vulnerability or unimplemented acceptance criterion was found; the one defect that reaches a user is the Filters popover running off a 720×480 window, and the larger debt is test strength: 67 of 82 proposed mutants survive.
Reviewed `60cbe1c565f4` against `1358d962f4df` (merge-base with `origin/main`) · round 1 · 64 files, +8253/−715 · CI not consulted (the target is a branch, not a pull request).
Evidence level: ran — `bun test` on the impacted test files (one process per file: 140 pass, 2 fail, both failing the same way on the base checkout), `keryx review mutate` over 82 mutants with six test files per mutant (15 killed, 67 survived), the six test files of the change against the base's production files (all red), and `getBoundingClientRect` measurements of the Filters popover in Chromium 156 and in the system WKWebView. Did not run: the native Tauri window (no Rust toolchain on this machine), WebKit older than macOS 26.

This verdict is interim until the operator closes the round: four held findings need an answer, and nothing is fixed yet.

### Major

**F-001. The Filters popover runs past the window at 720×480 when the freshness Details are open, and cannot scroll.** `apps/desktop/src/metaproject/metaproject.css`, in the diff · raised by review-layout · verifier: confirmed (execution), premise: upheld.
Filters popover is clipped by 51 px at the 720x480 minimum window when the stale banner is expanded, and cannot scroll. The popover is a fixed-position .menu whose top is computed once as anchor.bottom + 4 (MetaprojectView.tsx FiltersPopover: `setPosition({ left, top: rect.bottom + 4 })`). The only height limit is the shared .menu max-block-size of 400px, a fixed number, not a function of the room below the anchor. The rule above adds no max-block-size or overflow clamp tied to the window, so when the anchor sits low the popover runs past the window edge. Its content (229 px) is below 400 px, so it never becomes scrollable either and the last row is unreachable.
Check: research-evidence/verify-F-001-3.txt (system WKWebView, AppleWebKit 605.1.15, 720x480, Details expanded): popover layoutBox bottom 497, cutBottomBy 17, scrolls false, maxHeight 400px. research-evidence/live-filters-popover-720x480.txt (Chromium 156, same state): bottom 531, cut by 51, no scroll. verify-F-001-2.txt (WKWebView, one-line banner): cutBottomBy -59, fits. Clip and no-scroll reproduce in both engines; the 51 px figure is Chromium-only, WebKit clips 17 px. Window minimum confirmed by rg of apps/desktop/src-tauri/tauri.conf.json (minWidth 720, minHeight 480).
Fix: Bound the popover by the room below its anchor: compute `maxHeight = window.innerHeight - top - 8` next to `top` in FiltersPopover and set `max-block-size: min(400px, that)` with `overflow-y: auto`; or flip it above the anchor when there is more room there. Re-measure at 720x480 with Details expanded: popover bottom at or below 472 and scrollHeight greater than clientHeight.

**F-002. A size container on the explorer root could trap the fixed Filters popover and draw it away from its button.** `apps/desktop/src/metaproject/metaproject.css`, in the diff · raised by review-frontend · verifier: refuted (execution), premise: challenged. **Held — see “Waiting for the operator”.**
The explorer root `<section className="flows metaproject">` becomes a size container. container-type inline-size applies layout containment, and an element with layout containment is the containing block of its `position: fixed` descendants. The Filters popover (`FiltersPopover` in MetaprojectView.tsx, rendered inside that section, class `menu`, which `styles.css` sets to `position: fixed`) is placed with viewport coordinates from `anchor.getBoundingClientRect()` (`left`, `top: rect.bottom + 4`).
Check: research-evidence/verify-F-002-2.txt (system WKWebView, AppleWebKit 605.1.15, 1024x768, section origin (60,77)): popover rect left 591.8 top 241.9, layoutBox left 587 top 239 equals its inline coordinates, displacementFromInline x 0 y 0. research-evidence/live-filters-popover-containing-block.txt (Chromium 156): popover rect 587,239 equals inline, offset 0,0. The container is present (verify-F-002-1.txt: metaproject.css:9 container: metaproject / inline-size), so the sites exist and the displacement the finding claims does not occur in these two engines.
Fix: Render the popover through a portal to document.body (the other `.menu` users are not inside a size container), or move the container off the ancestor of the popover (for example put `container-type` on `.metaproject-panes`, and leave the header, banner and popover outside it), or compute the position relative to `root.current.getBoundingClientRect()`. Add a DOM-free check or a live probe at 1180x780 with the popover open that compares popover.left to anchor.right - 320.

### Minor

- **F-003. An open Filters popover keeps the app-wide Escape layer while the retained explorer is hidden.** `apps/desktop/src/metaproject/MetaprojectView.tsx`, in the diff · review-degradation · verifier: unverifiable (site-check), premise: upheld. While that hidden popover is registered: the first Escape in the other view is consumed by it (preventDefault, then focuses a hidden anchor), so Escape does not reach the visible view; Fix: Close the popover when its view is hidden: pass the RetainedView `visible` flag into MetaprojectView and call setFiltersOpen(false) on becoming hidden, or mount FiltersPopover only while visible.
- **F-004. The retained explorer does not re-read the catalog when its view is shown again.** `apps/desktop/src/App.tsx`, in the diff · review-degradation · verifier: unverifiable (site-check), premise: owner-decision. **Held.** User opens Metaproject, goes to a session where the agent (or the user) rebuilds the graph or changes the repo, and returns: the list, counts and freshness banner still show the old snapshot, including a stale 'Graph is stale' banner after … Fix: Give the retained explorer a refresh trigger on becoming visible again (pass `visible` through and bump `revision` on a hidden-to-visible transition when the catalog was loaded earlier than a threshold, or re-read the catalog silently and …
- **F-005. Two quick Wiki-link lookups are settled by arrival order, not click order.** `apps/desktop/src/metaproject/MetaprojectView.tsx`, in the diff · review-highload · verifier: unverifiable (site-check), premise: upheld. Trigger: click an unloaded wiki link A, then another unloaded link B on the same page before A's `search` read resolves. Both reads pass `current()` because the selection has not changed; Fix: Keep a lookup counter in a ref, increment it in openPath, and have `current()` also require `token === lookup.current` (the pattern `latestSearch.current.generation` already uses nearby).
- **F-006. Every explorer render walks the whole catalog to fill `seenNodes`.** `apps/desktop/src/metaproject/MetaprojectView.tsx`, in the diff · review-performance · verifier: unverifiable (site-check), premise: upheld. not stated by the reviewer Fix: Populate seenNodes in the useMemo that builds `nodes`, or in an effect keyed on `nodes`.
- **F-007. The Relationships tab count includes second-step rows; the fact row above it does not.** `apps/desktop/src/metaproject/NodeDetailsPanel.tsx`, in the diff · review-ui-ux · verifier: confirmed (site-check), premise: owner-decision. **Held.** Two adjacent numbers for the same word disagree, so the user cannot tell whether the tab includes extra rows. The 'Second step' group sits inside a collapsed <details>, so the extra rows are not visible until opened. Fix: Either show the tab count as incoming + outgoing only (matching the fact row and caption) or add the second-step count to the fact row (for example '5 incoming · 4 outgoing · 3 second-step').
- **F-008. Back to an earlier OpenSpec document lands at its top.** `apps/desktop/src/metaproject/OpenSpecView.tsx`, in the diff · review-logic · verifier: unverifiable (site-check), premise: challenged. **Held.** Back to a previous OpenSpec entry returns to the top of its document, not where the reader was. This is a silent wrong restore, not data loss, and AC11 covers only Graph selections. Fix: In choose(), do not reset scrollTop before onLocation; let navigate(..., { resetContent: true }) seed the new entry at 0 (the hook already supports it), or record the offsets before zeroing. Or record the item as accepted in the journal.
- **F-009. `tasks.md` stops at T11 and keeps the first dependencies; `flow.json` has T12–T16.** `.metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/tasks.md`, in the diff · review-logic · verifier: confirmed (site-check), premise: upheld. A reader of tasks.md alone gets the wrong order and misses five tasks; no gate input is wrong. Fix: Add the rows T12-T16 and correct the dependencies to match flow.json, or label tasks.md as the initial plan with flow.json as the source of truth.
- **F-010. The T9 and T15 dispatches name a resolved-context file and a result file that never existed.** `.metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/dispatch/T9.dispatch.json`, in the diff · review-logic · verifier: confirmed (site-check), premise: upheld. A gate input that says a file exists when it does not, and a done task with no result artifact, mean a later reader or the review-flow gate cannot check T9 and T15 against the contract the dispatch states; Fix: Either record in flow.json dispositionReason for T9 and T15 that the docs workers returned inline and no result artifact exists, or remove the stale context_refs entry and output_contract from T9.dispatch.json.
- **F-011. The RetainedView test passes one value for both props, so `hidden={!visible}` can become `hidden={!active}` unnoticed.** `apps/desktop/src/App.dom.test.tsx`, in the diff · review-testing-practices · verifier: confirmed (execution), premise: upheld. The explorer could show over Settings with the suite green. Fix: Render with active true and visible false and assert the wrapper is hidden and the input is kept.
- **F-012. The zero-size-container test asserts only an unchanged zoom; the fit and zoom paths never run.** `apps/desktop/src/metaproject/RelationshipGraph.dom.test.tsx`, in the diff · review-testing-practices · verifier: confirmed (execution), premise: upheld. A falsy-state test with no positive artifact: it passes when fit does nothing. Fix: Stub clientWidth/clientHeight on the viewport, assert zoom and pan after Fit and clamped zoom after repeated Zoom in.
- **F-013. `data-palette`, the colour-scheme listener, hover styling and other graph gates are unpinned.** `apps/desktop/src/metaproject/RelationshipGraph.tsx`, in the diff · review-testing-practices · verifier: confirmed (execution), premise: upheld. One trigger of a stated acceptance criterion and the hover behaviour are unprotected. Fix: Flip data-palette in the theme test; emit mouseover/mouseout and check classes; check second-step class and root border-width with styleEnabled.
- **F-014. No test restores a scroll position; all five mutants of the navigation hook survive.** `apps/desktop/src/metaproject/useExplorerNavigation.ts`, in the diff · review-testing-practices · verifier: confirmed (execution), premise: upheld. The Back scroll restore fixed in T8 can regress unseen. Fix: DOM test that scrolls the details body, selects another node, presses Back and asserts scrollTop; one for the 40-entry cap.
- **F-015. The AC13 test never varies Direction and runs protocol 1 only.** `apps/desktop/src/metaproject/MetaprojectView.tsx`, in the diff · review-testing-practices · verifier: confirmed (execution), premise: upheld. AC13 has one of three parts with no separating fixture. Fix: Set Direction to incoming before switching to Wiki; add a protocol-2 run asserting the V2 kinds.
- **F-016. The “+N more” wiring (open the panel, reveal Relationships) is driven by no test.** `apps/desktop/src/metaproject/MetaprojectView.tsx`, in the diff · review-testing-practices · verifier: confirmed (execution), premise: upheld. Removing either half leaves all suites green and breaks the way to hidden neighbours. Fix: MetaprojectView test with headless cytoscape: close the panel, tap the overflow node, assert panel open on Relationships.
- **F-017. Ten gates T8 added to the explorer survive deletion.** `apps/desktop/src/metaproject/MetaprojectView.tsx`, in the diff · review-testing-practices · verifier: confirmed (execution), premise: upheld. Each gate was added in this change and its next edit is unprotected. Fix: One test per gate with the existing fixtures (Wiki-mode header, failed second read, mousedown on the Filters button).
- **F-018. The AC16 guards and the settled AC12 “No Wiki page matches” state are unpinned.** `apps/desktop/src/metaproject/MetaprojectView.tsx`, in the diff · review-testing-practices · verifier: confirmed (execution), premise: upheld. The settled half of AC12 and three AC16 sub-claims have no failing test. Fix: Run the debounce and assert the final title; add a malformed %E0%A4%A link and a late-resolving lookup.
- **F-019. Fifteen behaviours of the details panel have no fixture.** `apps/desktop/src/metaproject/NodeDetailsPanel.tsx`, in the diff · review-testing-practices · verifier: confirmed (execution), premise: upheld. Next edit to any of these is unprotected. Fix: Fixtures: a leading-list page with a fenced block, a 400-char paragraph, a second node after a tab choice, ArrowRight/Home/End on the tab list.
- **F-020. The relationship-list fixtures have no dangling edge, no two-line evidence, no self-loop.** `apps/desktop/src/metaproject/RelationshipList.tsx`, in the diff · review-testing-practices · verifier: confirmed (execution), premise: upheld. The dangling-edge gate protects against a render crash on truncated projections and is unprotected. Fix: Add one projection with a dangling edge, one edge with two evidence lines, one second-step self-loop.
- **F-021. Twelve layout mutants survive, the AC3 drawn-anchor preference among them.** `apps/desktop/src/metaproject/graphLayout.ts`, in the diff · review-testing-practices · verifier: confirmed (execution), premise: upheld. Layout rules that keep truncated projections overlap-free are unprotected. Fix: Fixtures: root self-loop, second-step node reachable only via another second-step node, edge count 16, a fitting layout with a pan assertion.
- **F-022. A self-loop is counted as outgoing in the panel and skipped in the graph caption.** `apps/desktop/src/metaproject/RelationshipList.tsx`, in the diff · review-logic · verifier: confirmed (site-check), premise: upheld. For a node with a self-edge (for example a wiki page whose `links` edge points at itself) the graph caption reads '0 incoming · 0 outgoing' while the panel fact reads '0 incoming · 1 outgoing', and the Relationships tab lists the node as … Fix: Pick one rule for both: skip self-loops in groupRelationships (the row does nothing useful), or count them in layoutNeighborhood. Skipping them in groupRelationships keeps the two counts equal.

### Waiting for the operator

The premise judge held these: each is neither fixable nor clean until the operator answers `uphold` or `dismiss`.

- **F-002 (major, challenged).** The containing-block shift does not happen in current Chromium or current WKWebView, and the CSS spec gives inline-size containers no layout containment. Dismiss it, or keep it open until older macOS WebKit is checked? Options: dismiss — the container does not trap the fixed popover; no change / uphold — keep it open and check on the oldest supported macOS WebKit (or portal the popover as a precaution).
- **F-004 (minor, owner-decision).** The retained explorer shows the catalog it last read when you come back. Keep that (and say so in the guide), or re-read the catalog when the view becomes visible again? Options: dismiss — keep the retained snapshot; the snapshot-mismatch banner and Refresh catch up; note it in the guide / uphold — re-read the catalog silently when the explorer becomes visible, keeping the selection.
- **F-007 (minor, owner-decision).** The Relationships tab counts every row it lists (second-step included); the fact row counts only incoming and outgoing. Keep the tab count as is, or align the two? Options: dismiss — the tab counts its rows, like the Wiki and OpenSpec tabs / uphold — count only incoming + outgoing on the tab / uphold — add the second-step count to the fact row.
- **F-008 (minor, challenged).** You declined fixing OpenSpec Back-to-top at the first-green gate. Keep it out of this flow, or fix it now? Options: dismiss — stays out of scope as decided at the first-green gate / uphold — fix choose() in this flow.

### Refuted and narrowed

`verification_mode` is `annotate`: a refuted finding stays in the record, marked.

- **F-002. Refuted by the verifier (execution)** — claimed: A size container on the explorer root could trap the fixed Filters popover and draw it away from its button. Evidence: research-evidence/verify-F-002-2.txt (system WKWebView, AppleWebKit 605.1.15, 1024x768, section origin (60,77)): popover rect left 591.8 top 241.9, layoutBox left 587 top 239 equals its inline coordinates, displacementFromInline x 0 y 0. research-evidence/live-filters-popover-containing-block.txt (Chromium 156): popover rect 587,239 equals inline, offset 0,0. **Remains:** WebKit of older macOS versions was not measured (`tauri.conf.json` sets the minimum system version to 12.0). The premise judge adds that the current `container-type` definition applies no layout containment, and holds the finding for the operator.
- **F-029. Refuted by the verifier (site-check)** — claimed: The graph screenshot's alt text counts twelve importing files on the left; ten are drawn, plus “+2 more”. Evidence: keryx ctx rg 'twelve importing files' docs/docs/guides: desktop-metaproject.md:107 holds the alt text. Read of docs/docs/images/desktop-metaproject/graph.jpg: left column shows 10 import nodes, a '+2 more' entry, the caption 'Imports · 12', one Describes and one Contains node. The 12 imports are 10 drawn plus 2 collapsed, so the picture does not contradict the alt text's count. **Remains:** nothing: the picture draws ten of the twelve importing files and a “+2 more” entry, which the alt text counts together.

<details><summary><b>Info (kept in the record, not published as findings)</b></summary>

- **F-023. The G8 test pins stylesheet source text (`min-block-size: 200px;`).** `apps/desktop/src/metaproject/RelationshipGraph.dom.test.tsx`, in the diff · review-frontend · verifier: confirmed (site-check).
- **F-024. The red checks of T14 and T16 swapped tracked files in the shared worktree under a live dev server.** `.metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/results/T16.result.json`, in the diff · review-highload · verifier: confirmed (site-check).
- **F-025. `RetainedView` is exported from `App.tsx` only so its test can import it.** `apps/desktop/src/App.tsx`, in the diff · review-architecture · verifier: confirmed (site-check).
- **F-026. `isOpenSpecNode` is exported and has no importer.** `apps/desktop/src/metaproject/NodeDetailsPanel.tsx`, in the diff · review-architecture · verifier: confirmed (site-check).
- **F-027. `back` reads a ref that is refreshed only on render.** `apps/desktop/src/metaproject/useExplorerNavigation.ts`, in the diff · review-frontend · verifier: unverifiable (site-check).
- **F-028. A container rule for a docked panel on a narrow host looks unreachable (not measured).** `apps/desktop/src/metaproject/metaproject.css`, in the diff · review-layout · verifier: unverifiable (site-check).
- **F-029. The graph screenshot's alt text counts twelve importing files on the left; ten are drawn, plus “+2 more”.** `docs/docs/guides/desktop-metaproject.md`, in the diff · review-logic · verifier: refuted (site-check).

</details>

<details><summary><b>Pre-existing (not blocking)</b></summary>

- `apps/desktop/src/panels/SideTabs.dom.test.tsx` fails two tests when the file runs in its own `bun test` process (“Export named 'browserFrame' not found in module …/platform/panels.ts”). The same two fail the same way on the base checkout at `1b994df18`; the diff touches neither file, and the whole suite passes when run together. Disposition: recommended issue (test isolation), outside the contract this change touches.
- `keryx review mutate` copies the worktree without `apps/desktop/node_modules`, so a plain desktop test command fails its baseline there; this round's command links the directory itself. Disposition: recommended issue against the tool.
- `keryx review tier` resolved every tier to the session model (`tier_resolution: session-fallback`, “no discovered provider matches the session provider”). Disposition: recommended issue against the tool; the models actually used are listed under “How this review was run”.

</details>

<details><summary><b>Verified clean</b></summary>

Each line is a hypothesis that was tested and did not hold, with what it rests on.

- The size container traps the fixed popover: displacement (0, 0) in Chromium 156 and in WKWebView on macOS 26.7.3 (`research-evidence/live-filters-popover-containing-block.txt`, `verify-F-002-2.txt`).
- The popover is drawn under the graph canvas: `elementFromPoint` at four points inside it returns popover elements once the `pop-in` animation has finished (`research-evidence/live-filters-popover-720x480.txt`).
- Removed exports still have importers: `keryx ctx rg "GraphNodePanel|isOpenSpecNode|RelationshipList" apps/desktop/src src docs` finds only files of the change (review-regression, wave 2).
- Removed CSS classes still have consumers: none under `apps/desktop/src`; the one remaining `.metaproject-controls` user is `OpenSpecView.tsx:293`, a button group (review-degradation wave 2, review-regression wave 3, review-architecture wave 4).
- New text reaches an HTML sink: the only `dangerouslySetInnerHTML` is unchanged and sanitised (`Markdown.tsx:39`); Wiki link resolution reads no file and clamps `..` at the repository root (review-security-code, wave 2).
- The retained, hidden explorer leaks listeners or a second cytoscape instance: the graph component releases its observers, media listener and instance in effect cleanups, and `fit` skips a zero-size container (review-performance wave 1, review-highload wave 2).
- The Back history grows without bound or loses the cap: `slice(1 - 40)` equals the base's `slice(-39)` (review-degradation wave 2, review-highload wave 3).
- The new tests would pass without the change: all six test files are red against the base's production files (`research-evidence/verify-red-on-parent-1.txt`).
- An acceptance criterion is unimplemented: review-logic checked AC4 and AC6–AC18 against slice 05 and AC1–AC4, AC11 and AC21 against slice 06; none is missing. AC5, AC6, AC10 and AC20 are judged live and rest on the orchestrator's measurements in the flow journal.

</details>

<details><summary><b>How this review was run</b></summary>

**Workflow:** `review-orchestrator`, managed round 1 of 5 for flow 515, mode `review-flow`, attended. `keryx review plan` built the package; 31 reviewer dispatches (11 reviewers over 6 slices), two verifier passes, one premise pass; `keryx review next` drove the waves until it printed `done`.

**Scope:** diff `origin/main...HEAD` at the merge-base: 64 files seen, 62 retained in six slices, 2 dropped as binary (the guide screenshots `docs/docs/images/desktop-metaproject/graph.jpg` and `wiki.jpg`). Slices 01–03 are the flow package itself.

**Models:** model strategy by tier, the operator's start answer (“По тирам”). Dispatched on the host aliases, whose exact model ids the host did not report: `sonnet` for ten reviewers (standard tier), `opus` for review-regression (deep tier), `haiku` for the verifier (light tier); the premise judge ran on `opus` and names itself `claude-opus-5-5`. The orchestrator session is `claude-fable-5-2`.

**Tools:** reviewers read-only (`allowed_tools: read-only`, `exec_budget_s: 0`), except review-testing-practices (`run-tests`, 300 s), which ran its mutants in its own scratch copy after `keryx review mutate` failed its baseline there. The orchestrator ran `keryx review verify-run`, `keryx review mutate`, the browser pane (Chromium 156) and a WKWebView probe script.

**Skills:** review-architecture, review-degradation, review-frontend, review-highload, review-layout, review-logic, review-performance, review-regression, review-security-code, review-testing-practices, review-ui-ux, review-verifier, review-premise.

**Subagents:** 31 reviewer runs, one resumed once to return its result in the schema's shape (review-layout wave 1); 2 verifier runs; 1 premise run.

**Not run:**
- The two guide screenshots were in no slice. review-logic opened `graph.jpg` for one finding; `wiki.jpg` was not reviewed.
- The native Tauri window: no Rust toolchain on this machine. The frontend was measured in the system WKWebView instead; the Rust shell was not exercised.
- WebKit older than the one of macOS 26.7.3; the light theme and the 1180×780 and 1440×900 windows with the Filters popover open.
- Blast radius: 40 of 75 candidate files were checked (`blast_radius_max_files=40`); 46 changed files (flow package, CSS, docs, images) are absent from the code graph, so their radius is unknown, not empty. Reviewers enumerated consumers of the CSS and the hook by search instead.
- The layout and UI/UX reviewers measured nothing themselves; their geometry claims rest on the orchestrator's measurements.
- Token spend: no dispatch reported usage.
- Memory: one search before `review plan`; two of its entries were captured.

**Verification:** `verification_mode: annotate`. Pass 1 covered the two majors by site check; pass 2 covered all 29 findings: 20 confirmed (12 by execution, 8 by site check), 2 refuted (1 by execution, 1 by site check), 7 unverifiable. Premise: 18 upheld, 2 challenged, 2 owner-decision, 0 downgraded.

**Stage counts:**

- pre-filter: files seen 64, retained 62, dropped 2 (binary: the two guide screenshots); blocks 175 of 175 retained; changed lines retained 8968, dropped 0.
- verifier (`verification_mode: annotate`): claims received 29, applied 29, rejected 0, capped to unverifiable 0; confirmed 20, refuted 2, unverifiable 7, unverified 0.
- retained: findings in 29, removed by the verifier 0, retained 29. `annotate` records verdicts and removes nothing: 2 findings are marked refuted and still reported.
- findings cap: limit 10 per reviewer, truncated 0.
- scope B: accepted 0, rejected 0, exempted 0.
- degradation evidence screen: screened 2, downgraded 0.
- premise: 18 upheld, 0 downgraded, 4 held (2 challenged, 2 owner-decision).
- blast-radius chunk passes: 2 of 15 chunks run (chunk-001, nine files; chunk-014, three files), no finding; 13 chunks not run — twelve generated `layers/graph/storage/calls.jsonl` files of earlier review packages (about 44 MB each, linked by text match) and `src/gdskills/bundled/stacks/php-laravel/governance/eval.json`. `keryx review chunks estimate` puts the whole run at about 133 million input tokens; the operator decides whether those thirteen are read or waived.

## Review parity

- **Not verified:** Run the mutant_candidates list through `keryx review mutate` once its scratch copy resolves apps/desktop/node_modules (its baseline failed here with 'Cannot find module @happy-dom/global-registrator') (review-testing-practices-w1:fu1, narrowed, remains: `keryx review mutate` does not link apps/desktop/node_modules into its scratch copy by itself; the test command of this pass creates that link. The tool gap is outside this change.)

</details>

```json keryx:findings
[
 {
  "id": "F-001",
  "severity": "major",
  "file": "apps/desktop/src/metaproject/metaproject.css",
  "line": null,
  "quote": ".metaproject-filters-pop { display: grid; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3) var(--sp-3); }",
  "problem": "Filters popover is clipped by 51 px at the 720x480 minimum window when the stale banner is expanded, and cannot scroll. The popover is a fixed-position .menu whose top is computed once as anchor.bottom + 4 (MetaprojectView.tsx FiltersPopover: `setPosition({ left, top: rect.bottom + 4 })`). The only height limit is the shared .menu max-block-size of 400px, a fixed number, not a function of the room below the anchor. The rule above adds no max-block-size or overflow clamp tied to the window, so when the anchor sits low the popover runs past the window edge. Its content (229 px) is below 400 px, so it never becomes scrollable either and the last row is unreachable.",
  "impact": "At the smallest supported window (720x480), a developer with a stale graph who opens Details and then Filters cannot reach the lower relationship-type chips, the symbol-layer reason or Reset filters. A stale graph is the state the flow journal calls the one a developer is in most of the time. Any state that pushes the header down further (a longer reason, a second banner, a larger text scale) moves the cut up. The position is computed once on open, so a resize while it is open is not tracked (unmeasured).",
  "suggested_fix": "Bound the popover by the room below its anchor: compute `maxHeight = window.innerHeight - top - 8` next to `top` in FiltersPopover and set `max-block-size: min(400px, that)` with `overflow-y: auto`; or flip it above the anchor when there is more room there. Re-measure at 720x480 with Details expanded: popover bottom at or below 472 and scrollHeight greater than clientHeight.",
  "evidence": "Orchestrator live probe, browser dev build, 720x480, dark, Graph, 'Agent Bus', depth 1, getBoundingClientRect (research-evidence/live-filters-popover-720x480.txt). One-line banner: button bottom 225, popover top 232 bottom 455, 25 px of room, not cut. Banner with Details expanded (banner 122 px): button bottom 301, popover top 308 bottom 531, window 480, cut by 51 px; scrollHeight equals clientHeight (229), so no scroll; the 'Not available: ...' note and the lower chips are outside the window. Not measured: light theme, 1180x780 and 1440x900 with the popover open, the native Tauri window, window resize while open. Measured by the orchestrator in two engines at 720x480 with the freshness Details expanded: Chromium 156, popover bottom 531 against a 480 px window, cut by 51 px, no scroll (.metaproject/reviews/2026-11-23-review-flow-branch/research-evidence/live-filters-popover-720x480.txt); system WKWebView (AppleWebKit 605.1.15, macOS 26.7.3), layout box bottom 497, cut by 17 px, no scroll (.metaproject/reviews/2026-11-23-review-flow-branch/research-evidence/verify-F-001-3.txt). With the one-line banner it fits in both (.metaproject/reviews/2026-11-23-review-flow-branch/research-evidence/verify-F-001-2.txt). The height cap the reviewer calls max-block-size 400px is `.menu`'s `max-height: min(420px, calc(100vh - 80px))` (styles.css:143), which is 400 px at this window height. Normalisation notes: confidence was not stated by the reviewer and is set at normalisation; the same defect was raised by review-ui-ux (review-ui-ux-w2, UX-001, minor); the same defect was raised by review-ui-ux (review-ui-ux-w1, UX-002, info).",
  "confidence": "high",
  "reviewer": "review-layout",
  "location_class": "in-diff",
  "class_scope": {
   "sites": [
    "apps/desktop/src/metaproject/metaproject.css:.metaproject-filters-pop",
    "apps/desktop/src/metaproject/MetaprojectView.tsx:FiltersPopover (the only user of the class)"
   ],
   "enumeration_method": "keryx ctx rg for `metaproject-filters-pop` under apps/desktop/src/metaproject: one rendering site, the FiltersPopover component (MetaprojectView.tsx:196); the shared .menu in apps/desktop/src/styles.css:142 supplies the 400px cap and is not changed by this diff."
  }
 },
 {
  "id": "F-002",
  "severity": "major",
  "file": "apps/desktop/src/metaproject/metaproject.css",
  "line": null,
  "quote": ".metaproject { container: metaproject / inline-size; }",
  "problem": "The explorer root `<section className=\"flows metaproject\">` becomes a size container. container-type inline-size applies layout containment, and an element with layout containment is the containing block of its `position: fixed` descendants. The Filters popover (`FiltersPopover` in MetaprojectView.tsx, rendered inside that section, class `menu`, which `styles.css` sets to `position: fixed`) is placed with viewport coordinates from `anchor.getBoundingClientRect()` (`left`, `top: rect.bottom + 4`). With the new container, those values are resolved against the section's padding box, not the viewport, so the popover is shifted by the section's own viewport offset (sidebar width, toolbar height) and the Escape/outside-press logic and the horizontal clamp to `window.innerWidth` no longer match where it is drawn.",
  "impact": "Where the section is not at viewport (0,0) the Filters popover opens displaced from its button, and can fall partly outside the window. The only live measurement (720x480) shows the popover top 3 px below the 4 px the code intends (button bottom 225, popover top 232), which is consistent with a small offset, but no measurement was taken with the sidebar visible (1180x780, 1440x900) or in the native window.",
  "suggested_fix": "Render the popover through a portal to document.body (the other `.menu` users are not inside a size container), or move the container off the ancestor of the popover (for example put `container-type` on `.metaproject-panes`, and leave the header, banner and popover outside it), or compute the position relative to `root.current.getBoundingClientRect()`. Add a DOM-free check or a live probe at 1180x780 with the popover open that compares popover.left to anchor.right - 320.",
  "evidence": "Read: metaproject.css line `.metaproject { container: metaproject / inline-size; }` (slice-06, hunk 1); MetaprojectView.tsx:171-201 (FiltersPopover, fixed-position `.menu` placed from getBoundingClientRect, rendered at :684 inside the section opened at :730); styles.css:142-143 (`.menu { position: fixed; ... }`); research-evidence/live-filters-popover-720x480.txt (top 232 vs button bottom 225). CSS Containment: container-type size/inline-size applies layout containment, which makes the element a containing block for fixed descendants. Not run: read-only tools and no browser, so the displacement is derived from the spec and the code, not measured at a width where the sidebar is visible. Measured by the orchestrator after the finding was raised: in Chromium 156 (.metaproject/reviews/2026-11-23-review-flow-branch/research-evidence/live-filters-popover-containing-block.txt) and in the system WKWebView, AppleWebKit 605.1.15 on macOS 26.7.3 (.metaproject/reviews/2026-11-23-review-flow-branch/research-evidence/verify-F-002-2.txt), the popover's layout box sits exactly at its inline viewport coordinates (displacement 0, 0) while the section's origin is (60, 77), so neither engine makes the size container the containing block of the fixed popover. Not measured: WebKit of older macOS versions. review-regression (wave 3) noted the same possibility without filing it.",
  "confidence": "medium",
  "reviewer": "review-frontend",
  "location_class": "in-diff",
  "dedupe_key": "css-container-type-breaks-fixed-filters-popover",
  "blocking_merge": false,
  "class_scope": {
   "sites": [
    "apps/desktop/src/metaproject/metaproject.css:9 (container on .metaproject)",
    "apps/desktop/src/metaproject/MetaprojectView.tsx:196 (the only position:fixed descendant of the section)"
   ],
   "enumeration_method": "keryx ctx rg \"position: fixed|createPortal|<Menu|components/Menu\" apps/desktop/src/metaproject: no other fixed or portalled descendant of the section; the details panel's `.compact` drawer is position:absolute inside `.metaproject-graph-panes` and is unaffected."
  }
 },
 {
  "id": "F-003",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "useEscape(() => close.current());",
  "problem": "FiltersPopover registers on the app-wide Escape stack (components/ui.tsx:44-70: window keydown listener, `e.preventDefault(); top.current?.()` for the top entry) and so makes `overlayOpen()` true (ui.tsx:81). On base the explorer was unmounted when the user left the view, taking any popover with it. On head the explorer is mounted but hidden (RetainedView), and `filtersOpen` is deliberately kept across view switches (comment 'Open or closed is explorer state ... survives a view or tab switch'). The only close paths are Escape, a mousedown outside, or the button. A keyboard user can Tab to the sidebar nav and press Enter (no mousedown, popover has no focus-out close) and arrive in another view with the popover open but hidden.",
  "impact": "While that hidden popover is registered: the first Escape in the other view is consumed by it (preventDefault, then focuses a hidden anchor), so Escape does not reach the visible view; AppShell's view shortcuts back off (AppShell.tsx:84 and :112 return when overlayOpen()); App.tsx:360 and BrowserPanel.tsx:114 (`show = ... && !overlayOpen()`) also treat an overlay as open, so the native browser view hides. Nothing on screen explains it; a second Escape clears it. If true for you: minor (recoverable, needs the keyboard path described).",
  "suggested_fix": "Close the popover when its view is hidden: pass the RetainedView `visible` flag into MetaprojectView and call setFiltersOpen(false) on becoming hidden, or mount FiltersPopover only while visible. Add a test that switches view with the popover open and checks overlayOpen() is false.",
  "evidence": "Also described, without a finding, by review-regression (wave 2), which lists the overlayOpen() consumers it reaches: App.tsx:360, AppShell.tsx:84/112, BrowserPanel.tsx:114/130, ReviewBoard.tsx:247/258. Normalisation notes: the same defect was raised by review-highload (review-highload-w2, F-001, minor); the same defect was raised by review-frontend (review-frontend-w2, its unnumbered finding, info); the same defect was raised by review-logic (review-logic-w5, F-001, minor).",
  "confidence": "medium",
  "reviewer": "review-degradation",
  "location_class": "in-diff",
  "degradation_class": "behaviour-delta",
  "evidence_kind": "consumer-trace",
  "publication": "finding",
  "blocking_merge": false
 },
 {
  "id": "F-004",
  "severity": "minor",
  "file": "apps/desktop/src/App.tsx",
  "line": null,
  "quote": "return visited || active ? <div className=\"view\" hidden={!visible}>{children}</div> : null;",
  "problem": "Base: `{workView === \"metaproject\" && <div className=\"view\" ...><MetaprojectView/></div>}` unmounted the explorer whenever the user left it (workView = view except while in Settings, App.tsx:481), so every return re-ran the catalog read and refreshed the 'Graph is stale/missing' freshness banner, node list and counts. Head keeps Explorer mounted; the catalog effect in MetaprojectView.tsx (`useEffect(() => { if (protocol === null) return; const generation = ++project.current; ... read(cwd, { action: \"catalog\" })`) depends only on protocol/cwd/read/revision, and RetainedView passes the explorer no visibility or 'returned' signal. After the first visit the catalog is read again only on cwd change, Retry/Refresh/Rebuild or revision bump.",
  "impact": "User opens Metaproject, goes to a session where the agent (or the user) rebuilds the graph or changes the repo, and returns: the list, counts and freshness banner still show the old snapshot, including a stale 'Graph is stale' banner after a rebuild done elsewhere. The state self-corrects only when a later read returns a different snapshotId (which raises the 'Project knowledge changed' banner with Refresh catalog); a plain look at the list shows old data with no hint. If true for you: minor, a stale view, recoverable with one click once the banner shows.",
  "suggested_fix": "Give the retained explorer a refresh trigger on becoming visible again (pass `visible` through and bump `revision` on a hidden-to-visible transition when the catalog was loaded earlier than a threshold, or re-read the catalog silently and keep the selection when the snapshot id is unchanged). Alternatively state in the guide that the catalog is not refreshed on return.",
  "evidence": "not stated by the reviewer",
  "confidence": "medium",
  "reviewer": "review-degradation",
  "location_class": "in-diff",
  "degradation_class": "behaviour-delta",
  "evidence_kind": "base-diff",
  "publication": "finding",
  "blocking_merge": false
 },
 {
  "id": "F-005",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "const current = () => generation === project.current && shownSelection.current === from && activeMode.current === \"wiki\";",
  "problem": "Concurrent wiki-link lookups are won by whichever read returns first",
  "impact": "Trigger: click an unloaded wiki link A, then another unloaded link B on the same page before A's `search` read resolves. Both reads pass `current()` because the selection has not changed; whichever resolves first calls `openDocument` and changes the selection, after which the other is dropped. If A's read is the slower one, B opens (the last click wins); if A is faster, A opens and B is silently discarded. The outcome depends on read latency, not click order. No data is lost and the user can click again.",
  "suggested_fix": "Keep a lookup counter in a ref, increment it in openPath, and have `current()` also require `token === lookup.current` (the pattern `latestSearch.current.generation` already uses nearby).",
  "evidence": "`const current = () => generation === project.current && shownSelection.current === from && activeMode.current === \"wiki\";` in openPath, which guards only against a changed project, selection or mode, not against a second lookup started from the same page. Normalisation notes: confidence was not stated by the reviewer and is set at normalisation; the quote was taken at normalisation from the code the reviewer cited.",
  "confidence": "medium",
  "reviewer": "review-highload",
  "location_class": "in-diff"
 },
 {
  "id": "F-006",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "for (const node of nodes) remember(node);",
  "problem": "Per-render walk over every catalog node to fill seenNodes. One Map.set per node in the Explorer render body, on every render (search keystroke, each pointermove of the panel resize drag), although `nodes` is memoized and changes rarely.",
  "impact": "not stated by the reviewer",
  "suggested_fix": "Populate seenNodes in the useMemo that builds `nodes`, or in an effect keyed on `nodes`.",
  "evidence": "for (const node of nodes) remember(node); Normalisation notes: confidence was not stated by the reviewer and is set at normalisation; the quote was taken at normalisation from the code the reviewer cited; the same defect was raised by review-degradation (review-degradation-w1, F-003, info).",
  "confidence": "medium",
  "reviewer": "review-performance",
  "location_class": "in-diff"
 },
 {
  "id": "F-007",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/NodeDetailsPanel.tsx",
  "line": null,
  "quote": "relationships: summary ? summary.incoming + summary.outgoing + summary.secondStep : undefined,",
  "problem": "Code reading, not a render. The Relationships tab count adds secondStep edges; the Relationships fact row in the same panel header (`${summary.incoming} incoming · ${summary.outgoing} outgoing`) and the graph caption count only root-adjacent edges. A node with 5 incoming, 4 outgoing and 3 second-step edges shows 'Relationships 12' on the tab and '5 incoming · 4 outgoing' two rows above it. Unverified on screen; a live read of such a node would settle it.",
  "impact": "Two adjacent numbers for the same word disagree, so the user cannot tell whether the tab includes extra rows. The 'Second step' group sits inside a collapsed <details>, so the extra rows are not visible until opened.",
  "suggested_fix": "Either show the tab count as incoming + outgoing only (matching the fact row and caption) or add the second-step count to the fact row (for example '5 incoming · 4 outgoing · 3 second-step').",
  "evidence": "Code reading, not a render. The Relationships tab count adds secondStep edges; the Relationships fact row in the same panel header (`${summary.incoming} incoming · ${summary.outgoing} outgoing`) and the graph caption count only root-adjacent edges. A node with 5 incoming, 4 outgoing and 3 second-step edges shows 'Relationships 12' on the tab and '5 incoming · 4 outgoing' two rows above it. Unverified on screen; a live read of such a node would settle it. Normalisation notes: confidence was not stated by the reviewer and is set at normalisation.",
  "confidence": "medium",
  "reviewer": "review-ui-ux",
  "location_class": "in-diff"
 },
 {
  "id": "F-008",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/OpenSpecView.tsx",
  "line": null,
  "quote": "if (content.current) content.current.scrollTop = 0;",
  "problem": "Recorded OpenSpec scroll defect still live: choose() zeroes the content pane before the history entry is recorded. T7's result lists under noticed_not_touched that OpenSpecView choose() sets the content scrollTop to 0 before calling onLocation, so the entry being left records scroll 0. At head the code is unchanged: `if (content.current) content.current.scrollTop = 0;` runs before `onLocation?.(next)`. useExplorerNavigation.enter calls remember(leaving), which reads `pane?.scrollTop` of `.metaproject-content` (PANES index CONTENT_PANE) at that moment. The content ref in OpenSpecView is that same element (`<section ref={content} className=\"metaproject-content\"`). The T8 dispatch listed OpenSpecView.tsx among its target_files, but nothing in slice-03 shows this item was taken or declined.",
  "impact": "Back to a previous OpenSpec entry returns to the top of its document, not where the reader was. This is a silent wrong restore, not data loss, and AC11 covers only Graph selections.",
  "suggested_fix": "In choose(), do not reset scrollTop before onLocation; let navigate(..., { resetContent: true }) seed the new entry at 0 (the hook already supports it), or record the offsets before zeroing. Or record the item as accepted in the journal.",
  "evidence": "First recorded by the T7 worker under noticed_not_touched (results/T7.result.json); review-architecture (wave 2) pointed at the same record. Normalisation notes: confidence was not stated by the reviewer and is set at normalisation; the quote was taken at normalisation from the code the reviewer cited.",
  "confidence": "medium",
  "reviewer": "review-logic",
  "location_class": "in-diff"
 },
 {
  "id": "F-009",
  "severity": "minor",
  "file": ".metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/tasks.md",
  "line": null,
  "quote": "| T4 | review | Review round on the integrated change | T8, T9, T10, T11 | — |",
  "problem": "tasks.md is out of date against flow.json and the journal. The task table still shows T4 depending on T8, T9, T10, T11, T9 on T8 and T11 on T8, and has no rows for T12-T16, although the journal records task-depends-set and task-added entries that change them.",
  "impact": "A reader of tasks.md alone gets the wrong order and misses five tasks; no gate input is wrong.",
  "suggested_fix": "Add the rows T12-T16 and correct the dependencies to match flow.json, or label tasks.md as the initial plan with flow.json as the source of truth.",
  "evidence": "review-architecture (wave 1) noted the same drift without filing it. Normalisation notes: confidence was not stated by the reviewer and is set at normalisation; the quote was taken at normalisation from the code the reviewer cited.",
  "confidence": "high",
  "reviewer": "review-logic",
  "location_class": "in-diff"
 },
 {
  "id": "F-010",
  "severity": "minor",
  "file": ".metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/dispatch/T9.dispatch.json",
  "line": null,
  "quote": "\"path\": \".metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/resolved/T9.implement.json\"",
  "problem": "T9 dispatch names files as existing that are absent at head, and requires a result file the journal says was not requested. T9.dispatch.json has context_refs entry `resolved/T9.implement.json` with \"exists\": true and output_contract.artifact_path `results/T9.result.json`, and a constraint to validate that result against the resolved file. Neither file is in the flow folder at head (resolved/ holds T5-T8, T12-T14, T16; results/ holds T5-T8, T12-T14, T16), and git history has no record of them. The journal entry for T9 says \"No result JSON was requested for this docs task\", which contradicts the dispatch. T15 (also docs, flow.json status done) has no result or resolved file either. flow.json marks both T9 and T15 done with disposition completed.",
  "impact": "A gate input that says a file exists when it does not, and a done task with no result artifact, mean a later reader or the review-flow gate cannot check T9 and T15 against the contract the dispatch states; the evidence is only the journal prose.",
  "suggested_fix": "Either record in flow.json dispositionReason for T9 and T15 that the docs workers returned inline and no result artifact exists, or remove the stale context_refs entry and output_contract from T9.dispatch.json. Do not edit flow.json by hand; use the keryx flow CLI.",
  "evidence": "Checked by the orchestrator at head: .metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/resolved and .metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/results hold T5-T8, T12-T14 and T16 only; `git log --diff-filter=D` over both folders is empty, so the T9 and T15 files never existed. The dispatch generator wrote `\"exists\": true` for the resolved-context path of every task without looking. The journal entry for T9 says no result JSON was requested. review-regression (wave 1) noted the same gap. Normalisation notes: confidence was not stated by the reviewer and is set at normalisation; the quote was taken at normalisation from the code the reviewer cited.",
  "confidence": "high",
  "reviewer": "review-logic",
  "location_class": "in-diff"
 },
 {
  "id": "F-011",
  "severity": "minor",
  "file": "apps/desktop/src/App.dom.test.tsx",
  "line": null,
  "quote": "root.render(React.createElement(RetainedView, { active, visible: active, children: React.createElement(Draft) }));",
  "problem": "The RetainedView test passes one value for both props, so `hidden={!visible}` -> `hidden={!active}` leaves it green (mutant A1). App.tsx:594 passes different values (workView vs view), the Settings-over-work-view case.",
  "impact": "The explorer could show over Settings with the suite green.",
  "suggested_fix": "Render with active true and visible false and assert the wrapper is hidden and the input is kept.",
  "evidence": "mutant A1 in a scratch copy: bun test src/App.dom.test.tsx -> GREEN (1 pass). The orchestrator re-ran every proposed mutant through `keryx review mutate` with all six test files per mutant (.metaproject/reviews/2026-11-23-review-flow-branch/research-evidence/mutation-1.md: 15 killed, 67 survived, 0 invalid); the killed and surviving ids are the ones this finding names.",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "location_class": "in-diff",
  "dedupe_key": "testing:retainedview-active-visible"
 },
 {
  "id": "F-012",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/RelationshipGraph.dom.test.tsx",
  "line": null,
  "quote": "test(\"a zero-sized container is never fitted\", async () => {",
  "problem": "Asserts only an unchanged zoom; deleting `if (!target.usable) return;` (G5) or the zoom clamp (G9) leaves it green, and no test gives the container a size, so fit and zoom success paths never run.",
  "impact": "A falsy-state test with no positive artifact: it passes when fit does nothing.",
  "suggested_fix": "Stub clientWidth/clientHeight on the viewport, assert zoom and pan after Fit and clamped zoom after repeated Zoom in.",
  "evidence": "mutants G5 and G9 GREEN; G6 RED. The orchestrator re-ran every proposed mutant through `keryx review mutate` with all six test files per mutant (.metaproject/reviews/2026-11-23-review-flow-branch/research-evidence/mutation-1.md: 15 killed, 67 survived, 0 invalid); the killed and surviving ids are the ones this finding names.",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "location_class": "in-diff",
  "dedupe_key": "testing:graph-fit-falsy-only"
 },
 {
  "id": "F-013",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/RelationshipGraph.tsx",
  "line": null,
  "quote": "themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: [\"data-theme\", \"data-palette\", \"style\"] });",
  "problem": "AC6 names data-theme or data-palette; the theme test sets data-theme only. Removing data-palette, the colour-scheme listener, the hover fade/cursor, the isSide guard, the root border width or the second-step class leaves the suite green.",
  "impact": "One trigger of a stated acceptance criterion and the hover behaviour are unprotected.",
  "suggested_fix": "Flip data-palette in the theme test; emit mouseover/mouseout and check classes; check second-step class and root border-width with styleEnabled.",
  "evidence": "mutants G1,G2,G3,G4,G7,G8,G10,G11 all GREEN. The orchestrator re-ran every proposed mutant through `keryx review mutate` with all six test files per mutant (.metaproject/reviews/2026-11-23-review-flow-branch/research-evidence/mutation-1.md: 15 killed, 67 survived, 0 invalid); the killed and surviving ids are the ones this finding names. Normalisation notes: the same defect was raised by review-logic (review-logic-w4, F-002, info).",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "location_class": "in-diff",
  "dedupe_key": "testing:graph-theme-hover-style"
 },
 {
  "id": "F-014",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/useExplorerNavigation.ts",
  "line": null,
  "quote": "const PANES = [\".metaproject-panes\", \".metaproject-list\", \".metaproject-content\", \".metaproject-details-body\"];",
  "problem": "No test restores a scroll position; reverting the selector T8 changed (.metaproject-details-body -> .metaproject-node-body), the history cap, the same-route guard, the content reset and the switchView guard all stay green.",
  "impact": "The Back scroll restore fixed in T8 can regress unseen.",
  "suggested_fix": "DOM test that scrolls the details body, selects another node, presses Back and asserts scrollTop; one for the 40-entry cap.",
  "evidence": "mutants N1..N5 all GREEN in MetaprojectView.dom.test.tsx. The orchestrator re-ran every proposed mutant through `keryx review mutate` with all six test files per mutant (.metaproject/reviews/2026-11-23-review-flow-branch/research-evidence/mutation-1.md: 15 killed, 67 survived, 0 invalid); the killed and surviving ids are the ones this finding names.",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "location_class": "in-diff",
  "dedupe_key": "testing:explorer-nav-scroll"
 },
 {
  "id": "F-015",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "const relationDirection = mode === \"wiki\" ? \"both\" : direction;",
  "problem": "The AC13 test changes depth and kinds but leaves Direction at \"both\", and runs protocol 1 only; the direction part and the V2 kinds branch are unpinned.",
  "impact": "AC13 has one of three parts with no separating fixture.",
  "suggested_fix": "Set Direction to incoming before switching to Wiki; add a protocol-2 run asserting the V2 kinds.",
  "evidence": "mutants V1 and V30 GREEN. The orchestrator re-ran every proposed mutant through `keryx review mutate` with all six test files per mutant (.metaproject/reviews/2026-11-23-review-flow-branch/research-evidence/mutation-1.md: 15 killed, 67 survived, 0 invalid); the killed and surviving ids are the ones this finding names. Normalisation notes: the same defect was raised by review-logic (review-logic-w4, F-003, info).",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "location_class": "in-diff",
  "dedupe_key": "testing:ac13-direction"
 },
 {
  "id": "F-016",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "setRevealRelationships(value => value + 1);",
  "problem": "showHidden (open panel + reveal Relationships) is driven by no test; the graph test checks a mock callback and the panel test checks the prop.",
  "impact": "Removing either half leaves all suites green and breaks the way to hidden neighbours.",
  "suggested_fix": "MetaprojectView test with headless cytoscape: close the panel, tap the overflow node, assert panel open on Relationships.",
  "evidence": "mutants V8 and V8b GREEN. The orchestrator re-ran every proposed mutant through `keryx review mutate` with all six test files per mutant (.metaproject/reviews/2026-11-23-review-flow-branch/research-evidence/mutation-1.md: 15 killed, 67 survived, 0 invalid); the killed and surviving ids are the ones this finding names.",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "location_class": "in-diff",
  "dedupe_key": "testing:showhidden-wiring"
 },
 {
  "id": "F-017",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "const shownTotal = catalog ? mode === \"wiki\" ? catalog.counts.wiki : catalog.counts.files + catalog.counts.wiki + catalog.counts.modules : 0;",
  "problem": "T8 gates survive deletion: list-header floor and Wiki-mode total, dropping a stale graph on a failed read, protocol-2 showGraph, Draft gate, documents-pending flags, Direction in the Filters count, Filters-button mousedown, popover clamp, Wiki disclosure with 0 edges.",
  "impact": "Each gate was added in this change and its next edit is unprotected.",
  "suggested_fix": "One test per gate with the existing fixtures (Wiki-mode header, failed second read, mousedown on the Filters button).",
  "evidence": "mutants V2,V3,V4,V5,V6,V7,V13,V14,V15,V17 all GREEN. The orchestrator re-ran every proposed mutant through `keryx review mutate` with all six test files per mutant (.metaproject/reviews/2026-11-23-review-flow-branch/research-evidence/mutation-1.md: 15 killed, 67 survived, 0 invalid); the killed and surviving ids are the ones this finding names.",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "location_class": "in-diff",
  "dedupe_key": "testing:metaprojectview-gates"
 },
 {
  "id": "F-018",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "if (result.snapshotId !== snapshotId) { setSnapshotMismatch(true); return; }",
  "problem": "AC16/AC12 guards unpinned: undecodable href, snapshot mismatch on lookup, late lookup after selection change, message scoped to selection, and the settled Wiki empty-state wording naming the searched text (the test asserts the in-flight state only).",
  "impact": "The settled half of AC12 and three AC16 sub-claims have no failing test.",
  "suggested_fix": "Run the debounce and assert the final title; add a malformed %E0%A4%A link and a late-resolving lookup.",
  "evidence": "mutants V9,V10,V11,V12,V16,V31 GREEN; V19 RED. The orchestrator re-ran every proposed mutant through `keryx review mutate` with all six test files per mutant (.metaproject/reviews/2026-11-23-review-flow-branch/research-evidence/mutation-1.md: 15 killed, 67 survived, 0 invalid); the killed and surviving ids are the ones this finding names. Normalisation notes: the same defect was raised by review-logic (review-logic-w4, F-001, minor).",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "location_class": "in-diff",
  "dedupe_key": "testing:lookup-and-empty-state"
 },
 {
  "id": "F-019",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/NodeDetailsPanel.tsx",
  "line": null,
  "quote": "const tab: Tab = tabChoice?.node === node.id ? tabChoice.value : \"relationships\";",
  "problem": "Per-node tab reset, tab-list arrow keys, drag and ArrowRight resize, failed-copy message, suggested-page count, stale-preview guard, 360-char cut, list-after-prose rule and fenced-code skipping have no fixture.",
  "impact": "Next edit to any of these is unprotected.",
  "suggested_fix": "Fixtures: a leading-list page with a fenced block, a 400-char paragraph, a second node after a tab choice, ArrowRight/Home/End on the tab list.",
  "evidence": "mutants P1,P3,P4,P5,P6,P7,P8,P9,P11,P13,P14,P17,P18,P20,P21 GREEN; P2 RED. The orchestrator re-ran every proposed mutant through `keryx review mutate` with all six test files per mutant (.metaproject/reviews/2026-11-23-review-flow-branch/research-evidence/mutation-1.md: 15 killed, 67 survived, 0 invalid); the killed and surviving ids are the ones this finding names.",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "location_class": "in-diff",
  "dedupe_key": "testing:details-panel-gates"
 },
 {
  "id": "F-020",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/RelationshipList.tsx",
  "line": null,
  "quote": "if (!from || !to) continue;",
  "problem": "No fixture has a dangling edge, exactly two evidence lines, a second-step self-loop, or a count label beside evidence lines.",
  "impact": "The dangling-edge gate protects against a render crash on truncated projections and is unprotected.",
  "suggested_fix": "Add one projection with a dangling edge, one edge with two evidence lines, one second-step self-loop.",
  "evidence": "mutants L1,L2,L3,L8 GREEN; L5,L6 RED. The orchestrator re-ran every proposed mutant through `keryx review mutate` with all six test files per mutant (.metaproject/reviews/2026-11-23-review-flow-branch/research-evidence/mutation-1.md: 15 killed, 67 survived, 0 invalid); the killed and surviving ids are the ones this finding names.",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "location_class": "in-diff",
  "dedupe_key": "testing:relationshiplist-gates"
 },
 {
  "id": "F-021",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/graphLayout.ts",
  "line": null,
  "quote": "while (candidates(false, attached));",
  "problem": "AC3 test passes without the drawn-anchor preference and without chained second-step attachment; self-loops, edge width, fit-case pan, percentage and 3-digit colours, alpha clamp and columnCap integer check have no fixture.",
  "impact": "Layout rules that keep truncated projections overlap-free are unprotected.",
  "suggested_fix": "Fixtures: root self-loop, second-step node reachable only via another second-step node, edge count 16, a fitting layout with a pan assertion.",
  "evidence": "mutants Y1,Y2,Y3,Y4,Y5,Y6,Y7,Y8,Y9,Y12,Y16,Y18 GREEN; Y19 RED. The orchestrator re-ran every proposed mutant through `keryx review mutate` with all six test files per mutant (.metaproject/reviews/2026-11-23-review-flow-branch/research-evidence/mutation-1.md: 15 killed, 67 survived, 0 invalid); the killed and surviving ids are the ones this finding names.",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "location_class": "in-diff",
  "dedupe_key": "testing:graphlayout-gates"
 },
 {
  "id": "F-022",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/RelationshipList.tsx",
  "line": null,
  "quote": "if (edge.from === projection.root) adjacent.outgoing.push({ edge, node: to });",
  "problem": "The panel counts and lists a self-loop edge (edge.from === edge.to === root) once, as outgoing (documented in groupRelationships). The graph layout skips self-loops (`if (edge.from === edge.to) return;` in layoutNeighborhood), so its caption count leaves them out. The two numbers are computed from the same projection for the same selection and shown on one screen.",
  "impact": "For a node with a self-edge (for example a wiki page whose `links` edge points at itself) the graph caption reads '0 incoming · 0 outgoing' while the panel fact reads '0 incoming · 1 outgoing', and the Relationships tab lists the node as its own outgoing neighbour, whose row selects the node already shown (a no-op). AC7 asks for the panel counts to come from the root-adjacent edges, so the panel follows the criterion; the caption is the one that differs.",
  "suggested_fix": "Pick one rule for both: skip self-loops in groupRelationships (the row does nothing useful), or count them in layoutNeighborhood. Skipping them in groupRelationships keeps the two counts equal.",
  "evidence": "RelationshipList.tsx groupRelationships: `if (edge.from === projection.root) adjacent.outgoing.push(...)` runs before any self-loop test; graphLayout.ts lines 505-508: `if (edge.from === edge.to) return; if (edge.to === root.id) incoming++; if (edge.from === root.id) outgoing++;`. The self-loop case is only reachable if the producer emits a self-edge; not verified that it does.",
  "confidence": "medium",
  "reviewer": "review-logic",
  "location_class": "in-diff"
 },
 {
  "id": "F-023",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/RelationshipGraph.dom.test.tsx",
  "line": null,
  "quote": "expect(block).toContain(\"min-block-size: 200px;\");",
  "problem": "The G8 test reads graph.css from disk and matches a regex over its text, including the exact declaration `min-block-size: 200px;`. It verifies the stylesheet's spelling, not that the graph fills its host, and it will fail on any harmless reformat or a change of the minimum (the T8 notes lower the minimum to 160px in a narrow container, done in metaproject.css).",
  "impact": "A brittle test: it can fail on a benign CSS edit and gives no evidence about layout, which happy-dom cannot measure; the real check is the live measurement (AC5, AC20).",
  "suggested_fix": "Keep only the `not.toContain(\"clamp(\")` and `flex: 1 1 auto;` assertions, or drop the pinned minimum value; leave layout proof to the live pass.",
  "evidence": "RelationshipGraph.dom.test.tsx G8 test (slice-04 diff); graph.css lines 2-12 at head contain the matched declarations. Normalisation notes: the same defect was raised by review-testing-practices (review-testing-practices-w1, F-012, info).",
  "confidence": "high",
  "reviewer": "review-frontend",
  "location_class": "in-diff"
 },
 {
  "id": "F-024",
  "severity": "info",
  "file": ".metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/results/T16.result.json",
  "line": null,
  "quote": "it served the committed MetaprojectView.tsx for the few seconds of the red check",
  "problem": "Red checks swapped tracked source files in the shared worktree under a live dev server",
  "impact": "Another lane or live check reading the swapped file or the dev server during the swap sees old code; a crash between swap and restore leaves the tree on the old version. T15 (guide and screenshots) ran beside T16 in flow.json history (both started 08:36:10). No corrupted outcome is shown, so info.",
  "suggested_fix": "Run red checks in a scratch copy or throwaway worktree instead of swapping tracked files in the shared tree.",
  "evidence": "\"it served the committed MetaprojectView.tsx for the few seconds of the red check\" (T16 notes); T14 result notes: \"it picked up the file changes, including the few seconds while the HEAD versions were swapped in for the red check\" The two guide screenshots were captured by the orchestrator itself, not during those red checks (journal, entry on T15/T16 dispatch). Normalisation notes: confidence was not stated by the reviewer and is set at normalisation; the quote was taken at normalisation from the code the reviewer cited.",
  "confidence": "medium",
  "reviewer": "review-highload",
  "location_class": "in-diff"
 },
 {
  "id": "F-025",
  "severity": "info",
  "file": "apps/desktop/src/App.tsx",
  "line": null,
  "quote": "export function RetainedView(",
  "problem": "RetainedView is a generic view-retention helper exported from the composition root. `export function RetainedView({ active, visible, children })` lives in App.tsx and is exported only so App.dom.test.tsx can import it (`(await import(\"./App\")).RetainedView`). The component has no dependency on App state; the existing session/flows/issues views still use the inline `hidden={view !== ...}` pattern, so two retention idioms now coexist in one file. This is a placement opinion, not a violation of a named rule.",
  "impact": "Testing it requires importing the whole App module graph, and the next view that needs retention has to import from App.tsx.",
  "suggested_fix": "Optional: move it to apps/desktop/src/components/ui (or shell/) and import it in App.tsx; the test then imports it directly.",
  "evidence": "Normalisation notes: confidence was not stated by the reviewer and is set at normalisation; the quote was taken at normalisation from the code the reviewer cited.",
  "confidence": "medium",
  "reviewer": "review-architecture",
  "location_class": "in-diff"
 },
 {
  "id": "F-026",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/NodeDetailsPanel.tsx",
  "line": null,
  "quote": "export const isOpenSpecNode",
  "problem": "isOpenSpecNode is exported but has no importer outside its own file. `export const isOpenSpecNode` is used only inside NodeDetailsPanel.tsx (line 87); the keryx ctx rg search over apps/desktop/src found no other import. The plan's interface section lists it as an export, which explains it, so this is a note on a public surface nobody consumes.",
  "impact": "A public export with no consumer widens the module's surface for no current caller.",
  "suggested_fix": "Drop `export` if the plan's listed interface is no longer required, or leave it as the plan states.",
  "evidence": "Normalisation notes: confidence was not stated by the reviewer and is set at normalisation; the quote was taken at normalisation from the code the reviewer cited.",
  "confidence": "high",
  "reviewer": "review-architecture",
  "location_class": "in-diff"
 },
 {
  "id": "F-027",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/useExplorerNavigation.ts",
  "line": null,
  "quote": "previousRoutes.current = history;",
  "problem": "`back` reads `previousRoutes.current`, which is refreshed from `history` only on render, while `enter` updates `current.current` eagerly but not `previousRoutes.current`. Two calls in one event tick, `navigate`/`visit` then `back`, would pop the entry before the one just pushed.",
  "impact": "No caller in the slice does this; user events render between clicks. Noted only because the ref pair (`current`, `previousRoutes`) is half-eager.",
  "suggested_fix": "In `enter`, also set `previousRoutes.current = [...previousRoutes.current.slice(1 - HISTORY_LIMIT), leaving]` so both refs move together.",
  "evidence": "Read useExplorerNavigation.ts `enter` and `back` (slice-06). No call path found that triggers both in one tick. review-highload (wave 3) described the same narrow gap and did not file it.",
  "confidence": "low",
  "reviewer": "review-frontend",
  "location_class": "in-diff",
  "dedupe_key": "explorer-nav-previousroutes-ref-lag",
  "blocking_merge": false
 },
 {
  "id": "F-028",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/metaproject.css",
  "line": null,
  "quote": ".metaproject-graph-panes:has(.metaproject-details:not(.compact)) { grid-template-columns: minmax(150px, 180px) minmax(0, 1fr) auto; }",
  "problem": "Narrow-host container rule for the docked panel looks unreachable (unverified). This rule sits inside `@container metaproject (max-width: 760px)` and matches only while the panel is docked (not .compact). NodeDetailsPanel.tsx sets compact when `availableWidth < COMPACT_BELOW` (820, lines 11 and 154). If availableWidth is the width of the panes area, it is not wider than the .metaproject container, so a docked panel implies a container of about 820 px or more, outside the 760 px query, and the narrower 150-180 px list column may never apply.",
  "impact": "If unreachable it is dead CSS suggesting a narrow docked layout that does not exist; if reachable nothing is wrong. No rendered defect is claimed.",
  "suggested_fix": "Settle with the probe; if dead, remove the rule.",
  "evidence": "UNVERIFIED. No measurement covers a host between 760 and 820 px. Probe that would settle it: browser dev build at 780 and 800 px wide, Graph with the panel open; read the computed grid-template-columns of .metaproject-graph-panes, the container's inline size and whether .metaproject-details has the compact class; read NodeDetailsPanel.tsx to see which element availableWidth measures. Normalisation notes: confidence was not stated by the reviewer and is set at normalisation.",
  "confidence": "low",
  "reviewer": "review-layout",
  "location_class": "in-diff"
 },
 {
  "id": "F-029",
  "severity": "info",
  "file": "docs/docs/guides/desktop-metaproject.md",
  "line": null,
  "quote": "twelve importing files, the Agent Bus wiki page that describes it and its module bus on the left",
  "problem": "Graph screenshot alt text says twelve importing files sit on the left, the picture draws ten. The alt text reads \"twelve importing files, the Agent Bus wiki page that describes it and its module bus on the left\". That is 14 left-column items, while the same page says a column shows at most 12. In docs/docs/images/desktop-metaproject/graph.jpg the left column draws 10 import nodes, 1 Describes, 1 Contains and a \"+2 more\" entry; only the caption (\"Imports · 12\") and the panel list carry twelve.",
  "impact": "A screen-reader user, or a reader comparing text and picture, is told the graph draws more nodes than the 12-per-column rule allows. No behaviour is affected.",
  "suggested_fix": "Drop the count or state it as drawn: \"the files that import it (Imports · 12, two of them collapsed into +2 more), the Agent Bus page and its module bus on the left\".",
  "evidence": "The screenshot docs/docs/images/desktop-metaproject/graph.jpg was captured by the orchestrator from the browser dev build; it is binary and was in no slice, so the reviewer compared the alt text with the image file itself. Normalisation notes: the quote was taken at normalisation from the code the reviewer cited.",
  "confidence": "medium",
  "reviewer": "review-logic",
  "location_class": "in-diff"
 }
]
```

## Token spend

token spend: unknown (31 dispatch(es), none reported usage)

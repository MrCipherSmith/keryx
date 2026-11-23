**Changes requested — 0 Blocker, 0 Major, 8 Minor.** Every finding of round 1 that was in the fix loop is closed against the code, one of them with a regression. The fixes brought three small behaviour defects of their own and left four gaps in the tests that pin them; nothing found in this round loses data, crashes or breaks an acceptance criterion.
Reviewed `60cbe1c565f4..b1538097e636` (the fix commits of round 1) · round 2, delta · the two slices the operator chose: `slice-03` (the code, tests and guide the fixes changed) and `slice-04` · CI not consulted (the target is a branch, not a pull request).
Evidence level: ran — `bun test` on the impacted test files (one process per file: 4, 8 and 51 pass), `keryx review mutate` over round 1's 82 mutants on this head (76 killed, 2 survived, 4 invalid because a fix moved the line), `keryx review mutate` over the 34 mutants review-testing-practices proposed for the fix code (18 killed, 16 survived, 0 invalid), and, before the round, the type check, the whole desktop suite (904 pass), the Vite build and the live measurements of the popover in Chromium 156 and in the system WKWebView recorded in the flow journal. Did not run: the native Tauri window (no Rust toolchain on this machine), WebKit older than macOS 26, Back in OpenSpec live (the project has no OpenSpec entries), and the 29 dispatches the operator left out of this round.

This verdict is interim until the operator closes the round.

### Withdrawn

- **Round 1 F-002** (a size container could trap the fixed Filters popover): wrong for the engines measured; round 1's verifier refuted it by measurement (displacement 0, 0 in Chromium 156 and in WKWebView on macOS 26.7.3). The claim rested on a reading of the containment specification that the current definition of `container-type` does not support. Unmeasured: older WebKit.
- **Round 1 F-029** (the graph screenshot's alt text miscounts the importing files): wrong; the picture draws ten files and a “+2 more” entry, which the alt text counts together.

### Dispositions of round 1's findings

Judged against the code at this head, not against the commit messages.

- **F-001: closed.** review-layout (owner), review-ui-ux, review-logic, review-clean-code. The popover is bounded by the room on the side it takes; measured after the fix at 720×480 with Details expanded: box 98–327 in Chromium 156, 135–327 in WKWebView (flow journal, T17).
- **F-002: withdrawn.** Refuted in round 1 by measurement in both engines (displacement 0, 0) and carried as refuted; not reopened. Unmeasured: WebKit older than macOS 26.
- **F-003: closed.** review-degradation (owner), review-highload, review-frontend, review-logic, review-regression, review-security-code, review-ui-ux. The popover is unmounted in the render in which the view is hidden; the test asserts `overlayOpen()` false and an unprevented Escape.
- **F-004: closed.** review-degradation (owner), review-highload, review-frontend, review-logic, review-regression. One catalog read per return, counted live by the orchestrator. Its fix brought this round's F-002 and F-003.
- **F-005: closed.** review-highload (owner), review-logic, review-regression, review-security-code. Only the lookup holding the latest token may settle; the three-lookup test fails without it.
- **F-006: closed.** review-performance (owner), review-degradation, review-logic, review-regression. The memory is filled in an effect keyed on the node list. Its fix brought this round's F-004 and F-008.
- **F-007: closed.** review-ui-ux (owner), review-logic, review-regression. The fact row adds the second-step count; seen live by the orchestrator (13 + 337 = 350, the tab count).
- **F-008: closed.** review-logic (owner), review-degradation, review-regression. `choose()` records the leaving scroll before it zeroes the pane. Not seen live: the project has no OpenSpec entries; it rests on its DOM test.
- **F-009: closed.** The orchestrator's own check (the rows of `tasks.md` against `flow.json`); no reviewer read the flow package in this round.
- **F-010: closed.** review-logic (owner). The four files exist and each result says it was written during T21.
- **F-011: closed.** review-testing-practices (owner): its round-1 mutants are killed at this head (`research-evidence/mutation-1.md`: 76 killed, 2 survived, 4 invalid of 82).
- **F-012: closed.** review-testing-practices (owner): its round-1 mutants are killed at this head (`research-evidence/mutation-1.md`: 76 killed, 2 survived, 4 invalid of 82).
- **F-013: closed.** review-testing-practices (owner): its round-1 mutants are killed at this head (`research-evidence/mutation-1.md`: 76 killed, 2 survived, 4 invalid of 82).
- **F-014: closed.** review-testing-practices (owner): its round-1 mutants are killed at this head (`research-evidence/mutation-1.md`: 76 killed, 2 survived, 4 invalid of 82). N3 is kept as an equivalent mutant: every caller passes a fresh route object (checked by the reviewer against the code).
- **F-015: closed.** review-testing-practices (owner): its round-1 mutants are killed at this head (`research-evidence/mutation-1.md`: 76 killed, 2 survived, 4 invalid of 82).
- **F-016: closed.** review-testing-practices (owner): its round-1 mutants are killed at this head (`research-evidence/mutation-1.md`: 76 killed, 2 survived, 4 invalid of 82).
- **F-017: closed.** review-testing-practices (owner): its round-1 mutants are killed at this head (`research-evidence/mutation-1.md`: 76 killed, 2 survived, 4 invalid of 82). V5 and V6 were re-run on their moved lines and are killed; V15's moved line was not re-mutated, one test covers it.
- **F-018: closed.** review-testing-practices (owner): its round-1 mutants are killed at this head (`research-evidence/mutation-1.md`: 76 killed, 2 survived, 4 invalid of 82).
- **F-019: closed.** review-testing-practices (owner): its round-1 mutants are killed at this head (`research-evidence/mutation-1.md`: 76 killed, 2 survived, 4 invalid of 82). P3 is kept as an equivalent mutant: the Draft button is disabled while drafting and `draft()` has one caller.
- **F-020: closed.** review-testing-practices (owner): its round-1 mutants are killed at this head (`research-evidence/mutation-1.md`: 76 killed, 2 survived, 4 invalid of 82). L3 is gone with the guard the self-loop fix removed.
- **F-021: closed.** review-testing-practices (owner): its round-1 mutants are killed at this head (`research-evidence/mutation-1.md`: 76 killed, 2 survived, 4 invalid of 82).
- **F-022: regressed.** review-regression; review-logic (owner) calls it closed for what it named. The panel and the graph caption now agree, and the fix left two readers of the raw edge count behind: this round's F-001.
- **F-023: open.** Info, below the fix threshold; not changed.
- **F-024: closed.** Process: every red check of the fix round ran in a scratch copy (`scratch_check.py`), none in the served worktree.
- **F-025: open.** Info, below the fix threshold; not changed.
- **F-026: open.** Info, below the fix threshold; not changed.
- **F-027: open.** Info, below the fix threshold; not changed.
- **F-028: open.** Info, below the fix threshold; not changed.
- **F-029: withdrawn.** Refuted in round 1 (the picture draws ten importing files and a “+2 more” entry, which the alt text counts together); carried as refuted.

## Regressions the fixes introduced

- **[F-001]** answering round 1's F-022: A node whose only relationships are links to itself gets a blank Relationships list, and the Wiki count still includes those links.
- **[F-002]** answering round 1's F-004: Returning to the explorer drops a Wiki-link lookup or a “load more” page that was still in flight.
- **[F-003]** answering round 1's F-004: A failed quiet catalog re-read on return shows the catalog error banner over a working explorer.

### Minor

**F-001. A node whose only relationships are links to itself gets a blank Relationships list, and the Wiki count still includes those links.** `apps/desktop/src/metaproject/RelationshipList.tsx` · raised by review-logic · answering round 1's F-022 · verifier: confirmed (site-check), premise: upheld.
Answering F-022, groupRelationships() now drops every self-loop (`if (edge.from === edge.to) continue;`), but the empty state still tests `projection.edges.length === 0`, the raw edge count. A projection whose only edges are self-loops (or edges with an end absent from the projection, which groupRelationships already dropped) has edges.length > 0 and groups that are all empty: no note, no group, an empty `<div class="metaproject-rel">`.
Impact: Trigger: select a wiki page whose only relationship is a `links` edge to itself (the F-022 example), in Graph with the panel open on Relationships, or in Wiki. The panel's fact row says '0 incoming · 0 outgoing', the tab count is 0, and the tab body is blank with no explanation. In Wiki the disclosure reads 'Relationships 1' and opens onto nothing.
Fix: Decide the empty note from the groups, not the raw edges: `const empty = !groups.incoming.length && !groups.outgoing.length && !groups.secondStep.length;` and render the note when `empty`. In MetaprojectView.tsx show the disclosure and its count from `summarizeRelationships(currentProjection)` (incoming + outgoing), or from the same groups, not from `edges.length`.

**F-002. Returning to the explorer drops a Wiki-link lookup or a “load more” page that was still in flight.** `apps/desktop/src/metaproject/MetaprojectView.tsx` · raised by review-logic · answering round 1's F-004 · verifier: unverifiable (site-check), premise: upheld.
The quiet re-read added for F-004 goes through the catalog effect. On a hidden-to-visible change the visible effect (`if (!returned || !loaded.current) return; quietRead.current = true; setRevision(value => value + 1);`) bumps `revision`, a dependency of the catalog effect. React runs that effect's cleanup (`project.current++`) and then its body (`const generation = ++project.current;`), so project.current moves by two even when the re-read finds the same snapshotId and changes nothing. openPath captured `const generation = project.current;` and its `current()` requires `generation === project.current`;
Impact: Trigger: click an unloaded Wiki link (a `search` read) or 'load more' in a protocol 2 search, leave the Metaproject view before the read resolves, and return before it resolves, which means within one local CLI read. The lookup does not open its target and the page of results is not appended, with no message, and the project did not change.
Fix: Keep project.current for real project changes and give the quiet same-snapshot re-read its own counter: let the effect skip `++project.current` and the cleanup bump while `quiet` is set, guarding that read by a separate ref; or restore project.current in the unchanged-snapshot branch. Add a test that holds a wiki-link lookup, hides and shows the explorer, then releases it and checks the target opens.

**F-003. A failed quiet catalog re-read on return shows the catalog error banner over a working explorer.** `apps/desktop/src/metaproject/MetaprojectView.tsx` · raised by review-degradation · answering round 1's F-004 · verifier: confirmed (site-check), premise: upheld.
A failed quiet re-read on return shows the loud catalog error over a working explorer. The fix round added a quiet catalog re-read when the explorer becomes visible again (`quietRead.current = true; setRevision(...)`, lines 335-343). The load effect it reuses clears and sets `error` unconditionally: `setError("")` at line 370 and `setError(errMessage(cause))` in the catch at line 392. On base nothing was read on return, so nothing could fail there. Trigger: the user leaves the Metaproject tab and comes back while the CLI read fails (CLI busy or exiting, a rebuild writing the index, a transient spawn error).
Impact: not stated by the reviewer
Fix: In the catch, when `quiet` is true, keep the loaded catalog and skip `setError` (and do not clear a standing error at line 370 for a quiet read); the next real read or the user's Retry reports a persistent failure.

**F-004. The node-memory fix left the `remember` helper beside an inlined copy of its body.** `apps/desktop/src/metaproject/MetaprojectView.tsx` · raised by review-style · answering round 1's F-006 · verifier: confirmed (site-check), premise: upheld.
The fix for round-1 F-006 moved the node-memory fill into an effect and wrote the map write inline, while the `remember` helper declared three lines above (`const remember = (node: MetaprojectNode) => { seenNodes.current.set(node.id, node); };`) does the same write and is still used at line 603 (`if (node) remember(node);`). The same operation now has two spellings in one component.
Impact: A reader must check that the inline write and `remember` are the same operation; a later change to what the memory stores (a cap, a copy) has to be made in both.
Fix: Call the helper in the effect: `for (const node of nodes) remember(node);`.

**F-005. Finding ids of review round 1 are written into test names and comments.** `apps/desktop/src/metaproject/RelationshipGraph.dom.test.tsx` · raised by review-clean-code · answering round 1's F-011 to F-021 · verifier: confirmed (site-check), premise: challenged, operator: dismiss. **Dismissed by the operator.**
Fix-round bookkeeping is written into test names and comments: describe("... (F-012)"), describe("... (F-013)"), describe("... (F-013, AC6)") in RelationshipGraph.dom.test.tsx:314/351/402, describe("layoutNeighborhood — review round 1 fixtures (F-021)") in graphLayout.test.ts:508, the banner comment "Test strength after review round 1 (T20)" in MetaprojectView.dom.test.tsx:1019, and "(second-step counts: F-007 test below)" in NodeDetailsPanel.dom.test.tsx:119. The ids name findings of one review package and one flow task;
Impact: Cost: a later reader of the test report or of a failing test sees 'F-013' with no referent in the source tree, and the id can point at a different finding in another round. The AC6 reference is the only one that names something durable (the flow's acceptance criterion). No behaviour risk.
Fix: Name the groups by behaviour ("RelationshipGraph viewport", "RelationshipGraph interaction and styling", "layoutNeighborhood edge cases") and drop the ids; in the NodeDetailsPanel comment say 'see the second-step test below'; keep AC6 if wanted. The finding-to-test mapping stays in the flow journal.

**F-006. The bounds of the Filters popover placement and the removal of its resize listener are pinned by no test.** `apps/desktop/src/metaproject/MetaprojectView.tsx` · raised by review-testing-practices · answering round 1's F-001 · verifier: confirmed (execution), premise: upheld.
Five gates of placeFiltersPopover and its resize cleanup are unpinned. Mutants run in a scratch copy, suite green: R2-2 (`needed > below` only: flips above although there is less room above), R2-4 (`Math.max(POPOVER_MARGIN, ...)` on bottom), R2-5 (`Math.min(MENU_MAX_HEIGHT, above)` -> `above`), R2-6/R2-7 (the `Math.max(0, ...)` floor and the MENU_MAX_HEIGHT cap below), R2-9 (the resize listener is never removed). The two placement tests drive only the two clean cases: content 0 px with room below (305/167), content 229 px with 14 px below and 418 above;
Impact: The next edit to the placement can put the popover on the side with less room or let it run past the window edge, and a resize listener can leak, with all tests green. R2-8 and R2-1/R2-3/R2-10/R2-11 are killed, so the two main paths are pinned; the bounds are not.
Fix: Add: stubPopoverContentHeight(500) with the button at top 250 / bottom 274 in a 480 window (more room below than above) and assert style.top and no style.bottom (R2-2); a window of 900 with the popover below asserts maxHeight 420 (R2-7); a button at top 478 asserts bottom 8 (R2-4); content 229 with a button at top 600 in a 700 window asserts maxHeight 420 (R2-5);

**F-007. The quiet catalog re-read is pinned by one same-snapshot fixture; six of its gates survive deletion.** `apps/desktop/src/metaproject/MetaprojectView.tsx` · raised by review-testing-practices · answering round 1's F-004 · verifier: confirmed (execution), premise: upheld.
The quiet catalog path added for round-1 F-004 is pinned by one fixture (same snapshot id, graph ready then stale) and one rebuild fixture.
Impact: Each gate is correct today; the first three decide whether the explorer shows current data after a return, and a regression in any is silent.
Fix: Extend the 'shown again' test: a third read returns snapshotId "two" with new nodes, assert the list shows them (R2-16, R2-18); after the stale quiet read click Rebuild graph with a read returning graph ready and assert no 'Graph is stale' banner (R2-17, R2-19); count catalog reads for a return while the first read is pending (R2-14); open Details on the quiet-stale banner and assert the reason text (R2-26).

**F-008. The node-memory test asserts only that nothing is written; deleting the effect that fills the memory stays green.** `apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx` · raised by review-testing-practices · answering round 1's F-006 · verifier: confirmed (execution), premise: upheld.
The test asserts only `expect(writes).toBe(0)` after patching Map.prototype.set, with no positive artifact that the effect still fills the memory. Deleting the effect body (`for (const node of nodes) seenNodes.current.set(node.id, node);`, R2-23) leaves the suite green: writes are 0 either way. Only R2-24 (effect without its dependency) is killed. No other test reaches a node that exists only in seenNodes (a lookup result) through Back.
Impact: The memory that makes Back show the panel of a looked-up node at once can be removed with all tests green. The test also patches a global prototype to observe an internal field.
Fix: Open a wiki link whose target comes from a `search` hit that is not in the catalog, open another page, press Back and assert the target's panel title shows; and in the same test assert writes > 0 when the node list changes (for example a search that adds a hit).

**F-009. No test pins that `App.tsx` passes `visible` to the explorer, the one line the fixes for F-003 and F-004 hang on.** `apps/desktop/src/App.tsx` · raised by review-testing-practices · answering round 1's F-003 and F-004 · verifier: confirmed (execution), premise: upheld.
The one line that makes the fixes for round-1 F-003 and F-004 work in the app is unpinned: removing `visible={view === "metaproject"}` (R2-28) leaves every suite green, because the explorer tests pass `visible` themselves and App.dom.test.tsx renders only RetainedView. With the prop missing the default `true` applies and the popover stays open and the catalog is never re-read on return.
Impact: A refactor of the composition root can silently undo both fixes.
Fix: Cheapest: export a small wrapper or render App's work-view block in a DOM test with a stub MetaprojectView and assert it receives visible=false while another view is shown; or state in the flow that the wiring is covered by the live check only.

<details><summary><b>Info (kept in the record, not published as findings)</b></summary>

- **F-010. Every return to the explorer starts one catalog read, with no coalescing.** `apps/desktop/src/metaproject/MetaprojectView.tsx` · review-highload · verifier: confirmed (site-check).
- **F-011. The popover is not placed again when its content grows (the Reset filters row) while it is open (not measured).** `apps/desktop/src/metaproject/MetaprojectView.tsx` · review-layout · verifier: unverifiable (site-check).
- **F-012. The popover is not placed again when the content under its button scrolls (not measured).** `apps/desktop/src/metaproject/MetaprojectView.tsx` · review-layout · verifier: unverifiable (site-check).
- **F-013. The relationships effect reads `catalog.graph` while the banner reads the quiet re-read's value (not reachable today).** `apps/desktop/src/metaproject/MetaprojectView.tsx` · review-logic · verifier: confirmed (site-check).

</details>

<details><summary><b>Verified clean</b></summary>

Each line is a hypothesis that was tested and did not hold, with what it rests on.

- A hide and show during a catalog read or a rebuild leaves a stale write: the generation guard drops a superseded read, the quiet flag is consumed by the run it was set for, and a rebuild that ends later takes the full path (review-highload, review-frontend, review-degradation; the test “a return during a rebuild”).
- The popover can still leave the window: its edge is bounded at `innerHeight − 8` on the side it takes and `.menu` scrolls inside (`styles.css:143`); the code's arithmetic reproduces the journal's measurements exactly (review-layout).
- The reordered `OpenSpecView.choose()` records the wrong offset: `navigate` → `enter` → `remember(leaving)` reads the pane's `scrollTop` synchronously, before `choose()` zeroes it (review-logic, review-regression, review-degradation).
- A stale `catalog.graph` in the relationships effect shows a graph that does not exist: a graph appearing or disappearing changes the snapshot id and takes the full reload (review-highload, review-logic, review-regression; kept as info F-013).
- The fix code reaches an HTML or path sink with new input: the lookup token only narrows which lookup may settle, the quiet read is the same read-only request, and the popover's inline styles are numbers set through a React style object (review-security-code).
- `slice-04` holds new behaviour: its hunks are removals against the merge-base that were already absent at round 1's head; only the `App.tsx` line that adds `visible` belongs to this round (review-regression, review-degradation, twelve reviewers in all, no finding).
- A new test would pass without its fix: every fix task showed its tests red against the previous production files in a scratch copy (flow journal, T17 to T20).

</details>

<details><summary><b>How this review was run</b></summary>

**Workflow:** `review-orchestrator`, managed round 2 of 5 for flow 515, mode `review-flow`, attended, delta round. `keryx review plan` built the package: 13 reviewers, 10 slices, 53 dispatches. The operator chose to run the 24 dispatches over `slice-03` and `slice-04` and confirmed the plan (`plan-confirmation.json`).

**Scope:** `60cbe1c565f4..b1538097e636`: `slice-03` (2,295 lines of diff: `App.tsx`, `MetaprojectView.tsx`, `NodeDetailsPanel.tsx`, `OpenSpecView.tsx`, `RelationshipList.tsx`, their six test files and the guide) and `slice-04`.

**Models:** by tier, the operator's answer at the start of round 1. Dispatched on the host aliases, whose exact model ids the host did not report: `sonnet` for 22 reviewer runs, `opus` for the two review-regression runs and the premise judge, `haiku` for the verifier. The orchestrator session is `claude-fable-5-2`.

**Tools:** reviewers read-only (`allowed_tools: read-only`, `exec_budget_s: 0`), except review-testing-practices (`run-tests`, 300 s), which ran its 34 mutants in its own scratch copy. The orchestrator ran `keryx review verify-run` and `keryx review mutate`.

**Skills:** review-architecture, review-clean-code, review-degradation, review-frontend, review-highload, review-layout, review-logic, review-performance, review-regression, review-security-code, review-style, review-testing-practices, review-ui-ux, review-verifier, review-premise.

**Subagents:** 24 reviewer runs, one of them resumed once for a follow-up question (review-logic on `slice-03`); 1 verifier run; 1 premise run.

**Scope-B screen:** review-regression reported F-002's defect first, at minor. `keryx review ingest` refuses a minor from the scope-B reviewer (`non-regression-severity`: a claim that the change broke existing behaviour names a trigger and an outcome, and so is major or above), and the reviewer asked for it to be filed under scope A instead of raising its severity. The orchestrator put the claim to review-logic as a scope-A question; review-logic traced it, confirmed it and filed it at minor (`research-evidence/followup-review-logic-w3.txt`). F-002 in this report is that finding.

**Operator answers:** F-005 was held by the premise judge (the repository already titles tests with the finding id they answer); asked through the host's question tool, the operator answered `dismiss`.

**Not run:**
- 29 of the 53 planned dispatches, by the operator's choice: 17 over `slice-01` and `slice-02` (the flow package's dispatch, resolved-context and result JSON of the fix tasks) and 12 second looks by review-logic and review-security-code at round 1's whole diff. Those slices are uncovered in this round.
- The native Tauri window and the Rust shell: no Rust toolchain on this machine.
- WebKit older than the one of macOS 26.7.3; the light theme with the popover open.
- Back in OpenSpec restoring the scroll, live: the project has no OpenSpec entries.
- The layout and UI/UX reviewers measured nothing themselves; their geometry statements rest on the orchestrator's measurements in the flow journal, and F-011 and F-012 are unmeasured.
- F-001 was not rendered live: none of this project's 129 wiki pages links to itself.
- Blast radius: 40 candidate files kept by the cap, 25 dropped by it and 1 by the pre-filter; the kept rows are text links, so the reviewers enumerated consumers by search instead.
- Token spend: no dispatch reported usage to the package.

**Stage counts:**

- pre-filter: files seen 39, retained 39, dropped 0; blocks 87 of 88 retained, 1 dropped (a comment-only line in `OpenSpecView.tsx`); changed lines retained 3654, dropped 1. These counts are of the whole delta; this round's reviewers read 2 of its 10 slices.
- verifier (`verification_mode: annotate`): claims received 13, applied 13, rejected 0, capped to unverifiable 0; confirmed 10, refuted 0, unverifiable 3 (F-002, F-011, F-012), unverified 0.
- retained: findings in 13, removed by the verifier 0, retained 13.
- findings cap: limit 10 per reviewer, truncated 0.
- scope B: on the first ingest of this round the screen refused 1 finding (review-regression's minor, `non-regression-severity`); it is in the record as F-002 under review-logic, so the final ingest counts scope-B findings 0, accepted 0, rejected 0, exempted 0.
- degradation evidence screen: screened 1, downgraded 0.
- premise: 8 upheld, 0 downgraded, 1 held (challenged, F-005), which the operator dismissed.
- dispatches: 24 of 53 run; 29 not run by the operator's choice.
- blast-radius chunk passes: none run in this round; 25 files the cap cut were not read (generated `calls.jsonl` files of earlier review packages among them).

## Review parity

- **Not run: 4 candidates: L3, V5, V6, V15.** They stay pending; a pass that runs them can still change a severity. They are round 1's mutants whose anchor a fix moved: L3's guard was removed with the self-loop fix, V5 and V6 were re-run on their new lines as R2-20 and R2-21 (both killed, `research-evidence/mutation-2.md`), and V15's new line (the popover's left clamp) was not re-mutated.

</details>

```json keryx:findings
[
 {
  "id": "F-001",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/RelationshipList.tsx",
  "line": null,
  "quote": "{projection.edges.length === 0 && <p className=\"metaproject-rel-note\">No relationships for these filters.</p>}",
  "problem": "Answering F-022, groupRelationships() now drops every self-loop (`if (edge.from === edge.to) continue;`), but the empty state still tests `projection.edges.length === 0`, the raw edge count. A projection whose only edges are self-loops (or edges with an end absent from the projection, which groupRelationships already dropped) has edges.length > 0 and groups that are all empty: no note, no group, an empty `<div class=\"metaproject-rel\">`. The same raw count feeds the Wiki disclosure label at MetaprojectView.tsx:925, `<summary>Relationships <span className=\"count-label\">{currentProjection.edges.length}</span></summary>`, so that label counts edges the list now omits. This is the F-022 class (a count that disagrees with the list beside it) at two sites the fix did not reach.",
  "impact": "Trigger: select a wiki page whose only relationship is a `links` edge to itself (the F-022 example), in Graph with the panel open on Relationships, or in Wiki. The panel's fact row says '0 incoming · 0 outgoing', the tab count is 0, and the tab body is blank with no explanation. In Wiki the disclosure reads 'Relationships 1' and opens onto nothing. Before the fix the self-loop row was listed, so the blank state is new. No data is lost; the user cannot tell whether the list failed to load.",
  "suggested_fix": "Decide the empty note from the groups, not the raw edges: `const empty = !groups.incoming.length && !groups.outgoing.length && !groups.secondStep.length;` and render the note when `empty`. In MetaprojectView.tsx show the disclosure and its count from `summarizeRelationships(currentProjection)` (incoming + outgoing), or from the same groups, not from `edges.length`.",
  "evidence": "Introduced or left by the fix that answered round 1's F-022. Checked by the orchestrator at head: the producer does emit the self edge. src/integrations/metaproject-explorer.ts:79 keeps a Markdown link with a file name and a fragment, and :159-163 pushes `{ from: page.node.id, to: found.id, kind: \"links\" }` without comparing the two ends, so a wiki page that links to a heading of its own file gets a `links` edge to itself. None of this project's 129 wiki pages has such a link (scanned with the producer's own link pattern), so the state was not rendered live. Normalisation notes: the same defect was raised by review-regression (review-regression-w3, F-001, minor); the same defect was raised by review-ui-ux (review-ui-ux-w3, F-001, minor).",
  "confidence": "high",
  "reviewer": "review-logic",
  "location_class": "in-diff",
  "class_scope": {
   "sites": [
    "apps/desktop/src/metaproject/RelationshipList.tsx:217",
    "apps/desktop/src/metaproject/MetaprojectView.tsx:923",
    "apps/desktop/src/metaproject/MetaprojectView.tsx:925"
   ],
   "enumeration_method": "keryx ctx rg for groupRelationships|summarizeRelationships over apps/desktop/src/metaproject excluding tests: callers are RelationshipList.tsx:76 (summarize), :210 (RelationshipList) and NodeDetailsPanel.tsx:199, all of which read the groups and so skip self-loops; then keryx ctx rg for `edges.length` in MetaprojectView.tsx and RelationshipList.tsx: two readers still use the raw count (RelationshipList.tsx:217 and MetaprojectView.tsx:923/925). Read from code, not run."
  }
 },
 {
  "id": "F-002",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "const generation = ++project.current;",
  "problem": "The quiet re-read added for F-004 goes through the catalog effect. On a hidden-to-visible change the visible effect (`if (!returned || !loaded.current) return; quietRead.current = true; setRevision(value => value + 1);`) bumps `revision`, a dependency of the catalog effect. React runs that effect's cleanup (`project.current++`) and then its body (`const generation = ++project.current;`), so project.current moves by two even when the re-read finds the same snapshotId and changes nothing. openPath captured `const generation = project.current;` and its `current()` requires `generation === project.current`; loadMoreSearch captured `const projectGeneration = project.current;` and checks `projectGeneration !== project.current` after its read (line 638) and in its catch (line 644). Both therefore see the guard fail and return. openPath has already cleared the unresolved message (`setUnresolvedLink(null)`), so no message is shown; loadMoreSearch appends nothing and sets no error. The unchanged-snapshot branch (`setFreshness(...); return;`) does not restore the counter. The other guards do not help: latestSearch.generation moves only when the query or catalog snapshotId changes (not here), and the token in openPath and shownSelection/activeMode all still match, so project.current is the only guard that fails.",
  "impact": "Trigger: click an unloaded Wiki link (a `search` read) or 'load more' in a protocol 2 search, leave the Metaproject view before the read resolves, and return before it resolves, which means within one local CLI read. The lookup does not open its target and the page of results is not appended, with no message, and the project did not change. The user clicks the link or the load-more control again: pageInFlight is cleared in `finally` and the cursor is unchanged, and openPath starts a new lookup. If the read resolves while the view is still hidden the guard passes and the result is applied as before. On base the explorer unmounted on leaving and dropped the same work, so this is not a regression against base. The same retirement already happens on a Refresh, a Rebuild or a catalog reload.",
  "suggested_fix": "Keep project.current for real project changes and give the quiet same-snapshot re-read its own counter: let the effect skip `++project.current` and the cleanup bump while `quiet` is set, guarding that read by a separate ref; or restore project.current in the unchanged-snapshot branch. Add a test that holds a wiki-link lookup, hides and shows the explorer, then releases it and checks the target opens.",
  "evidence": "Introduced or left by the fix that answered round 1's F-004. First raised by review-regression (slice-03) as its F-002, at minor; `keryx review ingest` refuses a minor from the scope-B reviewer (`non-regression-severity`), and that reviewer asked for it to be filed under scope A. The orchestrator put the claim to review-logic, which had read the same slice, as a scope-A question; its reply is research-evidence/followup-review-logic-w3.txt, and this finding is that reply. Against the base branch this is not a regression: there the explorer unmounted on leaving and dropped the same work; it is a defect of the fix round's own change, which kept the explorer mounted and then retired the work on return. Normalisation notes: the same defect was raised by review-regression (review-regression-w3, F-002, minor).",
  "confidence": "high",
  "reviewer": "review-logic",
  "location_class": "in-diff",
  "class_scope": {
   "sites": [
    "apps/desktop/src/metaproject/MetaprojectView.tsx:678-679 (openPath current())",
    "apps/desktop/src/metaproject/MetaprojectView.tsx:630,638,644 (loadMoreSearch)"
   ],
   "enumeration_method": "keryx ctx rg for `project\\.current|projectGeneration` in MetaprojectView.tsx: 18 matches; writers are the catalog effect (lines 367 and 398); readers that capture and compare are openPath and loadMoreSearch only; the remaining reads (lines 377, 392, 394) are the effect's own guards. The other in-flight reads (neighbors, documents, search effect, preview) are guarded by effect-local `active` flags and are not retired by the bump."
  }
 },
 {
  "id": "F-003",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "if (generation === project.current) setError(errMessage(cause));",
  "problem": "A failed quiet re-read on return shows the loud catalog error over a working explorer. The fix round added a quiet catalog re-read when the explorer becomes visible again (`quietRead.current = true; setRevision(...)`, lines 335-343). The load effect it reuses clears and sets `error` unconditionally: `setError(\"\")` at line 370 and `setError(errMessage(cause))` in the catch at line 392. On base nothing was read on return, so nothing could fail there. Trigger: the user leaves the Metaproject tab and comes back while the CLI read fails (CLI busy or exiting, a rebuild writing the index, a transient spawn error). Outcome: the `{error && ...role=\"alert\"}` banner (line 820) appears with the CLI message and a Retry button above an explorer whose catalog, graph and selection are still valid; Retry runs a non-quiet read, which replaces the catalog and may drop the selection if the snapshot moved. The quiet read was meant to be invisible (its comment says 'quietly'); only its success path is. The test at MetaprojectView.dom.test.tsx:889 covers the unchanged-snapshot success path only.",
  "impact": "not stated by the reviewer",
  "suggested_fix": "In the catch, when `quiet` is true, keep the loaded catalog and skip `setError` (and do not clear a standing error at line 370 for a quiet read); the next real read or the user's Retry reports a persistent failure.",
  "evidence": "consumer-trace: read MetaprojectView.tsx 326-343 (quietRead set on return), 365-400 (effect: `quiet` is read but only consulted on the success path at 379; the catch at 391-392 and `setError(\"\")` at 370 ignore it), 820-825 (banner). refute: looked for a guard on `quiet` in the catch or on `loaded.current` in the banner and found none; the base had no read on return, so this is new. Introduced or left by the fix that answered round 1's F-004. The other reviewers that read this path (review-frontend, review-highload, review-logic, review-ui-ux) describe the same behaviour as the existing error banner with Retry and did not file it. The T17 result file describes only the success paths of the re-read and says nothing about a failed one.",
  "confidence": "medium",
  "reviewer": "review-degradation",
  "location_class": "in-diff",
  "degradation_class": "behaviour-delta",
  "evidence_kind": "consumer-trace"
 },
 {
  "id": "F-004",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "for (const node of nodes) seenNodes.current.set(node.id, node);",
  "problem": "The fix for round-1 F-006 moved the node-memory fill into an effect and wrote the map write inline, while the `remember` helper declared three lines above (`const remember = (node: MetaprojectNode) => { seenNodes.current.set(node.id, node); };`) does the same write and is still used at line 603 (`if (node) remember(node);`). The same operation now has two spellings in one component.",
  "impact": "A reader must check that the inline write and `remember` are the same operation; a later change to what the memory stores (a cap, a copy) has to be made in both.",
  "suggested_fix": "Call the helper in the effect: `for (const node of nodes) remember(node);`.",
  "evidence": "keryx ctx rg 'remember' MetaprojectView.tsx --all: declaration at 569, one use at 603; effect body at 572 inlines the set. Convention: the Name row of .metaproject/rules/core/solid-principles.mdc (one concept, one name). Introduced or left by the fix that answered round 1's F-006. review-clean-code (slice-03) noted the same two spellings below its three-copy threshold and did not file it.",
  "confidence": "high",
  "reviewer": "review-style",
  "location_class": "in-diff"
 },
 {
  "id": "F-005",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/RelationshipGraph.dom.test.tsx",
  "line": null,
  "quote": "describe(\"RelationshipGraph viewport (F-012)\", () => {",
  "problem": "Fix-round bookkeeping is written into test names and comments: describe(\"... (F-012)\"), describe(\"... (F-013)\"), describe(\"... (F-013, AC6)\") in RelationshipGraph.dom.test.tsx:314/351/402, describe(\"layoutNeighborhood — review round 1 fixtures (F-021)\") in graphLayout.test.ts:508, the banner comment \"Test strength after review round 1 (T20)\" in MetaprojectView.dom.test.tsx:1019, and \"(second-step counts: F-007 test below)\" in NodeDetailsPanel.dom.test.tsx:119. The ids name findings of one review package and one flow task; finding ids restart per round (this round's reviewers number from F-001 again), and the package under .metaproject/reviews is a work record, not part of the source. The test titles say where a test came from, not what it pins.",
  "impact": "Cost: a later reader of the test report or of a failing test sees 'F-013' with no referent in the source tree, and the id can point at a different finding in another round. The AC6 reference is the only one that names something durable (the flow's acceptance criterion). No behaviour risk.",
  "suggested_fix": "Name the groups by behaviour (\"RelationshipGraph viewport\", \"RelationshipGraph interaction and styling\", \"layoutNeighborhood edge cases\") and drop the ids; in the NodeDetailsPanel comment say 'see the second-step test below'; keep AC6 if wanted. The finding-to-test mapping stays in the flow journal.",
  "evidence": "Introduced or left by the fix that answered round 1's F-011 to F-021. Checked by the orchestrator at head with `keryx ctx rg`: six places in four test files (RelationshipGraph.dom.test.tsx:314, :351, :402; graphLayout.test.ts:508; MetaprojectView.dom.test.tsx:1019; NodeDetailsPanel.dom.test.tsx:119).",
  "confidence": "medium",
  "reviewer": "review-clean-code",
  "location_class": "in-diff"
 },
 {
  "id": "F-006",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "if (needed > below && above > below) {",
  "problem": "Five gates of placeFiltersPopover and its resize cleanup are unpinned. Mutants run in a scratch copy, suite green: R2-2 (`needed > below` only: flips above although there is less room above), R2-4 (`Math.max(POPOVER_MARGIN, ...)` on bottom), R2-5 (`Math.min(MENU_MAX_HEIGHT, above)` -> `above`), R2-6/R2-7 (the `Math.max(0, ...)` floor and the MENU_MAX_HEIGHT cap below), R2-9 (the resize listener is never removed). The two placement tests drive only the two clean cases: content 0 px with room below (305/167), content 229 px with 14 px below and 418 above; no fixture has content too tall for below while above is smaller, a button within 4 px of the window bottom, a window taller than 420 px, or an unmount followed by a resize.",
  "impact": "The next edit to the placement can put the popover on the side with less room or let it run past the window edge, and a resize listener can leak, with all tests green. R2-8 and R2-1/R2-3/R2-10/R2-11 are killed, so the two main paths are pinned; the bounds are not.",
  "suggested_fix": "Add: stubPopoverContentHeight(500) with the button at top 250 / bottom 274 in a 480 window (more room below than above) and assert style.top and no style.bottom (R2-2); a window of 900 with the popover below asserts maxHeight 420 (R2-7); a button at top 478 asserts bottom 8 (R2-4); content 229 with a button at top 600 in a 700 window asserts maxHeight 420 (R2-5); spy on window.removeEventListener, unmount the view and assert a \"resize\" removal (R2-9).",
  "evidence": "mutants R2-2, R2-4, R2-5, R2-6, R2-7, R2-9 SURVIVED; R2-1, R2-3, R2-8, R2-10, R2-11 killed (table above). Gate added answering round-1 F-001 (review-layout). Introduced or left by the fix that answered round 1's F-001. The orchestrator re-ran the reviewer's 34 mutants through `keryx review mutate` with all six test files per mutant (research-evidence/mutation-2.md: 18 killed, 16 survived, 0 invalid); the killed and surviving ids are the ones this finding names.",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "location_class": "in-diff"
 },
 {
  "id": "F-007",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "if (quiet && result.snapshotId === loadedSnapshot.current) {",
  "problem": "The quiet catalog path added for round-1 F-004 is pinned by one fixture (same snapshot id, graph ready then stale) and one rebuild fixture. Surviving mutants: R2-16 (`if (quiet)`: a return after the project changed would drop the new catalog and only update freshness), R2-17 (no `setFreshness(null)` after a full load: a later full read of the same snapshot keeps showing the earlier quiet freshness), R2-18 (`freshness ?? catalog`: ignores the snapshot match in graphState), R2-19 (`quietRead.current` never reset: a later Retry or Rebuild read is treated as quiet), R2-14 (`!loaded.current` guard: a return while the first read is loading starts a second read), R2-26 (freshness reason read from the catalog, not graphState). No fixture returns to the view with a changed snapshot id, or follows a quiet read with a rebuild or Retry.",
  "impact": "Each gate is correct today; the first three decide whether the explorer shows current data after a return, and a regression in any is silent.",
  "suggested_fix": "Extend the 'shown again' test: a third read returns snapshotId \"two\" with new nodes, assert the list shows them (R2-16, R2-18); after the stale quiet read click Rebuild graph with a read returning graph ready and assert no 'Graph is stale' banner (R2-17, R2-19); count catalog reads for a return while the first read is pending (R2-14); open Details on the quiet-stale banner and assert the reason text (R2-26).",
  "evidence": "mutants R2-14, R2-16, R2-17, R2-18, R2-19, R2-26 SURVIVED; R2-15 and R2-25 killed. Introduced or left by the fix that answered round 1's F-004. The orchestrator re-ran the reviewer's 34 mutants through `keryx review mutate` with all six test files per mutant (research-evidence/mutation-2.md: 18 killed, 16 survived, 0 invalid); the killed and surviving ids are the ones this finding names.",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "location_class": "in-diff"
 },
 {
  "id": "F-008",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx",
  "line": null,
  "quote": "test(\"a render that changes no node list leaves the explorer's node memory alone\", async () => {",
  "problem": "The test asserts only `expect(writes).toBe(0)` after patching Map.prototype.set, with no positive artifact that the effect still fills the memory. Deleting the effect body (`for (const node of nodes) seenNodes.current.set(node.id, node);`, R2-23) leaves the suite green: writes are 0 either way. Only R2-24 (effect without its dependency) is killed. No other test reaches a node that exists only in seenNodes (a lookup result) through Back.",
  "impact": "The memory that makes Back show the panel of a looked-up node at once can be removed with all tests green. The test also patches a global prototype to observe an internal field.",
  "suggested_fix": "Open a wiki link whose target comes from a `search` hit that is not in the catalog, open another page, press Back and assert the target's panel title shows; and in the same test assert writes > 0 when the node list changes (for example a search that adds a hit).",
  "evidence": "mutant R2-23 SURVIVED; R2-24 killed. Fix answering round-1 F-006. Introduced or left by the fix that answered round 1's F-006. The orchestrator re-ran the reviewer's 34 mutants through `keryx review mutate` with all six test files per mutant (research-evidence/mutation-2.md: 18 killed, 16 survived, 0 invalid); the killed and surviving ids are the ones this finding names.",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "location_class": "in-diff"
 },
 {
  "id": "F-009",
  "severity": "minor",
  "file": "apps/desktop/src/App.tsx",
  "line": null,
  "quote": "<MetaprojectView cwd={cwd} visible={view === \"metaproject\"} onRebuild={rebuildGraph} onDraft={async task => {",
  "problem": "The one line that makes the fixes for round-1 F-003 and F-004 work in the app is unpinned: removing `visible={view === \"metaproject\"}` (R2-28) leaves every suite green, because the explorer tests pass `visible` themselves and App.dom.test.tsx renders only RetainedView. With the prop missing the default `true` applies and the popover stays open and the catalog is never re-read on return.",
  "impact": "A refactor of the composition root can silently undo both fixes.",
  "suggested_fix": "Cheapest: export a small wrapper or render App's work-view block in a DOM test with a stub MetaprojectView and assert it receives visible=false while another view is shown; or state in the flow that the wiring is covered by the live check only.",
  "evidence": "mutant R2-28 SURVIVED. Related, not a finding: R2-12 (drop `visible &&` from `const filters`) and R2-30 (delete the scrollTop line in OpenSpecView.choose()) also survive, but both are redundant behind the visible effect and the navigation hook's resetContent seed (a restored entry starts at 0 anyway): equivalent for every input a test can drive; the reorder R2-29 is killed. Introduced or left by the fix that answered round 1's F-003 and F-004. The orchestrator re-ran the reviewer's 34 mutants through `keryx review mutate` with all six test files per mutant (research-evidence/mutation-2.md: 18 killed, 16 survived, 0 invalid); the killed and surviving ids are the ones this finding names.",
  "confidence": "medium",
  "reviewer": "review-testing-practices",
  "location_class": "in-diff"
 },
 {
  "id": "F-010",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "const returned = visible && !wasVisible.current;",
  "problem": "Every hidden-to-shown change of the explorer starts one catalog read (one `metaproject_request` invoke, one CLI process per request in platform/metaproject.ts:57) with no coalescing and no cancellation. A read that a later return supersedes is dropped by the generation guard (`generation !== project.current`), but its process still runs to completion. This answers round-1 F-004 (stale catalog on return).",
  "impact": "Trigger: a user pressing the Metaproject and Flows shortcuts back and forth N times in a row. That is N catalog reads, N-1 of them with discarded results. The load is user-paced and bounded by key repeat; the cost of one catalog read (graph freshness check plus a catalog of up to the contract's node cap) was not measured here. No data is lost and no state is wrong; this is waste only, which is why it is info.",
  "suggested_fix": "Optional: skip the quiet read when the previous catalog read finished less than a few seconds ago (keep a timestamp next to `loaded`), or leave it as is and accept the cost.",
  "evidence": "Introduced or left by the fix that answered round 1's F-004.",
  "confidence": "low",
  "reviewer": "review-highload",
  "location_class": "in-diff"
 },
 {
  "id": "F-011",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "const place = () => setPosition(placeFiltersPopover(anchor.getBoundingClientRect(), panel.current?.scrollHeight ?? 0));",
  "problem": "UNVERIFIED (derived from code and the journal's numbers). The popover is placed on open and on window resize only, from the content height at that moment. The footer `{filtersChanged && (<div className=\"menu-footer metaproject-filters-pop-footer\">` adds a Reset filters row the first time Direction, Depth or a type chip is changed while the popover is open. Case 720x480, one-line banner, Chromium 156 as measured in the journal: placed below, top 229, content 229, max-height 243 (= 480 - 8 - 229). A Reset row of roughly 30 to 40 px (not measured) makes the content about 260 to 270, above the 243 cap, so the popover gains an inner scroll on the first filter change and Reset filters sits below the fold of the popover. The popover itself stays inside the window (the cap holds), so this is not the F-001 defect; it is the same shape with a smaller amount, reachable by scrolling inside the popover.",
  "impact": "At the smallest window, with the one-line banner, the first change of a filter makes the popover scroll and moves Reset filters out of sight until the user scrolls it. Recoverable; the controls stay in the window. With Details expanded the popover opens above with 319 px of room, so the added row fits there.",
  "suggested_fix": "Either re-place on content change (a ResizeObserver on the popover content that calls place()), or count the footer in the height used for the flip (always render the footer row, disabled when nothing changed). To settle it: browser dev build at 720x480, one-line banner, open Filters, change Direction, read clientHeight and scrollHeight of [role=dialog][aria-label=\"Graph filters\"] and the Reset filters button's getBoundingClientRect().bottom against 472.",
  "evidence": "Introduced or left by the fix that answered round 1's F-001.",
  "confidence": "low",
  "reviewer": "review-layout",
  "location_class": "in-diff"
 },
 {
  "id": "F-012",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "window.addEventListener(\"resize\", place);",
  "problem": "UNVERIFIED (derived from code; the T17 worker lists it under noticed_not_touched). Nothing places the popover again when the page or the content pane scrolls under its button, when the freshness banner changes height (Details toggled while the popover is open is a press outside, so it closes it; a catalog or banner update that arrives while it is open is not), or when the explorer layout changes without a window resize. The popover is position: fixed with the coordinates of the open moment, so it stays inside the window (its edge and max-height were computed against window.innerHeight) but no longer sits against its button.",
  "impact": "A wheel or keyboard scroll of .metaproject-content with the popover open leaves the popover where it was while the button moves (and may leave the window). No clipping of the popover, so not F-001; a detached popover only.",
  "suggested_fix": "Listen for scroll with capture (window.addEventListener(\"scroll\", place, true)) and re-place, or close the popover on scroll of an ancestor. To settle it: at 720x480 with Details expanded, open the popover, scroll .metaproject-content by 40 px and compare the dialog's bottom with the button's top.",
  "evidence": "Introduced or left by the fix that answered round 1's F-001. First recorded by the T17 worker under noticed_not_touched (results/T17.result.json); review-ui-ux and review-logic (slice-03) describe the same narrow case without filing it.",
  "confidence": "low",
  "reviewer": "review-layout",
  "location_class": "in-diff"
 },
 {
  "id": "F-013",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "if (catalog.graph === \"missing\" && protocol !== 2) return;",
  "problem": "Two readers of the graph state now use different sources. The relationships effect (lines 488 and 496) reads `catalog.graph` and `catalog.truncated`; the freshness banner, `showGraph` (line 704), `onDraft` (line 959) and `freshnessOpen` read `graphState`, which takes the quiet re-read's value while its snapshotId equals the catalog's. They can differ only if a quiet re-read returns the same snapshotId with a different `graph` value.",
  "impact": "Not reachable through the producer as read: src/integrations/metaproject-explorer.ts:174 hashes nodes, edges, page digests and the stat of symbols.jsonl, calls.jsonl and wiki-pages.jsonl into snapshotId, and explorerGraphFreshness (line 208) says freshness never contributes. A flip to or from 'missing' changes the graph-derived nodes or the layer files, hence the snapshotId, and takes the full path (setCatalog, setFreshness(null)). Only a graph with no files, no edges and no layer files would keep the id. Only 'stale', 'ready' and 'unknown' can differ with the same id, and none of those is read at line 496. If it did happen (protocol 1, catalog 'missing', quiet 'ready'), the graph slot would say a graph exists while no relationships read was ever started. Noted so the next edit that reads `catalog.graph` for a decision picks the right source.",
  "suggested_fix": "Use `graphState?.graph` at line 496, or add a comment there that only a snapshot change can leave 'missing'.",
  "evidence": "Introduced or left by the fix that answered round 1's F-004. review-highload and review-regression (slice-03) reached the same conclusion: not reachable, because a graph appearing or disappearing changes the snapshot id.",
  "confidence": "low",
  "reviewer": "review-logic",
  "location_class": "in-diff"
 }
]
```

## Token spend

token spend: unknown (24 dispatch(es), none reported usage)

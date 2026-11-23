**Changes requested — 0 Blocker, 0 Major, 8 Minor.** Fix round 2 closed seven of the eight findings it answered against the code and left one small behaviour defect of its own; the rest of this round's minors are gaps in the new tests and three inaccuracies in the flow's record. Nothing found here loses data, crashes or breaks an acceptance criterion.
Reviewed `b1538097e636..8e0f656fb2aa` (the three commits of fix round 2) · round 3 of the flow · both slices of the range: `slice-02` (code and tests) and `slice-01` (the flow's record) · CI not consulted (the target is a branch, not a pull request).
Evidence level: ran — `bun test` on the impacted test files (one process per file, all pass), `keryx review mutate` over round 2's 34 mutants on this head (28 killed, 3 survived, 3 invalid because a fix moved the line; the three moved ones re-run on their new lines and killed), `keryx review mutate` over the 20 mutants review-testing-practices proposed for this slice (6 killed, 14 survived, 0 invalid), and, before the round, the type check, the whole desktop suite (922 pass), the Vite build and a live check in the browser dev build (one `catalog` request on return, no alert, the Filters popover closing on leaving the view). Did not run: the native Tauri window (no Rust toolchain on this machine), WebKit older than macOS 26, and the three cases that rest on DOM tests only (a wiki page that links to itself, a failed quiet re-read, a lookup in flight across leaving and returning).

This verdict is interim until the operator closes the round.

### How this round is placed among the others

The review tool takes a round as the previous one only when it was run over its whole plan or closed by the operator. Round 2 ran, by the operator's choice, on 24 of its 53 dispatches and is not closed, so the tool would have planned this round as a delta over round 1's head: 55 dispatches re-reading the fixes round 2 had already reviewed. The orchestrator started this package over the range since round 2's head instead (`keryx review start --no-prior-round --base b1538097e636`), which the tool records as a first round, and attached round 2's findings to the code slice itself. The dispositions below are therefore the reviewers' and the orchestrator's, not the tool's ledger.

### Dispositions of round 2's findings

Judged against the code at this head, not against the commit messages. The ids in this list are round 2's.

- **F-001: closed.** review-logic, review-regression and review-ui-ux (owners), and seven more reviewers. Every reader of a relationship count or an emptiness test now uses the grouping rule; two tests pin it. Its tests have gaps: this round's F-002 and F-003.
- **F-002: closed.** review-logic and review-regression (owners), review-highload with every interleaving traced. A quiet re-read no longer moves `project.current`; two tests pin it, and the run that put the production files back reproduced the defect. The opposite direction is unpinned: this round's F-004.
- **F-003: regressed.** review-degradation (owner) calls it closed, review-logic partial. The error banner on a failed quiet re-read is gone and pinned by three tests; the same fix left a catalog-read error standing after a later successful quiet re-read: this round's F-001.
- **F-004: closed.** review-style (owner). The effect calls `remember`, a stable callback; no inlined copy remains.
- **F-005: withdrawn.** Dismissed by the operator in round 2: the repository titles tests with the finding id they answer.
- **F-006: closed.** review-testing-practices (owner), review-layout by recomputing each placement test by hand. Mutants R2-2, R2-4, R2-5, R2-6, R2-7 and R2-9 are killed.
- **F-007: closed.** review-testing-practices (owner). R2-16, R2-17, R2-19 and R2-26 are killed, R2-14 on the line T22 moved it to; R2-18 is equivalent (the reviewer checked it: `freshness` is null or belongs to the loaded snapshot in every reachable state).
- **F-008: closed.** review-testing-practices (owner). R2-23 and R2-24 are killed on the lines T22 moved them to.
- **F-009: partial.** review-testing-practices (owner). The `visible` the explorer is given is pinned (R2-28 killed); the wrapper's hidden state under Settings, the default explorer and the call site are not: this round's F-005.
- **F-010: open.** Info, below the fix threshold; not changed. A return while a catalog read is in flight now starts no second read.
- **F-011: open.** Info, below the fix threshold; not changed.
- **F-012: open.** Info, below the fix threshold; not changed.
- **F-013: open.** Info, below the fix threshold; not changed.

## Regressions the fixes introduced

- **[F-001]** answering round 2's F-003: A catalog-read error banner stays after a later quiet re-read has succeeded. A quiet re-read was told to leave the error banner alone in both directions, and the banner holds two different failures in one state: a failed rebuild, which should stay, and a failed catalog read, which a later successful read contradicts.

### Minor

**F-001. A catalog-read error banner stays after a later quiet re-read has succeeded.** `apps/desktop/src/metaproject/MetaprojectView.tsx` · raised by review-logic · from round 2's F-003 · verifier: confirmed (site-check), premise: upheld.
Answering round 2's F-003, a quiet re-read neither clears `error` at its start (`if (!quiet) { project.current++; setError(""); }`) nor sets it on failure. The `error` state holds two unrelated things: a failed catalog read and a failed rebuild (rebuild() sets it at line 677). Keeping it across a quiet read is right for the rebuild failure, which the test 'a standing error, such as a failed rebuild's, survives a quiet re-read on return' pins.
Impact: Trigger: a catalog read the user started fails after a first success (Retry, Refresh catalog, or the reload after a successful rebuild; `loaded.current` stays true and `catalogPending` is reset in `finally`), the banner 'The index is being written.' with Retry shows, the user leaves the view and returns once the CLI works.
Fix: Record where the standing error came from (a `catalogFailed` ref or a field on the error state: 'catalog' or 'rebuild'). On a successful quiet read, clear the error only when it came from a catalog read; leave a rebuild error. Add a test: reload fails, hide and show with a working read, expect no catalog error banner.

**F-002. The list's `empty` test is pinned on one side only: two mutants of it survive.** `apps/desktop/src/metaproject/RelationshipList.tsx` · raised by review-testing-practices · from round 2's F-001 · verifier: confirmed (execution), premise: upheld.
The `empty` test T22 added (answering F-001 of round 2) is pinned on one side only. Mutants run in a scratch copy of apps/desktop at 8e0f656fb, tests RelationshipList.dom.test.tsx and MetaprojectView.dom.test.tsx (baseline exit 0): R3-9 (`&&` -> `||`, so the note shows whenever any one group is empty) SURVIVED; R3-7 (the `!groups.secondStep.length` term dropped, so a projection with only second-step rows says 'No relationships') SURVIVED; R3-8 (back to `projection.edges.length === 0`) killed by 'a projection whose every edge is left out says it has no relationships'.
Impact: A later edit of the condition keeps both RelationshipList and the Wiki disclosure green while showing 'No relationships for these filters.' above a populated list. No runtime defect today: the gate is correct.
Fix: In RelationshipList.dom.test.tsx add a projection with incoming rows only (outgoing empty) and one with a single second-step edge and no adjacent edge; assert the note is absent and the matching group heading present.

**F-003. The Wiki disclosure's count has no fixture with a second-step row.** `apps/desktop/src/metaproject/MetaprojectView.tsx` · raised by review-testing-practices · from round 2's F-001 · verifier: confirmed (execution), premise: upheld.
The Wiki disclosure's count, which the comment above it says 'counts the rows its list shows', is pinned for incoming/outgoing rows only. R3-4 (`+ wikiRelationships.secondStep` dropped from the sum) SURVIVED the MetaprojectView and RelationshipList DOM tests. The fixtures in 'a Wiki page's Relationships disclosure counts the rows its list shows, and a self-link alone shows none' carry a self-link and one root-adjacent `describes` edge; none carries a second-step edge, so the list's 'Second step N' group and the label can disagree unseen.
Impact: Round 2's F-001 was a count that disagreed with the list beside it; the secondStep term is the one place where that can recur without a failing test.
Fix: Add a second-step edge between two non-root nodes to the second `readWith` in that test and assert the label is '2' with 'Second step' group rows present.

**F-004. Nothing pins that a read which is not quiet still retires pending lookups and pages.** `apps/desktop/src/metaproject/MetaprojectView.tsx` · raised by review-testing-practices · from round 2's F-002 · verifier: confirmed (execution), premise: upheld.
T22 split `project.current` so that only a non-quiet catalog read retires pending wiki-link lookups and pages of results. The tests added pin the new direction (a quiet read must not retire: T23-1 and T23-5 killed by 'a wiki-link lookup in flight ... still settles' and 'a page of results in flight ... is still appended') but nothing pins the old direction, that a real read still retires them. In the scratch copy: R3-20 (cleanup bump removed: `if (!quietRead.current) project.current++;` -> ``) SURVIVED all of MetaprojectView.dom.test.tsx (exit 0);
Impact: The counter that T22 re-wired, and its two readers, can be deleted or broken with the suite green: a lookup begun before a Refresh would then apply after it. No defect today; the next editor of this counter is unprotected in exactly the direction round 2's F-002 was about.
Fix: Hold a wiki-link lookup (as the T23 lookup test does), click Refresh catalog (or Rebuild with onRebuild returning true), release the lookup, and assert its target does not open and no 'No indexed project file' message shows; the same for a held load-more page.

**F-005. The `MetaprojectWork` test pins the `visible` prop and nothing else of the wiring.** `apps/desktop/src/App.dom.test.tsx` · raised by review-testing-practices · from round 2's F-009 · verifier: confirmed (execution), premise: upheld.
The stand-in explorer pins `visible` handed to the explorer, and nothing else of MetaprojectWork, so the test would pass if MetaprojectWork stopped rendering the real explorer in the app. Mutants in a scratch copy, App.dom.test.tsx (baseline exit 0): R3-14 (default `explorer = LazyMetaprojectView` -> a component returning null) SURVIVED; R3-13 (ProjectWindow's `<MetaprojectWork cwd={cwd} view={view} workView={workView}` -> `view={workView}`) SURVIVED, since no test renders ProjectWindow;
Impact: F-009 asked that the `visible` wiring be pinned; the prop is, but the wrapper's own hidden state under Settings, the app's call site and the default explorer are covered by the live check only. The hidden-under-Settings case is the one the test's own last step names.
Fix: In the Settings step add `expect(host.querySelector("p")?.closest("[hidden]")).not.toBeNull()` (kills R3-10). For the default explorer, render MetaprojectWork once without `explorer` and assert the Suspense fallback 'Loading Metaproject…' shows (kills R3-14 and R3-16 without a module mock). The call-site mutant R3-13 needs either a test of ProjectWindow or stating that it rests on the live check.

**F-006. `tasks.md` still gives T4 the dependencies it had before T22 and T23.** `.metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/tasks.md` · raised by review-logic · from the flow record of fix round 2 · verifier: confirmed (site-check), premise: upheld.
The task table was extended for T22 and T23 (two new rows, a Review paragraph and a Fix round 2 section) but the T4 row was not updated. flow.json at head has T4 dependsOn [T8, T9, T10, T11, T14, T15, T16, T17, T18, T19, T20, T21, T22, T23] (set by the history event 'task-depends-set: T4: dependsOn ... T22, T23 — the review task closes after fix round 2 (T22, T23) and a clean round'). tasks.md says T4 waits for T21 only.
Impact: Whoever reads tasks.md to see what must finish before the review task closes is told T21; flow.json, which the CLI enforces, also holds the review back until T22 and T23 are done. The two records of the same dependency disagree in the file a human opens first.
Fix: Change the T4 row's dependency cell to 'T8, T9, T10, T11, T14, T15, T16, T17, T18, T19, T20, T21, T22, T23'.

**F-007. The journal says mutant checks passed and names no script; the scripts are in a session scratch directory.** `.metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/journal.md` · raised by review-logic · from the flow record of fix round 2 · verifier: confirmed (site-check), premise: upheld.
The journal's T23 acceptance entry says R2-14 and R2-23 'killed on their new lines' and five of T22's branches 'killed' by 'the orchestrator's own script' and names no script. The result file names it as 'own_mutants.py (scratchpad)'; the dispatch files name scratch_check2.py by an absolute path under /private/tmp/claude-502/.../scratchpad/. Neither script is a tracked file (git ls-files finds neither); they exist only in one session's temporary directory. The mutants themselves (anchor and replacement for R2-14, R2-23 and T23-1..T23-5) are written nowhere in the record.
Impact: A statement that something was verified has to name what verified it, so the next editor can run it again. Here the claim 'all killed' for the branches T22 added (the branches whose tests T23 chose not to add: 'No T22 branch survived, so no test was added for them') cannot be re-run from the repository; the next reviewer re-derives the mutants from prose.
Fix: In the T23 entry, name the script and where it is kept (or write the seven mutants, file:line and replacement, into the entry or into a tracked file next to it); in the T22 entry name scratch_check2.py red with its --restore arguments. Or say the runs rest on the worker's report.

**F-008. A result file names “F-005” without saying which round's finding it means.** `.metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/results/T22.result.json` · raised by review-style · from the flow record of fix round 2 · verifier: confirmed (site-check), premise: upheld.
The same `notes` string uses round 2's ids for the four findings it answers (F-001 to F-004) and here F-005 for round 1's finding (Wiki-link lookups settled by arrival order; the dispatch says 'round 1's F-005 rule'). Round 2 also has an F-005, the one the operator dismissed ('finding ids in test names', named in tasks.md and in the journal). The sentence does not say which round it means, and no id in this file is marked with its round.
Impact: A later reader who looks up F-005 in the round-2 package finds the dismissed test-naming finding and reads 'untouched' as a statement about it; the actual guard (the lookup token of round 1's F-005 in `openPath`) is not found from the sentence.
Fix: Write 'round 1's F-005 token rule in openPath (lookup.current) is untouched', as the dispatch does.

<details><summary><b>Info (kept in the record, not published as findings)</b></summary>

- **F-009. A quiet re-read that fails is never reported.** `apps/desktop/src/metaproject/MetaprojectView.tsx` · review-degradation · verifier: confirmed (site-check).
- **F-010. The “Project knowledge changed while loading” banner can show for a catalog that was already replaced.** `apps/desktop/src/metaproject/MetaprojectView.tsx` · review-ui-ux · verifier: unverifiable (site-check).
- **F-011. The effect's cleanup reads the next run's flag, and its comment does not say so.** `apps/desktop/src/metaproject/MetaprojectView.tsx` · review-clean-code · verifier: confirmed (site-check).
- **F-012. The sum incoming + outgoing + second-step is written in two files.** `apps/desktop/src/metaproject/MetaprojectView.tsx` · review-clean-code · verifier: confirmed (site-check).
- **F-013. The placement tests pin arithmetic on inputs a real layout may not produce (not measured).** `apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx` · review-layout · verifier: unverifiable (site-check).
- **F-014. The graph legend reads raw edges, so a self-link alone still lists its line style.** `apps/desktop/src/metaproject/graphLayout.ts` · review-logic · verifier: confirmed (site-check).
- **F-015. Mutants of code T22 added carry the ids T23-1 to T23-5.** `.metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/results/T23.result.json` · review-style · verifier: confirmed (site-check).

</details>

<details><summary><b>Verified clean</b></summary>

Each line is a hypothesis that was tested and did not hold, with what it rests on.

- The two counters or the pending flag leave a read applied twice, dropped wrongly or a flag stuck: review-highload traced seven interleavings (a return during the first read, two returns before a quiet read ends, a rebuild ending during a quiet read, Retry during a quiet read, a changed snapshot with a lookup in flight, a failed quiet read, an unmount) and found each outcome sound; review-degradation traced every exit of the effect for `catalogPending`.
- The cleanup reads a stale quiet flag: the visible effect sets it in the commit that changes `visible`, and the catalog effect's cleanup runs in the next commit, before its body resets it; StrictMode's double invocation runs on mount only, where the flag is false (review-frontend).
- The new component remounts the explorer or changes the DOM a stylesheet depends on: `MetaprojectWork` and the lazy explorer are module-level, and it renders the same three nested nodes with no added element (review-frontend, review-layout, review-regression).
- A consumer of a changed name gets something else: review-regression walked `project.current`, `catalogRead`, `catalogPending`, `quietRead`, `error`, `remember`, `summarizeRelationships` and everything that imports `App.tsx`, and found none.
- The two choices taken without the operator leave wrong state: review-logic and review-highload judged both defensible defaults; the first costs one click in a narrow overlap (kept as info F-010).
- The new memo or the extra component adds a render cost: the memo's dependencies are stable and it runs once per projection change (review-performance).
- New input reaches a sink: the swallowed quiet failure is local CLI output, the lookup still compares snapshot ids, and `explorer` is a component reference set in source (review-security-code).
- A test of the two tasks would pass without its fix: seven of T22's tests are red against round 2's production files, and each mutant T23 answered is killed by a named test (`research-evidence/mutation-1.md`, `moved-mutants-2.txt`).

</details>

<details><summary><b>How this review was run</b></summary>

**Workflow:** `review-orchestrator`, managed round 3 of 5 for flow 515, mode `review-flow`, attended. The package was started over the range since round 2's head, then `keryx review scope`, `blast-radius`, `slice` and `required --depth auto --style`: 13 reviewers, 2 slices, 15 dispatches, within the operator threshold, so no plan confirmation was needed. All 15 ran.

**Scope:** `b1538097e636..8e0f656fb2aa`: 17 files, 1,316 changed lines. `slice-02` (59 KB): `App.tsx`, `MetaprojectView.tsx`, `RelationshipList.tsx` and their three test files. `slice-01` (125 KB): the flow package's dispatch, request, resolved-context and result files of T22 and T23, `flow.json`, `journal.md`, `tasks.md`.

**Models:** by tier, the operator's answer at the start of round 1. Dispatched on the host aliases, whose exact model ids the host did not report: `sonnet` for 14 reviewer runs, `opus` for review-regression and the premise judge, `haiku` for the verifier. The orchestrator session is `claude-fable-5-2`.

**Tools:** reviewers read-only (`allowed_tools: read-only`, `exec_budget_s: 0`), except review-testing-practices (`run-tests`, 300 s), which ran its 20 mutants in its own scratch copies. The orchestrator ran `keryx review verify-run` and `keryx review mutate`.

**Skills:** review-architecture, review-clean-code, review-degradation, review-frontend, review-highload, review-layout, review-logic, review-performance, review-regression, review-security-code, review-style, review-testing-practices, review-ui-ux, review-verifier, review-premise.

**Subagents:** 15 reviewer runs, 1 verifier run, 1 premise run.

**Not run:**
- The native Tauri window and the Rust shell: no Rust toolchain on this machine.
- WebKit older than the one of macOS 26.7.3.
- Live: a wiki page that links to itself (the project has none), a failed quiet re-read, a lookup in flight across leaving and returning, and the stale error banner of F-001.
- The layout and UI/UX reviewers measured nothing themselves; F-013 is unmeasured.
- Blast radius: the record fell back to whole-file edges for the changed code files and dropped 49 text-hub files (flow and docs records) and one test consumer; review-regression enumerated consumers by search instead.
- Token spend: no dispatch reported usage to the package.

**Stage counts:**

- pre-filter: files seen 17, retained 17, dropped 0; blocks 45 of 47 retained, 2 dropped (comment-only lines in `MetaprojectView.tsx`); changed lines retained 1316, dropped 5.
- verifier (`verification_mode: annotate`): claims received 15, applied 15, rejected 0, capped to unverifiable 0; confirmed 13 (4 by the recorded mutation run, 9 by site check), refuted 0, unverifiable 2 (F-010, F-013), unverified 0.
- retained: findings in 15, removed by the verifier 0, retained 15.
- findings cap: limit 10 per reviewer, truncated 0.
- scope B: scope-B findings 0, accepted 0, rejected 0, exempted 0 (review-regression filed none).
- degradation evidence screen: screened 1, downgraded 0.
- premise: 8 upheld, 0 downgraded, 0 held.
- dispatches: 15 of 15 run; the research ledger is READY.
- blast-radius chunk passes: none run.

</details>

```json keryx:findings
[
 {
  "id": "F-001",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "setFreshness({ snapshotId: result.snapshotId, graph: result.graph, graphReason: result.graphReason });",
  "problem": "Answering round 2's F-003, a quiet re-read neither clears `error` at its start (`if (!quiet) { project.current++; setError(\"\"); }`) nor sets it on failure. The `error` state holds two unrelated things: a failed catalog read and a failed rebuild (rebuild() sets it at line 677). Keeping it across a quiet read is right for the rebuild failure, which the test 'a standing error, such as a failed rebuild's, survives a quiet re-read on return' pins. For a catalog-read failure it is wrong: a quiet read that succeeds has just shown that the catalog can be read, and neither of its success branches (the unchanged-snapshot branch above, or `setCatalog(result)` below it) touches `error`.",
  "impact": "Trigger: a catalog read the user started fails after a first success (Retry, Refresh catalog, or the reload after a successful rebuild; `loaded.current` stays true and `catalogPending` is reset in `finally`), the banner 'The index is being written.' with Retry shows, the user leaves the view and returns once the CLI works. The quiet read succeeds, replaces the catalog if the snapshot moved or updates the freshness line if not, and the failure banner stays above the fresh data. The user must click Retry, which runs a loud read and retires pending lookups and pages (project.current moves). No data is lost and nothing else is wrong; the cost is a banner that says the read failed over a catalog that has since been read.",
  "suggested_fix": "Record where the standing error came from (a `catalogFailed` ref or a field on the error state: 'catalog' or 'rebuild'). On a successful quiet read, clear the error only when it came from a catalog read; leave a rebuild error. Add a test: reload fails, hide and show with a working read, expect no catalog error banner.",
  "evidence": "Read MetaprojectView.tsx 371-416 (effect), 671-681 (rebuild sets the same `error`), 842-847 (one banner for both). keryx ctx rg for `setError|error &&` in MetaprojectView.tsx: writers at 378 (loud read start), 403 (catch, loud only), 673 and 677 (rebuild); no writer on a successful quiet read. Introduced by the fix that answered round 2's F-003; the test 'a return after a failed first catalog read starts no read, and its failure and Retry stay' covers loaded.current === false, not a failed reload after a first success. Not run: the tool limits forbid it; read from code. Introduced or left by the work that answered round 2's F-003. review-degradation files the same outcome as part (b) of its info finding, and review-regression and review-highload describe it without filing it. It follows from the finish line the orchestrator gave task T22 for round 2's F-003 (a quiet re-read neither shows nor clears the error banner), which did not tell a failed catalog read from a failed rebuild; the T22 worker implemented that line as written, and one test pins the rebuild case. Normalisation notes: the same defect was raised by review-frontend (review-frontend-w1, F-001, minor); the same defect was raised by review-ui-ux (review-ui-ux-w1, UX-001, minor).",
  "confidence": "medium",
  "reviewer": "review-logic",
  "location_class": "in-diff"
 },
 {
  "id": "F-002",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/RelationshipList.tsx",
  "line": null,
  "quote": "const empty = !groups.incoming.length && !groups.outgoing.length && !groups.secondStep.length;",
  "problem": "The `empty` test T22 added (answering F-001 of round 2) is pinned on one side only. Mutants run in a scratch copy of apps/desktop at 8e0f656fb, tests RelationshipList.dom.test.tsx and MetaprojectView.dom.test.tsx (baseline exit 0): R3-9 (`&&` -> `||`, so the note shows whenever any one group is empty) SURVIVED; R3-7 (the `!groups.secondStep.length` term dropped, so a projection with only second-step rows says 'No relationships') SURVIVED; R3-8 (back to `projection.edges.length === 0`) killed by 'a projection whose every edge is left out says it has no relationships'. No fixture builds a projection that has rows in some groups but not in others and asserts the note is absent; the only 'not empty' fixtures have all three groups filled. R3-7 is not equivalent: groupRelationships (RelationshipList.tsx:54-62) puts an edge between two non-root nodes into secondStep, so a projection with no root-adjacent edge and one such edge lists a row.",
  "impact": "A later edit of the condition keeps both RelationshipList and the Wiki disclosure green while showing 'No relationships for these filters.' above a populated list. No runtime defect today: the gate is correct.",
  "suggested_fix": "In RelationshipList.dom.test.tsx add a projection with incoming rows only (outgoing empty) and one with a single second-step edge and no adjacent edge; assert the note is absent and the matching group heading present.",
  "evidence": "Mutation: R3-9 and R3-7 survived (anchor `const empty = ...`, replacement as above); R3-8 killed. Same gate class as round 2's F-001, which the fix pinned only on the all-empty side. Introduced or left by the work that answered round 2's F-001. The orchestrator re-ran the reviewer's 20 mutants through `keryx review mutate` with all six test files per mutant (research-evidence/mutation-2.md: 6 killed, 14 survived, 0 invalid); the killed and surviving ids are the ones this finding names.",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "location_class": "in-diff"
 },
 {
  "id": "F-003",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "const wikiRelationshipRows = wikiRelationships ? wikiRelationships.incoming + wikiRelationships.outgoing + wikiRelationships.secondStep : 0;",
  "problem": "The Wiki disclosure's count, which the comment above it says 'counts the rows its list shows', is pinned for incoming/outgoing rows only. R3-4 (`+ wikiRelationships.secondStep` dropped from the sum) SURVIVED the MetaprojectView and RelationshipList DOM tests. The fixtures in 'a Wiki page's Relationships disclosure counts the rows its list shows, and a self-link alone shows none' carry a self-link and one root-adjacent `describes` edge; none carries a second-step edge, so the list's 'Second step N' group and the label can disagree unseen. Killed for contrast: R3-2 (condition back to `currentProjection.edges.length > 0`), R3-3 (label back to `edges.length`), R3-5 (`> 0` -> `>= 0`). R3-6 (drop `mode === \"wiki\" &&` in the memo) survived and is equivalent: the value is read only inside the Wiki branch.",
  "impact": "Round 2's F-001 was a count that disagreed with the list beside it; the secondStep term is the one place where that can recur without a failing test.",
  "suggested_fix": "Add a second-step edge between two non-root nodes to the second `readWith` in that test and assert the label is '2' with 'Second step' group rows present.",
  "evidence": "Mutation R3-4 survived; R3-2, R3-3, R3-5 killed. Introduced or left by the work that answered round 2's F-001. The orchestrator re-ran the reviewer's 20 mutants through `keryx review mutate` with all six test files per mutant (research-evidence/mutation-2.md: 6 killed, 14 survived, 0 invalid); the killed and surviving ids are the ones this finding names.",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "location_class": "in-diff"
 },
 {
  "id": "F-004",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "if (!quietRead.current) project.current++;",
  "problem": "T22 split `project.current` so that only a non-quiet catalog read retires pending wiki-link lookups and pages of results. The tests added pin the new direction (a quiet read must not retire: T23-1 and T23-5 killed by 'a wiki-link lookup in flight ... still settles' and 'a page of results in flight ... is still appended') but nothing pins the old direction, that a real read still retires them. In the scratch copy: R3-20 (cleanup bump removed: `if (!quietRead.current) project.current++;` -> ``) SURVIVED all of MetaprojectView.dom.test.tsx (exit 0); R3-19 (the `project.current++;` inside `if (!quiet) {` removed) SURVIVED (exit 0); R3-17 (`generation === project.current &&` dropped from openPath's `current()`) and R3-18 (`projectGeneration !== project.current` replaced by `false` in loadMoreSearch) SURVIVED (exit 0). No test starts a lookup or a load-more, then runs Refresh, Retry or Rebuild, and asserts the late answer is dropped.",
  "impact": "The counter that T22 re-wired, and its two readers, can be deleted or broken with the suite green: a lookup begun before a Refresh would then apply after it. No defect today; the next editor of this counter is unprotected in exactly the direction round 2's F-002 was about.",
  "suggested_fix": "Hold a wiki-link lookup (as the T23 lookup test does), click Refresh catalog (or Rebuild with onRebuild returning true), release the lookup, and assert its target does not open and no 'No indexed project file' message shows; the same for a held load-more page.",
  "evidence": "Mutation R3-17, R3-18, R3-19, R3-20 all survived; T23-1 and T23-5 (no --bail) fail exactly the lookup, page and standing-error tests. Introduced or left by the work that answered round 2's F-002. The orchestrator re-ran the reviewer's 20 mutants through `keryx review mutate` with all six test files per mutant (research-evidence/mutation-2.md: 6 killed, 14 survived, 0 invalid); the killed and surviving ids are the ones this finding names.",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "location_class": "in-diff"
 },
 {
  "id": "F-005",
  "severity": "minor",
  "file": "apps/desktop/src/App.dom.test.tsx",
  "line": null,
  "quote": "test(\"the Metaproject explorer is told it is hidden while another view or Settings is shown, and shown again on return\", async () => {",
  "problem": "The stand-in explorer pins `visible` handed to the explorer, and nothing else of MetaprojectWork, so the test would pass if MetaprojectWork stopped rendering the real explorer in the app. Mutants in a scratch copy, App.dom.test.tsx (baseline exit 0): R3-14 (default `explorer = LazyMetaprojectView` -> a component returning null) SURVIVED; R3-13 (ProjectWindow's `<MetaprojectWork cwd={cwd} view={view} workView={workView}` -> `view={workView}`) SURVIVED, since no test renders ProjectWindow; R3-10 (RetainedView `visible={view === \"metaproject\"}` -> `visible={workView === \"metaproject\"}`) SURVIVED: the Settings step of the test asserts only `given.at(-1)` is false, not that the wrapper is hidden, so the explorer would stay on screen under Settings; R3-15 (`onRebuild={onRebuild}` -> `async () => false`) SURVIVED, and R3-16 (Suspense fallback removed) SURVIVED. R3-12 (explorer `visible` -> workView) and, from round 2, R2-28 are killed. R3-11 (RetainedView `active` -> `view === ...`) survived and is near-equivalent: it differs only for a first mount while Settings is shown.",
  "impact": "F-009 asked that the `visible` wiring be pinned; the prop is, but the wrapper's own hidden state under Settings, the app's call site and the default explorer are covered by the live check only. The hidden-under-Settings case is the one the test's own last step names.",
  "suggested_fix": "In the Settings step add `expect(host.querySelector(\"p\")?.closest(\"[hidden]\")).not.toBeNull()` (kills R3-10). For the default explorer, render MetaprojectWork once without `explorer` and assert the Suspense fallback 'Loading Metaproject…' shows (kills R3-14 and R3-16 without a module mock). The call-site mutant R3-13 needs either a test of ProjectWindow or stating that it rests on the live check.",
  "evidence": "Mutation R3-10, R3-13, R3-14, R3-15, R3-16 survived; R3-12 killed. The `explorer` prop is the T23 seam (App.tsx:161). Introduced or left by the work that answered round 2's F-009. The orchestrator re-ran the reviewer's 20 mutants through `keryx review mutate` with all six test files per mutant (research-evidence/mutation-2.md: 6 killed, 14 survived, 0 invalid); the killed and surviving ids are the ones this finding names.",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "location_class": "in-diff"
 },
 {
  "id": "F-006",
  "severity": "minor",
  "file": ".metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/tasks.md",
  "line": null,
  "quote": "| T4 | review | Review round on the integrated change | T8, T9, T10, T11, T14, T15, T16, T17, T18, T19, T20, T21 | — |",
  "problem": "The task table was extended for T22 and T23 (two new rows, a Review paragraph and a Fix round 2 section) but the T4 row was not updated. flow.json at head has T4 dependsOn [T8, T9, T10, T11, T14, T15, T16, T17, T18, T19, T20, T21, T22, T23] (set by the history event 'task-depends-set: T4: dependsOn ... T22, T23 — the review task closes after fix round 2 (T22, T23) and a clean round'). tasks.md says T4 waits for T21 only. Checked mechanically: parsing the table and flow.json, T4 is the only one of 23 rows whose dependency column differs from flow.json (kinds, and the dependencies of T22 '—' and T23 'T22', all agree). This is the class round 1 found in this file (the table no longer following flow.json), one row wide.",
  "impact": "Whoever reads tasks.md to see what must finish before the review task closes is told T21; flow.json, which the CLI enforces, also holds the review back until T22 and T23 are done. The two records of the same dependency disagree in the file a human opens first.",
  "suggested_fix": "Change the T4 row's dependency cell to 'T8, T9, T10, T11, T14, T15, T16, T17, T18, T19, T20, T21, T22, T23'.",
  "evidence": "Introduced or left by the work that answered the flow record of fix round 2. The orchestrator wrote this file by hand when it added T22 and T23: it added their two rows and a section and left the T4 row and the sentence above the table as they were. The same class as round 1's F-009. Normalisation notes: the same defect was raised by review-style (review-style-w1, F-001, minor).",
  "confidence": "high",
  "reviewer": "review-logic",
  "location_class": "in-diff"
 },
 {
  "id": "F-007",
  "severity": "minor",
  "file": ".metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/journal.md",
  "line": null,
  "quote": "mutated by the orchestrator's own script, are all killed, four of them by T22's tests.",
  "problem": "The journal's T23 acceptance entry says R2-14 and R2-23 'killed on their new lines' and five of T22's branches 'killed' by 'the orchestrator's own script' and names no script. The result file names it as 'own_mutants.py (scratchpad)'; the dispatch files name scratch_check2.py by an absolute path under /private/tmp/claude-502/.../scratchpad/. Neither script is a tracked file (git ls-files finds neither); they exist only in one session's temporary directory. The mutants themselves (anchor and replacement for R2-14, R2-23 and T23-1..T23-5) are written nowhere in the record. The only persisted evidence of these runs is the round-3 package's research-evidence/moved-mutants-1.txt, which the journal cannot cite because it was written later. The T22 entry has the same shape: 'in a scratch copy with the two production files put back to HEAD, seven of the new tests fail' names neither the tool nor the command (the result file names scratch_check2.py red --restore ...).",
  "impact": "A statement that something was verified has to name what verified it, so the next editor can run it again. Here the claim 'all killed' for the branches T22 added (the branches whose tests T23 chose not to add: 'No T22 branch survived, so no test was added for them') cannot be re-run from the repository; the next reviewer re-derives the mutants from prose.",
  "suggested_fix": "In the T23 entry, name the script and where it is kept (or write the seven mutants, file:line and replacement, into the entry or into a tracked file next to it); in the T22 entry name scratch_check2.py red with its --restore arguments. Or say the runs rest on the worker's report.",
  "evidence": "Introduced or left by the work that answered the flow record of fix round 2. The scripts are scratch_check2.py and moved_mutants.py in the orchestrator's session scratch directory; the outputs of the second one are in this package as research-evidence/moved-mutants-1.txt and moved-mutants-2.txt, which is untracked. Normalisation notes: the quote is a part of the reviewer's, cut at normalisation so that it sits on one line of the file.",
  "confidence": "medium",
  "reviewer": "review-logic",
  "location_class": "in-diff"
 },
 {
  "id": "F-008",
  "severity": "minor",
  "file": ".metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/results/T22.result.json",
  "line": null,
  "quote": "The F-005 token rule in openPath (lookup.current) is untouched.",
  "problem": "The same `notes` string uses round 2's ids for the four findings it answers (F-001 to F-004) and here F-005 for round 1's finding (Wiki-link lookups settled by arrival order; the dispatch says 'round 1's F-005 rule'). Round 2 also has an F-005, the one the operator dismissed ('finding ids in test names', named in tasks.md and in the journal). The sentence does not say which round it means, and no id in this file is marked with its round.",
  "impact": "A later reader who looks up F-005 in the round-2 package finds the dismissed test-naming finding and reads 'untouched' as a statement about it; the actual guard (the lookup token of round 1's F-005 in `openPath`) is not found from the sentence.",
  "suggested_fix": "Write 'round 1's F-005 token rule in openPath (lookup.current) is untouched', as the dispatch does.",
  "evidence": "Introduced or left by the work that answered the flow record of fix round 2. Normalisation notes: confidence was not stated by the reviewer and is set at normalisation.",
  "confidence": "medium",
  "reviewer": "review-style",
  "location_class": "in-diff"
 },
 {
  "id": "F-009",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "if (generation === catalogRead.current && !quiet) setError(errMessage(cause));",
  "problem": "The quiet re-read on return can no longer report a failure, and one `error` state serves two causes. (a) Trigger: the catalog cannot be read at all (CLI missing or crashing) and the user returns to the view. Outcome: every return fails quietly; the banner keeps the last freshness read (for example no banner when the graph was ready), and a graph-ready explorer has no visible Refresh control (the Rebuild button exists only while graph !== 'ready', line 876). Round 2's head showed the CLI message with Retry. (b) Trigger: a loud catalog read fails after the first load (the reload after a rebuild, a Retry or Refresh), then the user leaves and returns while the CLI works again. Outcome: the quiet read succeeds and may replace the catalog, but the standing banner with its CLI message and Retry stays, because `error` is cleared only by a loud read (line 378) or by rebuild() (line 673). Round 2's head cleared it on that read. Refute: on the base branch nothing was read on return, so (a) showed nothing and (b) kept its banner until Retry, so neither is worse than base. Other reads (search, detail, relationships) still show their own errors, and Retry on the banner works.",
  "impact": "Nothing is lost: a user with an unreadable catalog sees other panes fail with their own messages, and a stale banner clears with one Retry click. It is the price of the decision the T22 worker marked as needing the operator, and of sharing one `error` between catalog reads and rebuild failures: the explorer cannot tell a rebuild failure (which a successful read does not cure) from a catalog failure (which it does).",
  "suggested_fix": "Optional: let a quiet read that succeeds clear an error only when it came from a catalog read (a separate `catalogError` beside the rebuild's), and surface a quiet failure after N consecutive ones. Not worth a third fix round on its own.",
  "evidence": "Introduced or left by the work that answered round 2's F-003. Part (b) of this finding, a standing catalog error that outlives a later successful quiet read, is in the record as the minor finding raised by review-logic; what stays here is part (a): a quiet re-read that fails is never reported. The operator's answer to round 1's F-004 was to re-read silently. Normalisation notes: the same defect was raised by review-security-code (review-security-code-w1, F-001, info); the same defect was raised by review-ui-ux (review-ui-ux-w1, UX-002, info).",
  "confidence": "high",
  "reviewer": "review-degradation",
  "location_class": "in-diff",
  "degradation_class": "behaviour-delta",
  "evidence_kind": "base-diff"
 },
 {
  "id": "F-010",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "if (result.snapshotId !== snapshotId) { setSnapshotMismatch(true); return; }",
  "problem": "UNVERIFIED (derived from code). Choice 1 of the brief: a wiki-link lookup started under snapshot one and not cancelled when a quiet re-read replaces the catalog with snapshot two compares its answer with the `snapshotId` it captured at click time, not with the current catalog. The banner 'Project knowledge changed while loading' with Refresh catalog then shows although the catalog on screen is already the new one.",
  "impact": "Trigger: click an unloaded Wiki link, leave and return within one CLI read, with the project's knowledge changed in between. The link does not open, the banner says to refresh a catalog that is already fresh, Refresh catalog reloads it again (and drops the lookup), and the user clicks the link a second time. Narrow; costs one click and a misleading banner.",
  "suggested_fix": "Compare against the current snapshot (a ref of `loadedSnapshot.current`) and, when it differs only because the catalog moved on, run the lookup again instead of showing the banner; or clear a pending lookup's banner when a quiet read replaces the catalog.",
  "evidence": "Read the openPath hunk (@@ 691,736 @@: `const snapshotId = catalog?.snapshotId;` captured before the await) and the catalog effect that calls `setSnapshotMismatch(false)` only at the moment of replacement, before the lookup answers. Introduced or left by the work that answered round 2's F-002. This is the first of the two choices the T22 worker marked as needing the operator and the orchestrator took by default; review-logic and review-highload judged it a defensible default that costs one click.",
  "confidence": "low",
  "reviewer": "review-ui-ux",
  "location_class": "in-diff"
 },
 {
  "id": "F-011",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "if (!quietRead.current) project.current++;",
  "problem": "Clean Code - comments. The effect's cleanup decides whether to retire pending work by reading quietRead.current, which at that moment holds the intent of the next run (the visible effect set it just before bumping revision), not of the run being cleaned up. The comment above it ('Leaving the explorer (unmount, or a project change, which remounts it) retires its pending work') describes the unmount case and does not say the condition reads the successor's flag. It works because React runs a cleanup before the next body, and the body resets the flag at line 375.",
  "impact": "An editor who moves the reset of quietRead (line 375) earlier, or lets another path set the flag between runs, changes whether pending wiki-link lookups and result pages are retired, with no signal at this line. Not a defect today; the two hidden-and-shown in-flight tests pin the visible behaviour.",
  "suggested_fix": "Extend the comment: 'quietRead already holds the next run's intent here: the visible effect sets it before bumping revision.'",
  "evidence": "Introduced or left by the work that answered round 2's F-002.",
  "confidence": "medium",
  "reviewer": "review-clean-code",
  "location_class": "in-diff"
 },
 {
  "id": "F-012",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "const wikiRelationshipRows = wikiRelationships ? wikiRelationships.incoming + wikiRelationships.outgoing + wikiRelationships.secondStep : 0;",
  "problem": "Clean Code - DRY. The total of the three summarizeRelationships fields is spelled here and at NodeDetailsPanel.tsx:242 (`summary.incoming + summary.outgoing + summary.secondStep`). Two copies, below the three-copy threshold, so not a finding by the rule. Noted because 'rows the list shows' is now defined by two sums plus the `empty` const in RelationshipList (a third form of the same rule).",
  "impact": "A fourth group added to groupRelationships has to be added to both sums and to `empty`; a miss shows a count that disagrees with the list, the class of round 2's F-001.",
  "suggested_fix": "Add a `total` to the summarizeRelationships result and use it at both sites.",
  "evidence": "Introduced or left by the work that answered round 2's F-001. First noted by the T22 worker under noticed_not_touched (results/T22.result.json).",
  "confidence": "high",
  "reviewer": "review-clean-code",
  "location_class": "in-diff"
 },
 {
  "id": "F-013",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx",
  "line": null,
  "quote": "stubBox(filtersButton(), { left: 544, top: 478, right: 615, bottom: 502 });",
  "problem": "UNVERIFIED (derived from code; no real-layout measurement exists for these inputs). The T23 placement tests pin placeFiltersPopover() arithmetic against inputs happy-dom invents. (1) stubPopoverContentHeight returns one constant scrollHeight for the popover; in a browser scrollHeight is also the full content height under a max-height, so the model matches, but the constants (229, 500) are fixed numbers and do not follow a content change (the known Reset-filters row, F-011). The stub also answers scrollHeight only, so an edit that read offsetHeight (capped by max-height) instead would pass every test. (2) The bottom-edge test puts the button at top 478 / bottom 502 in a 480 px window, so the button's own box lies partly outside the window. A real Filters button sits inside the explorer's .view and is in the window when the popover opens; the branch the test pins (bottom = max(8, 480 - 478 + 4) = 8) is reachable in a real layout only when the page has scrolled the button under the window edge. The Math.max(POPOVER_MARGIN, ...) floor is pinned by an input a real layout reaches rarely, and a button inside the window with less than 4 px under it is the case the floor really serves. (3) The 30 px window test leaves scrollHeight at happy-dom's 0; with a real content height the result is the same (above -12 is not greater than below -6), so that one holds.",
  "impact": "No user-visible defect is claimed. The tests would stay green if the content-height source changed to a capped measure, and they pin the 8 px floor with an off-window button. Probe that would settle it: in the browser dev build at 720x480, open Filters with the freshness Details open and read the popover's scrollHeight, offsetHeight and getBoundingClientRect() before and after a resize to 700x480, and compare with the top and maxHeight the code sets.",
  "suggested_fix": "Optional, tests only: give the scrollHeight stub an offsetHeight twin that honours the inline max-height, and add one case whose button box lies inside the window with under 4 px below it. No production change.",
  "evidence": "Introduced or left by the work that answered round 2's F-006.",
  "confidence": "medium",
  "reviewer": "review-layout",
  "location_class": "in-diff"
 },
 {
  "id": "F-014",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/graphLayout.ts",
  "line": null,
  "quote": "const edgeKinds = new Set(projection.edges.map((edge) => edge.kind));",
  "problem": "legendFor is the one reader of a projection's edges in apps/desktop/src/metaproject that does not use the grouping rule of F-001's fix. It builds the line-style legend from the raw edge list, self-loops and edges with an end outside the projection included, while layoutNeighborhood (line 506, `if (edge.from === edge.to) return;`) and groupRelationships leave both out. For a wiki page whose only edge is a `links` edge to itself, the graph draws the root alone and its legend still lists 'Dashed line' with 'Links'. This file is outside slice-02 and the legend is a kind set, not a count or an emptiness test, so this is noted, not a defect of the fix round.",
  "impact": "Not stated: the legend names a line style no drawn line uses, for a projection that no page of this project produces today (none of the 129 wiki pages links to itself, per round 2's evidence).",
  "suggested_fix": "Build `edgeKinds` from the edges the layout keeps (or skip `edge.from === edge.to` in legendFor) if the 'exactly the line styles present' wording of AC4 is meant to cover drawn lines.",
  "evidence": "keryx ctx rg for `\\.edges|edges\\b.*(length|\\.some|\\.every)` over apps/desktop/src/metaproject excluding tests: readers are RelationshipList.tsx:54 (groupRelationships), graphLayout.ts:464/475/505 (layout, self-loop skipped at 506), graphLayout.ts:638 (legend, raw), NodeDetailsPanel.tsx:85 (document neighbours, not a count), MetaprojectView.tsx:363 (catalog index). Introduced or left by the work that answered round 2's F-001.",
  "confidence": "high",
  "reviewer": "review-logic",
  "location_class": "pre-existing"
 },
 {
  "id": "F-015",
  "severity": "info",
  "file": ".metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/results/T23.result.json",
  "line": null,
  "quote": "T22's branches (own_mutants.py): T23-1 :376 `if (!quiet) {` -> `{` killed by T22's lookup-in-flight, page-in-flight and standing-error tests;",
  "problem": "Mutants of code that T22 added are given the ids T23-1 to T23-5, a prefix that is T23's own task id, next to round 2's mutant ids R2-n which name the review round that proposed them. The journal's T23 entry describes the same five mutants ('the five branches T22 added ... mutated by the orchestrator's own script') without any id, and names no script, so the ids can be matched to the journal only through this notes field.",
  "impact": "'T23-3' reads as a mutant of T23's tests or a third item of T23, not as a mutant of T22's `catalogPending` guard; the same five mutants have an id in one file and none in the other.",
  "suggested_fix": "Name them for what they mutate (for example T22-m1 to T22-m5) or say 'ids of this task's own mutants' once, and give the journal entry the same ids.",
  "evidence": "Introduced or left by the work that answered the flow record of fix round 2. Normalisation notes: confidence was not stated by the reviewer and is set at normalisation.",
  "confidence": "medium",
  "reviewer": "review-style",
  "location_class": "in-diff"
 }
]
```

## Token spend

token spend: unknown (15 dispatch(es), none reported usage)

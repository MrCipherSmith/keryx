**Changes requested — 0 Blocker, 0 Major, 1 Minor.** Fix round 4 closed all four findings it answered, changed no production file, and no reviewer found a defect or a regression. The one minor is the wording of a new test's title. This is round 5 of 5: the loop ends here, and what stays open goes to the completion report.
Reviewed `744d9ef7542f..857036d02174` (the three commits of fix round 4) · round 5 of the flow, the last · one slice (`slice-01`) · CI not consulted (the target is a branch, not a pull request).
Evidence level: ran — `bun test` on the impacted test files (one process per file, all pass), `keryx review mutate` over the 7 mutants review-testing-practices proposed for this round (4 killed, 3 survived, 0 invalid), round 4's twelve mutants after T26 (`t26-mutants-1.txt`: 9 killed, R4-7, R4-8, R4-10 and R4-11 each by one of the new tests), and, before the round, the type check, the whole desktop suite (935 pass), the Vite build and the root type check. Did not run: the native Tauri window (no Rust toolchain on this machine), WebKit older than macOS 26, and live checks of a failed rebuild followed by Retry or a second rebuild, and of a superseded read (each rests on its DOM test).

This verdict is interim until the operator closes the round.

### How this round is placed among the others

The review tool takes a round as the previous one only when it was run over its whole plan or closed by the operator. Round 4 ran, by the operator's choice, on 18 of its 38 dispatches, so the tool planned this round as a delta over round 3's head, which would have re-read round 4's diff. The orchestrator started this package over the range since round 4's head instead (`keryx review start --no-prior-round --base 744d9ef7542f`), which the tool records as a first round, and attached round 4's findings to the slice itself. The dispositions below are the reviewers', not the tool's ledger.

### Dispositions of round 4's findings

Judged against the code at this head, not against the commit messages. The ids in this list are round 4's.

- **F-001: closed.** review-testing-practices (owner), review-logic, review-frontend and review-regression. Tests 'a failed rebuild's banner goes when Retry reads the catalog again and the read succeeds' and 'a second rebuild removes the first one's failure banner while it runs' kill R4-10 and R4-11; the reviewer re-ran both.
- **F-002: closed.** review-testing-practices (owner), review-logic, review-frontend and review-regression. Two tests with a held read kill R4-8 and R4-7; the reviewer re-ran both, and the read counters of each test were traced by three reviewers.
- **F-003: closed.** review-logic (owner), review-frontend and review-regression. The cell of T24's banner table names the two tests that exercise it and says it was reworded after acceptance; the result file still validates.
- **F-004: withdrawn.** Dismissed by the operator in round 4: a fix task's result file writes its own round's finding ids bare, the flow's convention.
- **F-005: closed.** review-style (owner), review-logic, review-frontend and review-regression. `verification/fix-round-3.md` says its run counts the committed file (86 + 1 = 87 tests) and why T24's result counts one fewer.
- **F-006: open.** Info, below the fix threshold; not changed: five titles in `tasks.md` still differ from `flow.json`.
- **F-007: open.** Info, below the fix threshold; not changed.
- **F-008: open.** Info, below the fix threshold; not changed.
- **F-009: open.** Info, below the fix threshold; not changed: the rebuild banner kept on purpose is still unreachable from the app's own onRebuild.
- **F-010: open.** Info, below the fix threshold; not changed.

## Regressions the fixes introduced

None. The round changed no production file; review-regression found that the four tests run last, patch no global, reuse unchanged helpers and release every promise they hold, and that every reader of the changed record files still gets valid input.

### Minor

**F-001. A new test title says “a failed rebuild reload” where the rebuild succeeded and its catalog reload failed.** `apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx` · raised by review-style · from round 4's F-002 · verifier: confirmed (site-check), premise: upheld.
The same words name two different cases within four titles. In this file and in T24's banner table a 'failed rebuild' is one whose onRebuild rejects (error source "rebuild"): the two new titles just above say 'a failed rebuild's banner' and 'the first one's failure banner', and the older 'a failed rebuild's message outlives a catalog read ...' means the same. In this test onRebuild resolves true and it is the catalog reload after the rebuild that fails (error source "catalog"), which the T24 table calls 'a rebuild's failed catalog reload'.
Impact: A reader who scans the file's titles for the failed-rebuild cases (source "rebuild") will take this test for one and look for the failed-rebuild x superseded-read cell in it; the next editor who adds a test for a rejecting onRebuild with a quiet read held in flight has no title that tells him this one is not it. No wrong behaviour; a naming cost only.
Fix: Name the case by what fails: "a quiet re-read that a rebuild's failed catalog reload superseded leaves that reload's banner when it lands" (the T24 table's own phrase). If the title is changed, change the copies in results/T26.result.json, the journal and verification/fix-round-4.md in the same edit, since they cite it by exact title.

<details><summary><b>Info (kept in the record, not published as findings)</b></summary>

- **F-002. The gate on the loading status of a later catalog read is not pinned by any test (it predates the fix rounds).** `apps/desktop/src/metaproject/MetaprojectView.tsx` · review-testing-practices · verifier: confirmed (execution).
- **F-003. fix-round-4.md names “the T26 commit” where fix-round-3.md gives the commit's hash.** `.metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/verification/fix-round-4.md` · review-style · verifier: confirmed (site-check).

</details>

<details><summary><b>Verified clean</b></summary>

Each line is a hypothesis that was tested and did not hold, with what it rests on.

- A new test passes for the wrong reason: review-logic, review-testing-practices and review-frontend traced the read counter of each test (which read starts, which one each later event supersedes, what each `setError` writes) and found each assertion follows from its sequence; review-testing-practices re-ran R4-7, R4-8, R4-10 and R4-11 and each is killed by the test the record names.
- A held promise outlives its test or leaves an unhandled rejection: every held promise is released or rejected inside its own test and caught by the component's own try/catch; `beforeEach` renders the shared root to null inside `act` (review-frontend, review-regression).
- The new tests change what earlier tests see: they run last, patch no global, reuse helpers that did not change, and all 91 titles are unique (review-regression).
- The reworded result file breaks a reader: `results/T24.result.json` and `results/T26.result.json` validate against their resolved contexts; `flow task done --result` stores no hash; no code reads the verification files (review-regression).
- The record disagrees with the code or itself: every anchor of `verification/fix-round-4.md` occurs once at head and its results match the recorded run; the 27 rows of `tasks.md` match `flow.json` in kind and dependencies (review-logic, review-regression).

</details>

<details><summary><b>How this review was run</b></summary>

**Workflow:** `review-orchestrator`, managed round 5 of 5 for flow 515, mode `review-flow`, attended. The package was started over the range since round 4's head, then `keryx review scope`, `blast-radius`, `slice` and `required --depth auto --style`: 5 reviewers (the path-gated roles own no file of this diff), 1 slice, 5 dispatches, all 5 ran.

**Scope:** `744d9ef7542f..857036d02174`: 11 files, 805 changed lines. `slice-01` (113 KB): the test file and, of the flow's record, `journal.md`, `tasks.md`, `flow.json`, `results/T24.result.json`, `verification/fix-round-3.md`, `verification/fix-round-4.md` and T26's dispatch, request, resolved-context and result files.

**Models:** by tier, the operator's answer at the start of round 1. Dispatched on the host aliases, whose exact model ids the host did not report: `sonnet` for 4 reviewer runs, `opus` for review-regression and the premise judge, `haiku` for the verifier. The orchestrator session is `claude-opus-5-5`.

**Tools:** reviewers read-only (`allowed_tools: read-only`, `exec_budget_s: 0`), except review-testing-practices (`run-tests`), which re-ran four of round 4's mutants and ran its 7 new ones in its own scratch copies. The orchestrator ran `keryx review verify-run` and `keryx review mutate`.

**Skills:** review-frontend, review-logic, review-regression, review-style, review-testing-practices, review-verifier, review-premise.

**Subagents:** 5 reviewer runs, 1 verifier run, 1 premise run.

**Not run:**
- The native Tauri window and the Rust shell: no Rust toolchain on this machine.
- WebKit older than the one of macOS 26.7.3.
- Live: a failed rebuild followed by Retry or a second rebuild, and a superseded read; the app's own onRebuild reports a failure as a toast (round 4's info F-009).
- Blast radius: 10 of the 11 changed files are Markdown or JSON records, which are not graph nodes; review-regression found their readers by search. 80 text-hub files were dropped.
- Token spend: no dispatch reported usage to the package.

**Stage counts:**

- pre-filter: files seen 11, retained 11, dropped 0; blocks 20 of 20 retained; changed lines retained 805, dropped 0.
- verifier (`verification_mode: annotate`): claims received 3, applied 3, rejected 0, capped to unverifiable 0; confirmed 3 (1 by the recorded mutation run, 2 by site check), refuted 0, unverifiable 0, unverified 0.
- retained: findings in 3, removed by the verifier 0, retained 3.
- findings cap: limit 10 per reviewer, truncated 0.
- scope B: scope-B findings 0, accepted 0, rejected 0, exempted 0 (review-regression filed none).
- degradation evidence screen: screened 0 (no review-degradation dispatch in this round).
- premise: 1 upheld, 0 downgraded, 0 held.
- dispatches: 5 of 5 run.
- blast-radius chunk passes: none run.

</details>

```json keryx:findings
[
 {
  "id": "F-001",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx",
  "line": null,
  "quote": "test(\"a quiet re-read that a failed rebuild reload superseded leaves that reload's banner when it lands\", async () => {",
  "problem": "The same words name two different cases within four titles. In this file and in T24's banner table a 'failed rebuild' is one whose onRebuild rejects (error source \"rebuild\"): the two new titles just above say 'a failed rebuild's banner' and 'the first one's failure banner', and the older 'a failed rebuild's message outlives a catalog read ...' means the same. In this test onRebuild resolves true and it is the catalog reload after the rebuild that fails (error source \"catalog\"), which the T24 table calls 'a rebuild's failed catalog reload'. 'A failed rebuild reload' reads as 'the reload of a failed rebuild', which is the other case. The title also says 'it' twice over two readings ('when it lands' is the quiet read, 'that reload's banner' is the reload's). The body is right and its comment ('the reload after the rebuild, started meanwhile, fails') says what the title should; the same title is copied into T26's result file notes, the journal entry for T26 and tasks.md, so the wording spreads.",
  "impact": "A reader who scans the file's titles for the failed-rebuild cases (source \"rebuild\") will take this test for one and look for the failed-rebuild x superseded-read cell in it; the next editor who adds a test for a rejecting onRebuild with a quiet read held in flight has no title that tells him this one is not it. No wrong behaviour; a naming cost only.",
  "suggested_fix": "Name the case by what fails: \"a quiet re-read that a rebuild's failed catalog reload superseded leaves that reload's banner when it lands\" (the T24 table's own phrase). If the title is changed, change the copies in results/T26.result.json, the journal and verification/fix-round-4.md in the same edit, since they cite it by exact title.",
  "evidence": "Introduced or left by the work that answered round 4's F-002. review-testing-practices noted the same wording in its notes and did not file it.",
  "confidence": "medium",
  "reviewer": "review-style",
  "location_class": "in-diff"
 },
 {
  "id": "F-002",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/MetaprojectView.tsx",
  "line": null,
  "quote": "if (!loaded.current) setLoading(true);",
  "problem": "Mutant R5-7 (`if (!loaded.current) setLoading(true);` -> `setLoading(true);`) SURVIVED: bun test of MetaprojectView.dom.test.tsx, 91 pass, exit 0. With the mutation every catalog read after the first, quiet re-reads on return and reloads after a rebuild included, would raise the 'Loading project knowledge…' status (line 877) until it lands. No test asserts that status is absent while a later read is held. The new tests hold a quiet read (test 3) and a reload (test 4) in flight, which is the place the assertion would sit, and none looks for the status. This gate is older than fix round 4 and no production line changed this round, so it is a gap the new fixtures could close, not a defect the fix introduced.",
  "impact": "The next editor who simplifies the effect body (the condition reads like a redundant guard) shows a loading banner on every return to the explorer and every reload with the suite green. The cost is a flash of status text over a catalog that is already on screen; no data or state is lost, hence info.",
  "suggested_fix": "In 'a quiet re-read that a failed rebuild reload superseded leaves that reload's banner when it lands' (or its sibling), add `expect(document.body.textContent).not.toContain(\"Loading project knowledge…\")` after `expect(catalogReads).toBe(2)` while the quiet read is held, after the catalog has first loaded.",
  "evidence": "Own mutant run in a scratch copy made as scratch_check4.py make_copy() does, my script scratchpad/r5/run.py, one mutant at a time, `bun test src/metaproject/MetaprojectView.dom.test.tsx`: baseline 91 pass 0 fail; R5-7 survived (exit 0). The orchestrator re-ran the reviewer's 7 mutants through `keryx review mutate` with all six test files per mutant (research-evidence/mutation-1.md, spec mutants-r5.json: 4 killed, 3 survived, 0 invalid). The gated line predates the branch's fix rounds; no production line changed in this round.",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "location_class": "pre-existing"
 },
 {
  "id": "F-003",
  "severity": "info",
  "file": ".metaproject/flows/515-2026-11-23-desktop-metaproject-graph-panel/verification/fix-round-4.md",
  "line": null,
  "quote": "The runs were made on 2026-11-23 on the tree that became the T26 commit. How a scratch copy and a mutant run are made is",
  "problem": "fix-round-3.md, whose form this file follows, says 'on the tree that became commit `46c472162`'. This file says 'the T26 commit' without a hash, so the one fact that lets a person check out the tree and repeat the runs is a description, not an id. The file exists, as its first sentence says, so that the runs can be repeated from it.",
  "impact": "A person repeating the mutant runs has to find the commit from the task id (git log, the journal, or T26's boundary commit message) instead of reading it from the file; the brief for this round lists it as c8db67492.",
  "suggested_fix": "Add the hash after the commit is known, as fix-round-3.md has it: 'on the tree that became commit `c8db67492`'.",
  "evidence": "Introduced or left by the work that answered the flow record of fix round 4.",
  "confidence": "high",
  "reviewer": "review-style",
  "location_class": "in-diff"
 }
]
```

## Token spend

token spend: unknown (5 dispatch(es), none reported usage)

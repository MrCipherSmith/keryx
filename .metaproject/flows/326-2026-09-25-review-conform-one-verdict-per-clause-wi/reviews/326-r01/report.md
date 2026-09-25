# Review — flow 326, review conform: one verdict per clause (PR #717)

Two rounds ran against the flow 326 diff (`src/review/conform-jev.ts`,
`src/review/conform-report.ts`, `src/commands/review.ts`,
`src/tui/conform-source.ts`, `src/tui/conform-inspector.ts`,
`src/review/ci-triage.ts`, plus tests and `docs/docs/cli-reference.md`),
which changes `keryx review conform` and the `/conform` TUI modal from one
report row per hunk × clause to one verdict per hunk-kind clause (worst hunk,
how many were judged/below threshold, up to `--max-hunks` further
violations), bounds the Jev question budget with `--max-hunk-calls`, and
folds in the CI-triage leftovers from PR #713's review (a `runInfoCache`
rejection test, the pagination-gap doc note, and a corrected facade-import
comment in `src/review/ci-triage.ts`).

The branch is two commits: the initial implementation
(`16506480`, "feat(review): conform reports one verdict per clause, with the
worst hunks; hunk calls bounded") and a second commit
(`def2955d589832c25694932421bb2dbc52115414`, "fix(review): a budgeted-out
clause reads not evaluated; judged-on-K-of-N in text, JSON and /conform")
whose message opens "Review of PR #717:" — the fixes for round 1's findings.

**Round 1** raised four findings against the first commit — two major, two
minor. All four were fixed in the branch's second commit before merge:

- **F-001 (major)** — `boundHunkRegions` (`src/review/conform-jev.ts`), the
  function that turns `--max-hunk-calls` into a per-clause hunk quota, used
  a single run-wide `floor(maxHunkCalls / hunkClauseCount)`. Whenever the
  budget was smaller than the number of hunk-kind clauses (e.g.
  `--max-hunk-calls 1` with 2 hunk-kind clauses in the reference document),
  every clause's share rounded down to 0 and the clause was silently
  missing from the report entirely — not "not-evaluated", just absent from
  `clauses[]` — directly contradicting AC3's "never silently" requirement.
- **F-002 (major)** — the `/conform` TUI modal (`src/tui/conform-source.ts`)
  is a second, independent call site of the same `boundHunkRegions`
  function (`scoreHunkRegions`), so it carried the identical vanishing-
  clause defect, and additionally had no equivalent of the CLI's
  "judged on K of N hunks" truncation marker at all — a clause the budget
  cut short looked identical to one judged on the full diff.
- **F-003 (minor)** — AC1 requires `--explain` to send the model one prompt
  per violated *clause* (via the worst hunk), never one per judged hunk, but
  no test exercised this — `review-conform-cli.test.ts` had no case counting
  prompts against a clause with many judged, likely-violated hunks.
- **F-004 (minor)** — `docs/docs/cli-reference.md`'s `--max-hunk-calls` row
  described only the even-budget case (`floor(--max-hunk-calls /
  hunk-kind-clause-count)`); it said nothing about the small-budget
  per-clause-floor behaviour, the `not-evaluated` + reason a zero-quota
  clause gets, or the new `hunksTotal` JSON field — an AC7 documentation
  gap for exactly the case F-001 fixed.

**Round 2** re-read the second commit against the four findings above: all
four are fixed and verified (see `verifications.json` — each claim cites the
merge commit and, where a test exists, an actual green test run against this
worktree's checkout of the merged code). Round 2 **approves** clean; no
findings were left open.

Verification for this closure (re-run independently, not just re-read):
`bun test src/review/conform-jev.test.ts src/commands/review-conform-cli.test.ts
src/tui/conform-inspector.test.ts src/review/ci-triage.test.ts
src/review/conform-report.test.ts` — 141 pass, 0 fail, 396 `expect()` calls,
at this worktree's checkout of the PR's tip commit
(`def2955d589832c25694932421bb2dbc52115414`, content-identical to the
squash-merged commit on `main`).

PR #717 squash-merged as `3fddda2ebb3caab6c9dcc3ca872111afd2c87dc6` into
`main` (verified via `gh pr view 717 --json mergeCommit,mergedAt,state`:
`state: MERGED`, `mergedAt: 2026-09-25T13:48:29Z`; `git merge-base
--is-ancestor 3fddda2ebb3caab6c9dcc3ca872111afd2c87dc6 origin/main` confirms
it is on `main` after `git fetch origin`). CI was 19/19 on the PR (18
success, 1 skipped — "deploy to GitHub Pages", not applicable to a PR build,
per `gh pr view 717 --json statusCheckRollup`), and the flow's own AC9
confirmation additionally records `keryx health run` passing (score 94) and
the full local gate set green at the PR's tip commit.

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/review/conform-jev.ts",
    "problem": "boundHunkRegions computed a single run-wide `Math.max(0, Math.floor(maxHunkCalls / hunkClauseCount))` region budget and applied it to every hunk-kind clause. When `maxHunkCalls < hunkClauseCount` (e.g. `--max-hunk-calls 1` with 2 hunk-kind clauses in the reference document), every clause's share rounded down to 0 and the clause was left out of `clauses[]` altogether, not reported as `not-evaluated`.",
    "impact": "A hunk-kind clause could disappear from the aggregated report or `--json` output with no trace it was ever checkable, whenever an operator's `--max-hunk-calls` budget was smaller than the clause count in their reference document -- silently understating how much of the document was covered, which is exactly what AC3 (\"never silently\") requires the tool not to do.",
    "suggested_fix": "Give each hunk-kind clause a per-clause floor: while the budget allows, hand out one judged hunk per clause (in document order) before giving any clause a second, and report a clause left at 0 as `not-evaluated` with an explicit `\"skipped by --max-hunk-calls (0 of N hunks judged)\"` reason instead of omitting it.",
    "evidence": "src/review/conform-jev.ts boundHunkRegions before the fix: `const maxRegions = Math.max(0, Math.floor(maxHunkCalls / hunkClauseCount)); const kept = regions.slice(0, maxRegions);` with no per-clause floor and no `judgedPerClause` map; after the fix (commit def2955d), the function returns a `judgedPerClause: ReadonlyMap<string, number>` and falls back to a 1-per-clause allocation when `base < 1`. New regression tests: `src/commands/review-conform-cli.test.ts` describe block \"Flow 326, AC3: a budget share that rounds to 0 never vanishes a clause from the report\" (`--max-hunk-calls 0` and `--max-hunk-calls 1` cases), both passing (141/141 pass, `bun test` run at this worktree's checkout of the PR tip commit).",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/commands/review.ts:1998 runConform's call to boundHunkRegions (the CLI text/--json report path)",
        "src/tui/conform-source.ts:246 scoreHunkRegions's call to boundHunkRegions (the /conform TUI modal, tracked separately as F-002)"
      ],
      "enumeration_method": "keryx ctx rg 'boundHunkRegions\\(' src/ -- exactly two production call sites and the function's own test file; both call sites were fixed in the same commit (def2955d)."
    }
  },
  {
    "id": "F-002",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/tui/conform-source.ts",
    "problem": "The `/conform` TUI modal's scoreHunkRegions called `boundHunkRegions(regions, hunkClauses.length, DEFAULT_MAX_HUNK_CALLS)` -- the same buggy floor-division allocator as F-001 -- so the modal was subject to the identical vanishing-clause defect, and additionally `toRow()` (src/tui/conform-source.ts) built each `ConformClauseRow` with no budget-truncation marker at all: a clause judged on a subset of the diff's hunks looked the same as one judged on all of them.",
    "impact": "An operator using the `/conform` TUI (not just the CLI) with a small `--max-hunk-calls` budget could see hunk-kind clauses silently missing from the modal's clause list, and even a clause that WAS shown gave no visual indication it had only been partially checked -- the same AC3/AC4 guarantee the CLI report makes was not honoured by the second, independent entry point into the same pipeline.",
    "suggested_fix": "Route the TUI through the same fixed boundHunkRegions (by clause id, not count) and carry its judgedPerClause/hunkBudget result into ConformClauseRow so the modal's rows show the same 'judged on K of N hunks' marker as the text/--json report.",
    "evidence": "src/tui/conform-source.ts before the fix (commit 16506480): `const bounded = boundHunkRegions(regions, hunkClauses.length, DEFAULT_MAX_HUNK_CALLS);`, and `toRow(agg: ConformClauseAggregate): ConformClauseRow` had no hunkBudget parameter. After the fix (commit def2955d): the call passes `hunkClauseIds` (not a count) and `toRow(agg, hunkBudget)` adds `hunksTotal` when `hunkBudget.truncatedClauses.includes(agg.clause_id)`. Tests: src/tui/conform-inspector.test.ts gained coverage for the budget line (96 lines added in the fix commit); full `bun scripts/opentui-tests-no-skips.ts src/tui` run recorded in the flow's own AC4 confirmation (1231 pass, 0 fail, 0 skip); this closure's own `bun test src/tui/conform-inspector.test.ts` run (part of the 141/141 pass above) is also green.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/tui/conform-source.ts scoreHunkRegions (the boundHunkRegions call) and toRow (the ConformClauseRow builder)"
      ],
      "enumeration_method": "read src/tui/conform-source.ts in full at both commits (16506480 and def2955d) and diffed them; toRow and scoreHunkRegions are the only two functions in the file that touch the hunk budget."
    }
  },
  {
    "id": "F-003",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "src/commands/review-conform-cli.test.ts",
    "problem": "AC1 requires `--explain` to send the model one prompt per violated clause (via `aggregateConformVerdicts(...).map(a => a.worstVerdict)` in `runConform`), never one prompt per judged hunk, but no test asserted this -- there was no case with a clause carrying many judged, likely-violated hunks that counted the actual number of explain prompts sent.",
    "impact": "The worst-per-clause collapse that keeps --explain's Jev spend bounded had no regression coverage; a future change to the explain-candidate-building expression in runConform could silently regress to one prompt per hunk with nothing failing to catch it.",
    "suggested_fix": "Add a test with a clause with many judged, likely-violated hunks (all scored the same, below threshold) and an injected runTurn that counts calls, asserting exactly one prompt is sent for that clause.",
    "evidence": "src/commands/review-conform-cli.test.ts before the fix had no describe block referencing --explain call counting (checked via `keryx ctx rg explain` limited to the commit-1 blob). After the fix (commit def2955d), the diff adds `describe(\"Flow 326, AC1: --explain sends one prompt per violated clause, not one per judged hunk\", ...)` with test `\"explainConformVerdicts is called once for hunks-1 despite 12 judged (likely-violated) hunks\"`, which asserts `prompts` has length 1 against a fixture where hunks-1 has 12 likely-violated judged hunks. The underlying select-worst-per-clause logic in src/commands/review.ts's runConform is unchanged between the two commits (confirmed via `git diff 16506480 def2955d -- src/commands/review.ts`, which touches only the budget-reporting code, not the explain-candidate expression) -- this was a coverage gap, not a functional defect. Test passes: part of the 141/141 `bun test` run above.",
    "confidence": "high"
  },
  {
    "id": "F-004",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "docs/docs/cli-reference.md",
    "problem": "The `--max-hunk-calls` row in the `review conform` flags table documented only the even-budget case (`floor(--max-hunk-calls / hunk-kind-clause-count)`); it said nothing about what happens when the budget is smaller than the clause count (the per-clause floor F-001 fixed), the `not-evaluated` + reason a zero-quota clause gets, or the `hunksTotal` field.",
    "impact": "An operator reading the docs to understand a small `--max-hunk-calls` value would not learn that a clause could be left at not-evaluated rather than judged, or what the JSON output looks like in that case -- an AC7 documentation-completeness gap for exactly the behaviour F-001's fix introduced.",
    "suggested_fix": "Expand the --max-hunk-calls row and the --json flag description to cover the small-budget per-clause-floor case, and add a worked JSON example.",
    "evidence": "docs/docs/cli-reference.md diff between commit 16506480 and def2955d rewrites the --max-hunk-calls row to describe the per-clause floor, the not-evaluated + reason case, and the hunksTotal marker, expands the --json row to mention hunkBudget/hunksTotal, and adds a new worked JSON example ('--json with --max-hunk-calls 1 in effect') showing one clause judged on 1 of 12 hunks and the other not-evaluated. 59 lines added in this file in the fix commit.",
    "confidence": "high"
  }
]
```

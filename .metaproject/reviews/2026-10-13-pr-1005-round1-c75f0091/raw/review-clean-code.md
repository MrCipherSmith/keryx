STATUS: DONE

```REVIEW_RESULT
{
  "status": "DONE",
  "reviewer": "review-clean-code",
  "summary": "Clean-code pass over 4839dbec..c75f0091da. No blocker or major. One minor DRY finding (the revision-operand ternary copied at 8 call sites) and two info notes (recursive hasExecFlag shape, assert-that-returns naming). Comments are accurate and explain intent; hasDashValue and assertGitRevision are small, single-purpose and well named.",
  "findings": [
    {
      "id": "CC-1",
      "severity": "minor",
      "reviewer": "review-clean-code",
      "file": "src/commands/review.ts",
      "quote": "...(ref === undefined ? [] : [\"--end-of-options\", assertGitRevision(ref)])",
      "problem": "The same operand expression, `...(ref === undefined ? [] : [\"--end-of-options\", assertGitRevision(ref)])`, is pasted at 8 git call sites (review.ts gitChangedFiles and gitDiff, plus gitDiffForJev{Select,Risk,Contract,Docs,Scenarios,Rules}); mergeBaseWithHead is a 9th, differently shaped spelling. The safety rule (refuse a leading dash, then --end-of-options) lives in 9 places, and the test has to pin it with string-count assertions on source text (review-revision-operand.test.ts, last test) because nothing else enforces it.",
      "impact": "No wrong behaviour today. Trigger for harm: the next git call that takes a typed ref copies an older `[ref]` spelling (the pre-fix form is still the visible pattern in neighbouring code) and F-045 returns at that site; the source-count test only catches the sites it lists. Per the review-clean-code rule, 3+ copies would be major, but the brief's Major bar (named trigger plus an observable outcome now) is not met, so minor.",
      "evidence": "keryx ctx rg 'ref === undefined \\? \\[\\]|assertGitRevision|--end-of-options' src --glob '!*.test.ts': 6 jev files at one ternary each, review.ts at 2 ternaries + 1 merge-base call. The six jev copies are duplicated by design (their headers say a shared helper would widen an export surface), but assertGitRevision already lives in src/lib, so a lib-level helper would not widen anything.",
      "suggested_fix": "Add to src/lib/git-revision.ts `export function revisionOperand(ref: string | undefined): string[] { return ref === undefined ? [] : [\"--end-of-options\", assertGitRevision(ref)]; }` and use `...revisionOperand(ref)` at the 8 sites. Then one unit test on the helper replaces the 8 source-text count assertions.",
      "confidence": "high",
      "location_class": "in-diff",
      "class_scope": {
        "sites": [
          "src/commands/review.ts gitChangedFiles",
          "src/commands/review.ts gitDiff",
          "src/commands/review.ts mergeBaseWithHead (different shape: always has a ref)",
          "src/commands/review-jev-select.ts gitDiffForJevSelect",
          "src/commands/review-jev-risk.ts gitDiffForJevRisk",
          "src/commands/review-jev-contract.ts gitDiffForJevContract",
          "src/commands/review-jev-docs.ts gitDiffForJevDocs",
          "src/commands/review-jev-scenarios.ts gitDiffForJevScenarios",
          "src/commands/review-jev-rules.ts gitDiffForJevRules"
        ],
        "enumeration_method": "keryx ctx rg for `ref === undefined \\? \\[\\]`, `assertGitRevision` and `--end-of-options` over src excluding tests: 18 matches in 8 files, all listed. Scope of this finding is the duplication only, not whether other ref consumers are unguarded (security and regression reviewers own that)."
      }
    },
    {
      "id": "CC-2",
      "severity": "info",
      "reviewer": "review-clean-code",
      "file": "src/lib/trust-routine-command.ts",
      "quote": "return w.startsWith(\"-\") && eq !== -1 && hasExecFlag([w.slice(eq + 1)]);",
      "problem": "hasExecFlag recurses by wrapping the glued value in a one-element array just to re-enter a function that takes a word list. It is correct and terminates (the slice strictly shrinks), and the comment above it states the intent. It is slightly indirect: the reader has to see that a list-taking function is being used as a word predicate, and the `-c`/EXEC_FLAGS test is now inline in the `some` callback.",
      "impact": "Readability only; no current defect. Behaviour traced on the PR's own cases (`--ref=--x=--output=/tmp/x` recurses twice and matches; `-- x=-c` and `--format=--oneline` do not start with `-` or carry no exec flag, so stay routine).",
      "evidence": "src/lib/trust-routine-command.ts hasExecFlag, lines added by the diff; test cases in trust-routine-command.test.ts F-045 block.",
      "suggested_fix": "Optional: extract `isExecWord(w: string): boolean` holding the recursion on a single word, and make `hasExecFlag = (words) => words.some(isExecWord)`. Same behaviour, no throwaway array.",
      "confidence": "medium",
      "location_class": "in-diff"
    },
    {
      "id": "CC-3",
      "severity": "info",
      "reviewer": "review-clean-code",
      "file": "src/lib/git-revision.ts",
      "quote": "export function assertGitRevision(ref: string): string {",
      "problem": "An `assert*` function that also returns its argument is used inline inside array literals at every call site. The name says it only checks; the return value is the part callers depend on. The doc comment names `--ref` and `--base` but the same function also guards `--diff` (the test header names all three).",
      "impact": "Naming and doc nit only. Disappears if CC-1 is taken, since the helper then owns the call.",
      "evidence": "src/lib/git-revision.ts doc comment lines 2-3 versus src/commands/review-revision-operand.test.ts header comment.",
      "suggested_fix": "Either keep the name and add `--diff` to the doc comment, or rename to `checkedGitRevision`. Not worth a round on its own.",
      "confidence": "medium",
      "location_class": "in-diff"
    }
  ],
  "stats": { "blocker": 0, "major": 0, "minor": 1, "info": 2 }
}
```

## Clean Code Review (round 1 of 3, PR 1005, 4839dbec..c75f0091)

Scope: clean code and SOLID at function level, in the 11 files of scope A. Class-wide ref enumeration for security belongs to the security and regression reviewers; I enumerated only to count the duplicated expression.

### Minor
- CC-1: the revision-operand ternary is copied at 8 sites and the rule lives in 9 places; the test pins it with source-text counts. A lib helper `revisionOperand(ref)` removes both the duplication and the need for the count test.

### Info
- CC-2: recursive `hasExecFlag` re-enters through a throwaway one-element array; an `isExecWord` predicate would be plainer. Correct as written.
- CC-3: `assertGitRevision` is an assert that returns; doc comment omits `--diff`.

### Questions
- None.

### Pre-existing
- The six `gitDiffForJev*` functions and `gitDiff` in review.ts are near-identical copies of each other (same Bun.spawn / exit-code / throw body). The jev headers justify it by an export-surface constraint, so it is a known decision, not introduced here; the PR only adds one more repeated line to each.

### Verified clean
- Naming: `hasDashValue`, `assertGitRevision`, test names and constants (`HOSTILE`, `JEV_HOSTILE`) are intention-revealing.
- Comments: the new comments state intent (why `=` values are judged as words, why the jev tests need a source pin) and match the code; no commented-out code.
- Functions: `hasDashValue` (one regex line) and `assertGitRevision` (two lines) are single-purpose; hasExecFlag stays under 10 lines and terminates.
- Error handling: `assertGitRevision` throws a message that names the offending ref; no swallowed catch, no log-and-rethrow.
- Over-blocking spot check on the PR's own tests: `--stat=100`, `--format=--oneline`, `-- x=-c`, `--base=a=b`, `--x=-1` on non-review rows stay routine, as the third F-045 test states.

No code was edited, staged or committed. Routing audit: graph_used no (not-relevant, 8-file diff read directly), wiki_used no (not-relevant), ctx_used yes (keryx ctx rg), raw_rg_used no.

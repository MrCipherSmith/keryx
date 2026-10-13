STATUS: DONE

```REVIEW_RESULT
{
  "status": "DONE",
  "reviewer": "review-style",
  "summary": "Style and conventions are clean overall: naming, comment/doc style, test titles and import placement match neighbouring code. Three small points: the same --end-of-options operand is spelled inline at seven call sites and pinned by a text-counting test, the helper name promises more than it checks, and one explanatory comment misattributes who reads the glued value.",
  "findings": [
    {
      "id": "F-S01",
      "severity": "minor",
      "reviewer": "review-style",
      "file": "src/commands/review-revision-operand.test.ts",
      "quote": "expect(text.split(needle).length - 1, `${file}: ${needle}`).toBe(times);",
      "problem": "The operand `[\"--end-of-options\", assertGitRevision(ref)]` is copied verbatim into seven call sites (review.ts x2 plus six jev files, each already a copy of the same gitDiffFor* helper). The last test then guards them by counting that exact source text in each file.",
      "impact": "DRY plus a brittle guard: a reformat or rename breaks the test with no behaviour change, while a new git call site that takes a typed ref and omits the operand is not caught at all. Maintainability only, no functional effect today.",
      "evidence": "pr1005.diff: the identical `...(ref === undefined ? [] : [\"--end-of-options\", assertGitRevision(ref)])` appears in review-jev-{select,risk,rules,docs,scenarios,contract}.ts and in review.ts (gitChangedFiles, gitDiff); the pin test is src/commands/review-revision-operand.test.ts lines 263-278.",
      "suggested_fix": "Export one helper from src/lib/git-revision.ts, e.g. `revisionOperand(ref: string | undefined): string[]` returning `[]` or `[\"--end-of-options\", assertGitRevision(ref)]`, and call it at each site. The pin test then counts one short token (`revisionOperand(`) instead of a long literal.",
      "confidence": "high",
      "location_class": "in-diff"
    },
    {
      "id": "F-S02",
      "severity": "info",
      "reviewer": "review-style",
      "file": "src/lib/git-revision.ts",
      "quote": "export function assertGitRevision(ref: string): string {",
      "problem": "The name reads as 'this is a valid git revision' but the function only rejects a leading `-`; `assertGitRevision(\"not a ref\")` returns normally.",
      "impact": "A future caller may skip an existence or format check believing it is done here. The doc comment is accurate; the name is the only thing that over-promises.",
      "evidence": "git-revision.ts lines 344-347 of the diff: one startsWith(\"-\") test, nothing else.",
      "suggested_fix": "Rename to say what it checks, e.g. `assertNotOption` or `assertRevisionOperand`, or keep the name and state 'shape only, not existence' in the first doc line.",
      "confidence": "medium",
      "location_class": "in-diff"
    },
    {
      "id": "F-S03",
      "severity": "info",
      "reviewer": "review-style",
      "file": "src/lib/trust-routine-command.ts",
      "quote": "// a revision, and the next layer down may read it as an option, so every `=` value is judged as a word of its own.",
      "problem": "The comment (and the matching test comment 'git reads an option glued on with = as a revision's value') says git reads the glued value as a revision. In the bug the glued word is parsed by keryx's own `--ref=` handling, which then hands the value to git; 'an option it does not know' does not describe that path.",
      "impact": "Misleading explanation for the next reader of the gate; the code itself is right.",
      "evidence": "src/lib/trust-routine-command.ts, the two-line comment above hasExecFlag; src/commands/review.ts gitDiff passes the --ref value to git. Not executed against git (raw git was blocked by the ctx hook), so confidence is low.",
      "suggested_fix": "Reword: 'keryx hands the value glued after `=` (`--ref=...`) on to git, which reads an option-shaped value as an option, so every `=` value is judged as a word of its own.'",
      "confidence": "low",
      "location_class": "in-diff"
    }
  ],
  "stats": { "blocker": 0, "major": 0, "minor": 1, "info": 2 }
}
```

# Style review, PR 1005, round 1

Verdict: APPROVE_WITH_SUGGESTIONS. Domain only (naming, readability, repo conventions); completeness of the ref class and the gate logic are other reviewers' lanes.

## Findings (by severity)
- Minor F-S01: the `--end-of-options` operand is copied into seven sites and guarded by a source-text counting test. Extract a `revisionOperand(ref)` helper.
- Info F-S02: `assertGitRevision` only checks a leading `-`; the name over-promises.
- Info F-S03: the comment above `hasExecFlag` says git reads the glued value; keryx parses `--ref=` first.

## Questions
- None.

## Pre-existing
- The six `gitDiffFor*` helpers (select, risk, rules, docs, scenarios, contract) plus `gitDiff` in review.ts are near-identical copies of one function; the file headers say this is deliberate (flow-concurrency isolation). Not this PR's doing, and the reason F-S01 spans seven sites.
- Many lines in these files exceed 140 characters (review-jev-rules.ts has 20+); eslint.config.mjs is the only linter config, no formatter width is configured, so no rule is broken.

## Verified clean
- New file src/lib/git-revision.ts: kebab-case name matching neighbours (git-head.ts, git-toplevel.ts), JSDoc on the one export, no console use, no dead code.
- Import placement of `assertGitRevision` is consistent across all eight files (right after `../lib/args` or beside the other `../lib` imports); no unused imports.
- Comment style matches the files (`//` block above a private function, `/** */` on the new exported/predicate helpers).
- Test titles follow the file's convention (`F-045: ...`, `Flow 441` header comment); `hasDashValue` is named like its neighbour `hasExecFlag`; no console noise.

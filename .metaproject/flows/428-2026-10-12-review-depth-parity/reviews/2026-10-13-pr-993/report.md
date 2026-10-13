# Review of PR 993 (flow 428, review depth parity)

Orchestrator: vantage-review. Generic engine: review-orchestrator. Mode: all.
Head: 9f7f7368c698978017218b4406dc792a8f2ea1fb. Base: 0ca99fb1.

Reviewers that ran (9 of 9 required): review-architecture, review-clean-code, review-highload, review-logic, review-performance, review-regression (scope B), review-security-code, review-style, review-testing-practices. Mutation pass: 30 mutants, 24 killed, 6 survived, 0 invalid, 0 timeout. Vantage overlays: none selected (no retained file matches a Vantage path); the repository is not the Vantage frontend.

Not run: review-backend, review-frontend, review-frontend-conventions (stack not detected); review-core-boundaries, review-flow-graph, review-layout (no matching paths). Project-local reviewer packages: none registered for this round.

Not verified in this environment: `bun run docs:build` exited 127 (mkdocs not installed), so the strict docs build of AC11 is unverified here. AC9 and AC10 are live runs by the operator.

Clean: review-performance, review-highload, review-regression returned no findings.

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "review-testing-practices#F-001",
    "severity": "minor",
    "file": "src/review/mutate.test.ts",
    "quote": "for (const row of rows) expect(row).toContain(\"check.js\");",
    "problem": "The new table assertions leave three parts of the AC4 table unpinned: the \"-\" placeholder for a row with no exit code, the two new header columns, and the pipe escape of the command cell.",
    "impact": "A regression in the exit placeholder, the table header or the escaping of the command column passes CI; the rendered table can break for any test command containing a pipe.",
    "suggested_fix": "Assert rows[2] contains \"| - |\", assert the header contains \"| Test command | Exit |\", and add a row whose command contains a pipe to check the \\| escape.",
    "evidence": "mutant:M4 survives (exit placeholder - to 0); mutant:M5 survives (header loses Test command and Exit); mutant:M6 survives (cell() dropped on the command). Run: keryx review mutate, mutation-1.json, 30 mutants, 24 killed, 6 survived.",
    "confidence": "high",
    "reviewer": "review-testing-practices"
  },
  {
    "id": "F-002",
    "global_id": "review-logic#F-002",
    "severity": "minor",
    "file": null,
    "quote": null,
    "problem": "The PR body says globToRegExp now treats a trailing ** as .* and names that as the AC2 root cause. The diff does not touch src/review/coverage.ts; the trailing-** branch is already in globToRegExp at the merge-base, and the PR only adds a test pinning it.",
    "impact": "AC2 requires that the PR names the root cause; the description attributes to this PR a fix that is not in it, so whoever reads the merge commit later is misled about where the fix lives.",
    "suggested_fix": "Reword the body: globToRegExp already maps a trailing ** to .* on main (name the commit); this PR pins it with a test.",
    "evidence": "git diff 0ca99fb1..9f7f7368 --stat lists 7 files, coverage.ts is not among them; src/review/coverage.ts:43-51 holds the trailing-** branch at the merge-base. Reported independently by review-logic and review-style.",
    "confidence": "high",
    "reviewer": "review-logic"
  },
  {
    "id": "F-003",
    "global_id": "review-logic#F-003",
    "severity": "minor",
    "file": "src/gdskills/reviewer-triggers.test.ts",
    "quote": "describe(\"a project reviewer's description gate selects the files it names (flow 428 AC2)\", () => {",
    "problem": "AC2 asks for selection in both diff and all modes and for no no-matching-paths exclusion. The new test stops at reviewerPathGate plus globToRegExp and never calls requiredReviewers. It also packs two descriptions and positive and negative cases into a single test.",
    "impact": "A regression in how requiredReviewers applies the project gates, or in the no-matching-paths exclusion, passes this pin; a failure message does not say which case broke.",
    "suggested_fix": "Extend the dispatch.test.ts fixture with description-gated skills and assert requiredReviewers includes them in both modes with no no-matching-paths exclusion; split the cases.",
    "evidence": "The test body calls only reviewerPathGate and globToRegExp; coverage.ts:99 (projectGates) is not exercised by it.",
    "confidence": "medium",
    "reviewer": "review-logic"
  },
  {
    "id": "F-004",
    "global_id": "review-architecture#F-004",
    "severity": "minor",
    "file": "src/review/mutate.ts",
    "quote": "/** The test command this row was judged by. */",
    "problem": "MutantResult.command is required, but mutation-<n>.json is also the on-disk format with schemaVersion still 1, and three readers cast parsed JSON to MutationRecord unchecked. Records written before this change have no per-row command, so the type claims more than the data gives. The value also duplicates MutationRecord.command on every row.",
    "impact": "Nothing breaks today: the readers never touch m.command and renderMutationTable only receives a fresh record. A future caller rendering an old record from disk would throw inside cell(undefined), which tsc cannot catch.",
    "suggested_fix": "Render with cell(m.command ?? record.command) and note that older records lack the field, or make the field optional on the read side; add a test with a row without command; say in the comment that it repeats the record value so a row stands alone.",
    "evidence": "severity-audit.ts, tui/review-panel.ts and mutate.ts pendingMutants read parsed JSON as MutationRecord; review-panel.test.ts builds a row without command and compiles because it is cast.",
    "confidence": "high",
    "reviewer": "review-architecture"
  },
  {
    "id": "F-005",
    "global_id": "review-style#F-005",
    "severity": "minor",
    "file": "docs/docs/guides/review-with-a-record.md",
    "quote": "The table in `research-evidence/mutation-<n>.md`",
    "problem": "The inserted sentence was not re-flowed: the paragraph now has lines of about 120 characters, a short stub, and a long line, against the roughly 80-column wrap used elsewhere in the file.",
    "impact": "The next edit to this paragraph produces a noisy diff; nothing is wrong when rendered.",
    "suggested_fix": "Re-flow the paragraph to the file's wrap width, wording unchanged.",
    "evidence": "docs/docs/guides/review-with-a-record.md lines 161-168.",
    "confidence": "high",
    "reviewer": "review-style"
  },
  {
    "id": "F-006",
    "global_id": "review-clean-code#F-006",
    "severity": "minor",
    "file": "src/review/mutate.ts",
    "quote": "${m.exitCode ?? \"-\"} |`,",
    "problem": "The row template of renderMutationTable now has seven interpolations, a nested template and a nested conditional on one line of about 200 characters, and the header and separator strings must be kept in step with it by hand.",
    "impact": "Adding the next column means splicing into the densest line of the function and editing the header and separator separately.",
    "suggested_fix": "Build the row from an array of named cells joined with \" | \", and derive the header and separator from the same list.",
    "evidence": "src/review/mutate.ts renderMutationTable; reported by review-clean-code (minor) and review-style (info).",
    "confidence": "medium",
    "reviewer": "review-clean-code"
  },
  {
    "id": "F-007",
    "global_id": "review-testing-practices#F-007",
    "severity": "info",
    "file": "src/review/dispatch.test.ts",
    "quote": "expect(quoted.join(\" \")).not.toContain(\"operatorQuote\");",
    "problem": "A negative substring proxy: the assertion that no operator quote is present passes whenever the text lacks the word operatorQuote, so rewording the refusal message would leave it green while no longer checking anything. expect(quoted).toEqual([]) states the intent directly.",
    "impact": "A vacuous check in a test; it cannot fail for the reason it was written.",
    "suggested_fix": "Replace with expect(quoted).toEqual([]).",
    "evidence": "coverage.ts:196-197 puts {operatorQuote, reason} in the missing-reviewers message.",
    "confidence": "medium",
    "reviewer": "review-testing-practices"
  },
  {
    "id": "F-008",
    "global_id": "review-security-code#F-008",
    "severity": "info",
    "file": "src/review/mutate.ts",
    "quote": "const cell = (value: string) => value.replace(/\\|/g, \"\\\\|\").replace(/\\n/g, \" \");",
    "problem": "cell() escapes only a pipe and a newline; a backtick or a carriage return in an operator-supplied --test command ends the code span or the row early in mutation-<n>.md. Present before this PR; the PR adds one more caller.",
    "impact": "A malformed table in a review record; the only party who can set the string already has shell execution through the same string.",
    "suggested_fix": "Optional: also replace carriage returns and render the command with a backtick-length-aware span.",
    "evidence": "review-security-code ran renderMutationTable with a command holding a backtick and a CR; the row kept both.",
    "confidence": "high",
    "reviewer": "review-security-code"
  }
]
```

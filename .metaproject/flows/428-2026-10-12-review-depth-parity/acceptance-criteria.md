# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: For a pull-request target `keryx review required` defaults to the full applicable set (mode `all`); `diff` is accepted only with an operator quote, and `dispatch` refuses `diff` without one. The autonomous-profile prompt and the review-orchestrator skill say the same. [verify: exec `bun test src/review/dispatch.test.ts src/review/autonomous-profile.test.ts src/gdskills/reviewer-triggers.test.ts`]
- AC2: A project-skill reviewer whose paths come from its description is selected when the scope matches: scope `src/pipelines/index.ts` includes `review-vantage-domains`, scope `src/core/x.ts` includes `review-vantage-core`, in both `diff` and `all` modes. No reviewer whose paths match the scope is excluded as `no-matching-paths`. A regression test pins both cases and the PR names the root cause. [verify: exec `bun test src/gdskills/reviewer-triggers.test.ts`]
- AC3: `review-regression` is in the required set whenever a blast radius was computed for the package, and absent with the reason recorded when none was. [verify: exec `bun test src/review/dispatch.test.ts`]
- AC4: `keryx review mutate` runs the mutants proposed by the testing reviewer in a copy of the worktree (never in the original), requires an exact anchor match per mutant, discards the copy in `finally`, runs the targeted tests, and writes one row per mutant (id, anchor, killed|survived|invalid|timeout, test command, exit code) under the package's `research-evidence/`. The original tree is byte-identical before and after. [verify: exec `bun test src/review/mutate.test.ts`]
- AC5: `keryx review complete` refuses `Not run: mutation pass` when the testing reviewer returned pending mutants, the tests are runnable and the run is attended (not `review run --autonomous`), unless the waiver carries an operator quote. The unattended rule is unchanged. [verify: exec `bun test src/commands/review-ledger.test.ts`]
- AC6: A severity audit step (separate from the verifier, which still only deletes) raises a finding to major when its own evidence is a surviving mutant on a behaviour change without a pinned assertion, and records the evidence id. Without an executed run the finding stays minor and carries the label `unproven`. [verify: exec `bun test src/review/ledger.test.ts`]
- AC7: The collected pull-request context holds the full text of every review comment (no 800-character cut), the round-1 intent, the CI status and the backend pins named in the PR, and reviewer payloads receive it. [verify: exec `bun test src/review/context-collect.test.ts`]
- AC8: A repeatable comparison command reads a reference report (Claude's `report.md` item list) and a keryx package and prints, per reference item, the class A (role not run), B (role ran, finding absent), C (lost after the answer), D (kept, with severity) or E (execution pass not run), and the totals. [verify: exec `bun test src/review/compare-reference.test.ts`]
- AC9: Live: `keryx review` on PR 7659 by default (no narrowing, attended, with `keryx review mutate`) reproduces at least 12 of Claude's 19 items by the AC8 comparison, with class A equal to 0 and the main item (explore params unpinned) as a major backed by a surviving mutant. The comparison, token count and duration are recorded next to the 12.10 figures (5 raw findings, 3 minor, no mutation pass). [verify: judged]
- AC10: Control: the same default review on PR 7840 raises no major that the operator rejects; the operator reviews the majors on both PRs and signs. [verify: judged]
- AC11: The review panel in the TUI shows the review mode, the reviewer set with excluded roles and reasons, and the mutation result. `keryx help`, `docs/docs/cli-reference.md` and `docs/docs/guides/review-with-a-record.md` describe `review mutate`, the default mode and the compare command, and the docs build passes. [verify: exec `bun test src/tui/review-panel.test.ts && bun run docs:build`]

# Implementation Plan

Status: draft (operator reviews PRD and acceptance criteria before freeze)

## Approach

Fix the losses in the order of their measured weight (`~/notes/review-depth-gap-7659.md`), each as its own small change with a regression test, then prove it on the same pull request that exposed it. The comparison command (T1) comes first because every later task is judged by it.

## Steps

1. T1 Comparison command `keryx review compare-reference` (AC8); load Claude's 19 items for #7659 as the fixture reference.
2. T2 Path-gate defect (AC2): find where description-derived path globs are dropped before matching in `required`/`skipped`, fix it, add regression tests for both pairs.
3. T3 Default mode `all` for pull requests, `diff` only with an operator quote, in `required`, `dispatch`, `autonomous-profile` and the review-orchestrator skill (AC1). Add `review-regression` to the required set when a blast radius exists (AC3).
4. T4 `keryx review mutate` (AC4) and the attended-run close rule (AC5).
5. T5 Severity audit step in the ledger (AC6).
6. T6 Context collector: full comments, round-1 intent, CI status, backend pins (AC7).
7. T7 TUI review panel, help and docs (AC11).
8. T8 Live reruns on #7659 and #7840 with the operator in Telegram (AC9, AC10); results into `~/notes` and the flow journal.

## Risks

- A live rerun costs several million tokens and an hour of provider time; provider overloads need the same hand-continuation as the 12.10 run.
- Mutants run project tests in a copy: the copy needs the dependency tree (symlinked `node_modules` or a cheap clone), and the targeted-test command must come from the reviewer, not be guessed.
- Raising severity from mutants can overstate: a survivor in a weak test is evidence of a test gap, which is major only under the project's testing gate. The audit step must cite that rule.
- The reference list is one reviewer's output: "at least 12 of 19" measures parity with one baseline, not truth.

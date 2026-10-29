# Implementation Plan

Status: ready for freeze

## Approach

Two coupled pieces of the `review-engine-speedup` package (step 1 of 5, operator order from poll 293).

R1 gives the orchestrator a way to tell, from the engine, that it may go on. `reviewNext` computes `planAuthorized` from `packagePlanGate` over the in-memory (escalated) manifest, so plan growth shows before `--apply`; `continue` is `planAuthorized === true` with something to dispatch. The text mode prints one continuation line after the first line. The Claude Code rule itself lives in the `review-orchestrator` skill (item "One batch", exception to "Open question"), because the shell gate `decideReviewGate` only covers the keryx shell host.

R2 makes the pause visible. The command layer (`runNext`) appends one event per call, plus `idle` events, to `<package>/tool-calls/wave-events.jsonl` in a single `O_APPEND` write that never throws. `reviewNext` stays pure and read-only, and nothing reads the journal to decide anything. The parity view reads the `idle` events and carries one line to `status`, `report-parity`, the review panel and the sidebar.

Not bent to the text of the package: where the documents and the code disagree the code wins and the difference goes into the report (see `verification.md`).

## Steps

1. `src/review/wave-events.ts`: event types, thresholds, idle gaps A/B, `recordWaveEvents`.
2. `src/review/review-next.ts`: `planAuthorized`, `continue`, `CONTINUE_LINE`, the restated read-only line.
3. `src/commands/review-next.ts`: record after printing, idle lines (stdout, or stderr under `--json`), help text.
4. `src/review/parity.ts`: `gaps` in the view, the line in `parityLines` / `paritySummary` / `renderParityReport`.
5. Tests: `review-next.test.ts`, `wave-events.test.ts`, `parity.test.ts`, `review-parity-cli.test.ts`, `commands/review-next.test.ts`.
6. Skill: the R1 rule in `review-orchestrator/SKILL.md` and `SKILL.detail.md`, installed and bundled copies byte-identical.
7. Docs: `cli-reference.md`, docs site review pages, README, CHANGELOG `[Unreleased]`.
8. Acceptance on copies of the closed vantage-frontend packages; cost of `packagePlanGate` inside `next`; `verification.md`.

## Risks

- A wait for an operator card looks like an idle gap in the journal: the line says so and is never a warning.
- `packagePlanGate` adds a read of the estimate to every `next`: measured in step 8.
- The skill rule is prose; it holds only as far as the host follows it. The evidence is the journal on later live rounds (outside this flow).

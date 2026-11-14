# Review signal and cost: usage capture, one severity rubric, bounded report, seeded benchmark (audit P1)

Status: draft
Source: docs/analysis/review-process-audit-2026-11-12.md, sections "Критичные находки" 5-6, "Функциональность", "Продукт" (origin: agent-finding)

## Problem

Nobody can say what a review round costs, how long it takes, or how precise it is, and the report buries its verdict.

- Token usage reads `known=0` in every modern package and wall-clock time is recorded nowhere, while a round dispatches 22-26 agents (audit run-history numbers, not recomputed).
- 79% of 739 retained findings are `minor` or `info`; the verifier refutes about 2% and the premise judge upholds 95%. Only 17 findings carry a disposition, so precision cannot be read, and no seeded-bug benchmark exists for the core reviewers.
- The canonical rubric says `blocker` is exactly four shapes, yet `review-highload` rates checklist items `blocker` 11 times and `review-backend` 7 times; `review-frontend` and `review-logic` do the same.
- The orchestrator teaches `class_scope.sites: []` for negative enumeration (`SKILL.md:1361`) while `reviewer-finding.schema.json:158` requires `minItems: 1`.
- Reviewer skills carry inline markdown finding templates (`Why it matters` / `Fix`) that omit the `evidence` and `confidence` fields the schema requires.
- `report.md` embeds the whole findings JSON after the readable part (23k words for PR 1124).
- "Cross-family review" records an intention; `keryx providers cross-family` never dispatches a reviewer (`src/standard/command-registry.ts:1742-1743`).
- `stack_requires` dispatches a reviewer when any listed tag is present (`SKILL.md:861`), so a React project without MobX gets the MobX lane.

## Expected Outcome

Every closed round states its measured cost and duration, reviewers apply one severity rubric and one finding contract, the published report leads with the verdict and stays short, and a seeded benchmark gives a precision and recall number for the core reviewers that CI reproduces.

## Outcome criteria

- Источник: docs/analysis/review-process-audit-2026-11-12.md
- Эффект (формализация агента): a closed review package records tokens and wall-clock per dispatch and prints them in the report; no bundled reviewer skill assigns a severity outside the canonical rubric; the skill text and the finding schema agree; the report body is bounded; a benchmark over seeded defects reports precision and recall for the core reviewer set.
- Как наблюдать (предложение агента): run one managed round on a real PR after the flow lands and read the first lines of `report.md` (time, tokens, verdict); run the benchmark command and compare its numbers with the committed baseline.

## Out of Scope

- Changing which reviewers `keryx review required` selects, beyond the `stack_requires` semantics.
- A round state machine and module restructuring (flow 490).
- CLI help, glossary and guide (flow 491).

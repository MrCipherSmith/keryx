# Review quality rules: SHA pinning, ledger gate, evidence level

Status: draft, criteria awaiting operator approval before freeze
Source: agent proposal (origin: agent-proposal)

## Problem

A consumer project (vantage-frontend) proposed eight general review-quality rules: check the PR state and head SHA before
publishing; close the ledger after each wave; record every exclusion; verify blockers and majors against the source at the
reviewed SHA, rebuttals included; state the evidence level; keep one report format across rounds with the formal state
following severity; keep refuted and narrowed claims; pin every link to the reviewed SHA as path:line.

The review-orchestrator skill states some of them in prose (for example "if head moved, re-check findings"). Our benchmark
showed that prose gates leak, so each rule must be a command gate or a required report field, not an instruction.

Verified against origin/main 0.3.113: rules 2 (ledger gate), 3 (exclusions) and 6 (format and state) are already enforced;
the refuted half of rule 7 too. Open gaps: head check in `review complete` (1), evidence level (5), rebuttal citations (4),
the `narrowed` disposition (7), locator at the reviewed SHA (8).

## Expected Outcome

Each rule is enforced by `keryx review` (ingest, coverage, severity-audit, complete) or is a required field of the report
template, and the review-orchestrator skill states the rule once, short, pointing at the gate.

## Outcome criteria

- Источник: cross-session message from vantage-frontend-b1 relaying an operator proposal (8 rules), 2026-10-14; operator approved opening the flow, helyx message 204056 «Да»
- Эффект (формализация агента): отчёт ревью нельзя завершить, пока не названы проверенный SHA и состояние PR, ledger не READY, исключения не записаны, уровень доказательств не указан, а ссылки не привязаны к SHA.
- Как наблюдать (предложение агента): `keryx review complete` отказывает на пакете без этих полей и называет, чего не хватает; на полном пакете проходит; шаблон отчёта одинаков в раундах 1 и 2.

## Out of Scope

Project-specific references (rules and documents of any one consumer project). Changes to the reviewers' own prompts.

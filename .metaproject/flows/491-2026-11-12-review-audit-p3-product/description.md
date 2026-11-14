# Review product surface: one-command review, human help, glossary, deduplicated guide (audit P3)

Status: draft
Source: docs/analysis/review-process-audit-2026-11-12.md, section "Продукт" and "Харнесы" (origin: agent-finding)

## Problem

A new user cannot get a first finding from the CLI or the docs without learning the orchestrator's internals.

- There is no command that reviews the current branch. A bare `keryx review start` only writes `round.json`, yet `onboarding.md` offers it as the review step.
- `keryx review --help` lists 58 subcommands and 154 flags in 568 lines with no mental-model paragraph; a human would type about eight of them (audit count, the split is an estimate).
- The vocabulary (round, package, wave, slice, chunk, layers, ledger, floor, arbiter, premise, readiness, obligation, disposition, jev, tier) has no glossary.
- `docs/docs/guides/review-with-a-record.md` repeats five sections twice (lines 588-921 and 965-1102) and is 10.7k words.
- The docs do not say which harness gets what: Codex, opencode and Grok run the round through the autonomous runner on keryx's own provider; Claude Code has no operator cards.
- Only 2 of 36 packages are closed and no metric shows how many rounds a change needs.

## Expected Outcome

One command reviews the current branch, help separates the human surface from the agent surface, the docs give a short path to a first finding with a glossary and an honest capability matrix, and the product reports its own convergence.

## Outcome criteria

- Источник: docs/analysis/review-process-audit-2026-11-12.md
- Эффект (формализация агента): a person who has never used keryx review gets a first report from one documented command, and can tell from the docs what their harness supports.
- Как наблюдать (предложение агента): follow the quick-start on a fresh clone with a small diff and count the commands and terms needed before the first report; read `keryx review --help` top to bottom.

## Out of Scope

- New reviewer capabilities, gate behaviour and report content (flows 488, 489).
- The step command and host port themselves (flow 490); this flow documents and exposes them.
- Running the CI review bot against real GitHub.

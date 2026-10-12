# Keryx Shell: review orchestration completes a round (follow-through, trust mode, 200 rounds)

Status: approved by operator (helyx 195233), frozen
Source: live run of the review of Presight-AI/vantage-frontend PR 7435 on a keryx shell, 2026-10-09 (flow 417, AC16). Findings: `~/notes/flow-417-ac16-findings.md`, section A (A1-A21).

## Problem

The same review that Claude finished in 17m58s (2 waves x 10 reviewers, 5 Majors) did not finish in a keryx shell
(openai-codex/gpt-6-luna) in 2h20m and 4.3M input tokens: 4 attempts at Wave A, 0 findings. Causes seen in the run:

- The turn ends with open plan items ("follow-through is off") five times; an operator had to nudge each time (A1).
- The main agent's tool-round limit (40) interrupts a long orchestration and asks what to do (A2).
- Mode `trust` still asked for approvals at first and answered inconsistently after (A10); typed answers to orchestrator questions (counterpart, model plan, budget) are not kept, so they are asked again (A17).
- Reviewer executors run out of rounds reading a 1.65 MB diff, scope B and schemas, and return INCOMPLETE/BLOCKED (A5, A20); the shell dispatched 3 of 10 reviewers and does not retry with a smaller slice (A21).
- Dispatch is assembled by hand from skill prose: reviewer got no slices and no payload (A19); `keryx ctx run` output replaced a machine JSON artifact (A14); the read tool cannot open a sibling worktree (A13).
- Slash commands are dropped while main is busy (A3); Ctrl+C closes the whole shell (A4).

## Expected Outcome

An operator starts a review of a large PR in a keryx shell in mode `trust`, and the shell carries it to `review complete`
without a human nudge: waves of up to 10 reviewers, each with a bounded input that fits its round budget, honest
INCOMPLETE handling with an automatic retry on a smaller slice, and a final report.

## Outcome criteria

- Запрос (дословно): «Заводи, так же нужно починить режим trust, и для него увеличить количество раундов. Например с 40 до 200» (source: helyx 195221, 2026-10-09T19:42Z)
- Эффект (формализация агента): in `trust` mode the main agent's tool-round limit is 200 instead of 40, no approval prompt appears for commands trust is meant to allow, and a review of a large PR runs to its report without the operator typing anything.
- Как наблюдать (предложение агента): repeat the PR 7435 review in a keryx shell in `trust` mode, issuing no input after the task; it ends with a `review complete` and a report, no turn ends with open plan items.

## Out of Scope

- Telegram delivery of prompts and progress (flow 419).
- The Claude skill review-orchestrator (flow 417, merged).
- The model's own review quality.

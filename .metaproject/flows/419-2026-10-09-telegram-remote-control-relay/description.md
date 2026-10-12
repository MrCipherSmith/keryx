# Keryx Telegram: remote-control relays approvals, questions and progress

Status: approved by operator (helyx 195233), frozen
Source: live run of the review of PR 7435 on a keryx shell mirrored into a Telegram topic, 2026-10-09 (flow 417, AC16). Findings: `~/notes/flow-417-ac16-findings.md`, section B (B1-B6).

## Problem

With `/remote-control` the operator cannot run a shell from Telegram alone. Seen in the run:

- Approval prompts of the shell do not reach the topic; the shell waited ~17 minutes (B1).
- The operator cannot enable `/route on` or `/external on` from Telegram: commands are dropped while main is busy (B2).
- Only final replies reach the topic; waves, statuses and progress are invisible for hours (B3).
- Closing the shell, or Ctrl+C, deletes the topic and the conversation with it (B4).
- A status question from Telegram is queued behind the running turn and answered only when it ends (B5).
- `ask_user` menus show only in the terminal, not as a Telegram poll (B6).

## Expected Outcome

An operator who starts a shell with `/remote-control` can approve, answer, steer and follow a long run from the
Telegram topic, without touching the terminal.

## Outcome criteria

- Запрос (дословно): «То, что потом через Keryx Surf приходит в Telegram, это тоже записываю, но это как отдельная проблема, которую мы будем потом фиксить и вообще дорабатывать Keryx Telegram.» (source: helyx 195182, 2026-10-09; «Заводи» helyx 195221)
- Эффект (формализация агента): every prompt the shell shows in the terminal also reaches the topic and its answer from the topic unblocks the shell; progress is visible; the topic survives the shell.
- Как наблюдать (предложение агента): run a long review in a shell with `/remote-control`, leave the terminal, and finish it from Telegram only.

## Out of Scope

- Shell orchestration, trust-mode limits and follow-through (flow 418).
- Telegram transport changes unrelated to the shell mirror.

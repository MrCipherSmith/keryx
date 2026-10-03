# Telegram permissions parity with shell

Status: draft (PRD in docs/requirements/keryx-telegram-permissions/prd.md)
Source: user description (origin: human-request; helyx-channel message 178829, 2026-10-02T19:14Z, decisions in poll 47)

## Problem

A run started from Telegram asks about almost every edit and shell command, an unanswered request expires after 5 minutes, a run is cut after 30 minutes, and the topic has no way to stop a run or to say "always allow". The cause is not a stricter Telegram profile: a Telegram turn runs in the shell under the shell's default permission mode `ask`, its approver skips the saved allowlist, and the Telegram prompt has only Allow and Deny.

## Expected Outcome

A Telegram-started run behaves like the shell with `trust` by default: reads and non-destructive edits and commands inside the project run without a prompt, dangerous things still ask. There is no per-run limit and `/stop` ends a run. A permission request waits 15 minutes. The Telegram prompt can say "Always allow", which saves a scoped rule that is visible and revocable in the shell. The posture is visible in `/settings`, the sidebar and `keryx serve status`.

Decisions taken with the operator (poll 47): default posture "like the shell"; no per-run limit, stopped with `/stop`; approval wait 15 minutes.

## Outcome criteria

- Запрос (дословно): «А зачем такие ограничения? Я говорил, что телеграм должен быть интерфейсом, по возможности предоставляя максимальную функциональность как keryx shell? Как в helyx реализованы пермиссии? Он почти меня не спрашивает.» (source: helyx-channel message 178829 (2026-10-02T19:14Z), decisions in poll 47)
- Эффект (формализация агента): from Telegram the operator can run an ordinary task (edit files, run read and build commands) without tapping anything, is asked only for dangerous steps, can teach the shell a rule with one tap, and can stop a long run with `/stop`.
- Как наблюдать (предложение агента): in the topic geekom:keryx a task that edits files and runs a Docker status check completes with no prompt; a destructive step asks and the prompt is still valid after 10 minutes; "Always" on a command means it is not asked again; a run past 30 minutes keeps going until `/stop`; `keryx serve status` shows the posture.

## Out of Scope

A new harness policy profile; any change to `serve.json` profiles or the HTTP serve approval broker; the `auto` mode from Telegram configuration; a network sandbox for Telegram turns; who may talk to the bot (`allowedUserIds` is unchanged).

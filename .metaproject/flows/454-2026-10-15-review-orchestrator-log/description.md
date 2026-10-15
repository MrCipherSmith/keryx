# Review orchestrator call log written by keryx

Status: draft
Source: operator decision (poll 180, 2026-10-15), follow-up of flow 452. PRD: `docs/requirements/keryx-review-orchestrator-log/prd.md`.

## Problem

Flow 452 added the readiness item `memory-outside-stage`. It reads `<package>/tool-calls/orchestrator.jsonl` and blocks `completed` and publishing when the orchestrator made a memory call other than its single stage query. Nothing writes that file: the review-orchestrator skill asks the host agent to append its own tool calls. An agent that forgets, or that is the one reading its own memory, leaves no log, and the item then passes with "no orchestrator tool log". The check depends on the behaviour it is meant to check.

## Expected Outcome

keryx writes the orchestrator's call log itself, from the layers that execute a memory call: the `keryx memory` CLI, the keryx MCP memory tools and the keryx shell tool executor. The active review package is named by a pointer that `review start` writes and `close` removes. Each line carries a `caller` (orchestrator, a reviewer id, or `unattributed`). Unattributed calls only warn in the readiness item (operator decision D1). The skill stops asking the agent to write the file.

## Outcome criteria

- Источник: оператор в опросе 180 (ответ 1: автоматический лог отдельным флоу, из слоя shell/tools), D1 и заморозка в опросе 182, 2026-10-15.
- Эффект (формализация агента): пункт `memory-outside-stage` перестаёт зависеть от того, пишет ли агент лог сам; «лога нет» отличимо от «вызовов памяти нет».
- Как наблюдать (предложение агента): ревью, прогнанное в keryx shell, оставляет `tool-calls/orchestrator.jsonl` со строкой `log-start` и вызовами памяти оркестратора без участия агента в записи.

## Out of Scope

- Reading or blocking the agent's own memory (not visible to keryx).
- The stage rule, `cleanContext`, the nine other readiness items, reviewers' own logs, `layersUsed`.
- Tamper-evidence of the log.

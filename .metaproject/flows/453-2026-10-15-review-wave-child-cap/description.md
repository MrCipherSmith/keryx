# Review dispatch counts child agents per chunk wave

Status: draft
Source: agent finding in review 7643, decided by the operator (poll 181)

## Problem

`SUBAGENT_TURN_MAX_CHILDREN = 32` (`src/harness/tool/builtin/spawn-subagent-tool.ts:337`) caps the children one parent turn may spawn; the ledger is renewed only by `resetBudget()` at a new parent turn. A deep review with chunk waves runs in one orchestrator turn and reaches 32; the next reviewer is refused. In review 7643 this rejected the Sigma reviewer and left the package draft/INCOMPLETE until the operator told the agent to continue.

## Expected Outcome

The per-turn cap stays. A review dispatch passes the wave it belongs to, and each valid wave has its own counter of 32. A wave name is accepted only if it names a pass of the package's recorded chunk plan, so the model cannot lift the cap by inventing names; the number of waves is bounded by the chunk plan (`DEFAULT_MAX_PASSES` = 25).

## Outcome criteria

- Источник: агент нашёл лимит в прогоне ревью 7643 (пакет ...--r03: Sigma отклонена лимитом MAE child count 32); способ починки выбрал оператор в опросе 181, 2026-10-15.
- Эффект (формализация агента): глубокое ревью в нескольких волнах не упирается в 32 дочерних агента за ход; лимит остаётся fail-closed.
- Как наблюдать (предложение агента): ревью с чанк-планом из нескольких волн, где суммарно больше 32 ревьюеров, проходит без отказа "child count"; выдуманное имя волны по-прежнему упирается в 32.

## Out of Scope

- The default 32, the runtime pool (16 concurrent children), other spawn paths.
- Chunk planning itself (flows 204 and 451).

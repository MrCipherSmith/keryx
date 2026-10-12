# Round limit by permission mode: 40 ask, 120 trust, 200 auto, no human prompt in auto

Status: frozen; criteria revised 2026-10-12 after operator message 199701
Source: user description (origin: human-request)

## Problem

A turn of the agent loop is capped at `DEFAULT_MAX_ROUNDS = 40` model rounds in every permission mode
(`src/commands/agent.ts`). `200` is only the ceiling for `KERYX_AGENT_MAX_ROUNDS`
(`MAX_AGENT_MAX_ROUNDS`), never a default. The shell passes the resolved value explicitly
(`src/commands/shell.ts`, `maxRounds: resolveAgentMaxRounds()`), so the `auto` and `trust` permission modes get 40 too.

When a turn reaches the limit, `offerRoundLimitReset` asks a human "Increase limit and continue / Cancel" through
`askUser`. In `auto` mode nobody is meant to be at the keyboard: on 2026-10-12 the live review shell for PR 7659
sat on that question for about 50 minutes, and a second reset only adds another 40 (40, then 80). `trust` stalls
at the same limit.

`auto` is the permission mode that already skips every approval prompt except the hard floors (credentials, SAC
review confirmation, git-publish lease). The round-limit question is the one prompt that mode still leaves.

## Expected Outcome

The round limit of a turn follows the permission mode, and in `auto` reaching it never asks anyone.

Rule:

1. Default limit per turn: `ask` = 40 (unchanged), `trust` = 120, `auto` = 200.
2. `KERYX_AGENT_MAX_ROUNDS` still wins in every mode; the ceiling stays 200 (a larger value is clamped).
3. The mode is read at the start of each turn, so `/mode auto`, `/mode trust` and `/mode ask` take effect on the
   next turn.
4. In `auto` mode, at the limit with the ceiling not yet reached (only possible when the env value is below 200),
   the loop extends itself by one allotment, capped at 200, prints the existing `[budget]` line, and continues
   without calling `askUser`.
5. In `auto` mode, at 200 the turn stops with `finishReason: "budget"` and a `[budget]` message that names the limit
   and says it is the ceiling and how `KERYX_AGENT_MAX_ROUNDS` relates to it. No question is shown.
6. In `trust` the reset question stays: a human is still expected at the keyboard there, so only the number
   changes, and each reset grants one more allotment of 120. In `ask` the question and its allotment of 40 are
   unchanged.
7. Automatic review. The repository has no `/autoreview` command: review waves run as subagents dispatched by the
   review orchestrator, and a subagent has its own round limit (default 10, cap 24), outside the turn limit above.
   In `auto` mode that limit follows the same rule: default 40, cap 200. In `ask` and `trust` it is unchanged.

## Outcome criteria

- Запрос (дословно): «Согласен, сделай пока идет прогон, маленький фло, с эффектом: в автоматическом режиме лимит на тулы должен быть увеличен до 200.» (source: helyx chat -1003908750902, message 199560, 2026-10-12T13:59:30Z)
- Уточнение оператора (message 199701, 2026-10-12): 200 в `auto` и в автоматическом ревью, 120 в `trust` (поднят с 40, потому что `trust` тоже встаёт), 40 в `ask` без изменений; env побеждает в любом режиме, потолок 200.
- Эффект (формализация агента): лимит раундов хода зависит от режима: 40 в `ask`, 120 в `trust`, 200 в `auto`. В `auto` при достижении лимита человеку вопрос не задаётся: до потолка 200 ход продолжает сам, на потолке останавливается с понятным сообщением. В `ask` и `trust` вопрос остаётся.
- Как наблюдать (предложение агента): живой шелл в режиме `auto` проходит ход длиннее 40 раундов без остановки и без вопроса; `/mode` и его окно показывают эффективный лимит раундов; тесты в `src/commands/agent.test.ts` проверяют 40/120/200, победу env и отсутствие вызова `askUser` в `auto`.

## Out of Scope

- The `ask` default and the reset question in `ask` and `trust`.
- Raising the ceiling above 200.
- Subagent budgets other than the round limit (`maxToolCalls`, `resetSubagentBudget`), and subagent round limits in `ask` and `trust`.
- `/goal --auto` (`DEFAULT_AUTO_GOAL_ROUNDS = 8`), which is a different feature.
- Retrying provider errors, and any change to the approval gate in `permission-mode.ts`.

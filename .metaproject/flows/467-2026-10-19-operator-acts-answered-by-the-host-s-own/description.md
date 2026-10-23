# Operator acts answered by the host's own question

Status: approved scheme (operator polls 225 and 227, 2026-10-19). Full PRD: `docs/requirements/keryx-card-any-host/prd.md`.
Source: user description (origin: human-request)

## Problem

The review verbs that record an operator decision (`decide-premise`, `confirm-plan`, `waive-mutation`, `override-reviewers`) refuse without a TTY, and the keryx MCP server has no card tool. An agent in Claude Code or Codex that already asked the operator through the host's own question tool (or a Telegram poll through Helyx) and got an answer cannot record it. PR 1052's held findings C-05, C-10, C-25 and E-42 stayed unrecorded for that reason.

## Expected Outcome

Each of the four verbs accepts `--answered-by <source>:<ref> --answer-text "<verbatim>" --question-text "<as asked>"` with no TTY. keryx builds the effect from disk state, refuses what the CLI refuses today, and records `confirmedVia: "host-question"` with the source, ref, question, answer and time, plus a `keryx decisions` entry. keryx does not verify the answer: this reverses TM-04 §5 on the operator's instruction (the trade already made for `flow ac confirm`, poll 222) and the docs say so. `review complete`, unattended runs and a nested keryx stay refused.

## Outcome criteria

- Запрос (дословно): «Это должен быть просто вопрос, все харнесы умеют это делать. И Claude может создавать вот тут вопрос/опрос, прям щас этим пользуемся.» (source: helyx-channel message 214878, 2026-10-19)
- Эффект (формализация агента): агент в любом харнесе (Claude Code, Codex, keryx shell) задаёт оператору обычный вопрос с вариантами и записывает ответ одной командой keryx; запись хранит дословные вопрос и ответ и помечена `host-question`, а не картой.
- Как наблюдать (предложение агента): оператор отвечает на опрос в Telegram по реальной удержанной находке, и в `operator-decisions.json` пакета появляется запись `confirmedVia: "host-question"` с id опроса; тот же ответ виден в `keryx decisions report` и в `/decisions`.

## Out of Scope

- Proving who answered, or that a person did (TM-03 §5 and TM-04 §4 limits stay; this flow loosens the proof and says so).
- Any new transport, token, serve route or MCP tool.
- `review complete` and its `--waive` / `--waive-coverage` flags (they exist only on `complete`).
- Other TM-04 acts: learn, schedule, external apply, flow confirm.
- Free-text answers as decisions.

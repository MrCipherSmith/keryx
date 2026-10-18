# Operator review confirmations answered in Telegram through Helyx

Status: draft for operator approval
Source: user description (origin: human-request)

## Problem

Four operator acts in the review lifecycle still need the operator at a terminal or in the keryx shell TUI: `review confirm-plan`, `review decide-premise`, `review complete --waive` (and `--waive-coverage`), and `review complete`. Flow 456 added TUI cards and a `remote-card` mirror through keryx's own Telegram channel (`src/remote/`), but only four review tools and nine other tools have cards. `review complete` as a whole has none, `confirm-plan` and `decide-premise` are terminal-only in the review CLI, and the remote answer does not record who pressed the button (`fromId` is dropped before the record is written). Result: when the operator is away from the terminal, reviews stop on their manual commands (flow 462 stopped four times in one day), and an agent cannot honestly record those acts for them.

## Expected Outcome

Each of the four acts is asked by keryx itself as a card in keryx shell, Claude CLI or another harness; keryx's remote channel mirrors the card to the operator's Telegram topic (the Helyx chat), and the operator answers there. keryx verifies the answer itself: the pressing user id is on the allowed list, the answer carries a one-time token bound to this one question, and the record stores who pressed and when. An agent cannot produce that answer by sending a message. If the remote channel is unavailable, the terminal path stays as before.

## Decisions (operator, polls 220 and 221, 2026-10-18)

- The question originates in keryx (a card), not in an agent-sent poll.
- Transport: keryx's own remote channel (already verifies ids and mirrors to the topic). A Helyx-side inbound endpoint is out of this flow.
- Token: single use, bound to one question, lives 1 hour.
- `review complete` gets one card: reviewed SHA, evidence level, list of waivers.
- The record stores `pressedBy` (user id) and `pressedAt` next to `confirmedVia`.
- The terminal command stays as fallback when the remote channel is unavailable.

## Outcome criteria

- Запрос (дословно): «Почему щас что бы завершить ревью мне нужно самому через терминал что-то делать, я хочу это так же через телеграмм» (source: helyx-channel message 213084, 2026-10-18)
- Эффект (формализация агента): ревью и flow доходят до конца без команд оператора в терминале: каждое из четырёх действий оператора задаётся карточкой keryx и подтверждается нажатием в Telegram, а keryx сам проверяет, что нажал разрешённый пользователь на этот вопрос.
- Как наблюдать (предложение агента): оператор закрывает реальное ревью (confirm-plan, decide-premise, waive, complete) только из Telegram; в записях пакета стоят `confirmedVia: "remote-card"`, `pressedBy` и `pressedAt`.

## Out of Scope

- A new inbound endpoint or protocol in Helyx; changes to `~/bots/helyx`.
- Making the answer cryptographically unforgeable against an agent running as the same OS user (TM-03 §5, TM-04 §4 stay open limits; the decision record restates them).
- `flow ac confirm` stays as it is (operator decision, poll 222: an agent may keep confirming criteria itself).
- Other cards (external apply, learn, schedule) beyond what flow 456 delivered.
- Voice or free-text answers; only the card's buttons.

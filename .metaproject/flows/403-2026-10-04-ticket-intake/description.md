# Work intake: GitHub events as Telegram cards with buttons

Status: frozen with the operator's approval (poll 84, 2026-10-04)
Source: operator request (origin: human-request); PRD: `docs/requirements/keryx-ticket-intake/prd.md`

## Problem

To learn about a new ticket assigned to them, a review request, a failed CI run or a comment on their pull request, the operator opens GitHub themselves. The scheduled digest (flow 389) only reports; between "seen" and "taken into work" there is no trace and no button.

## Expected Outcome

A scheduled read-only poll notices events and sends one Telegram card per event with a short assessment, a suggested action and buttons. Pressing "Take into work" starts the usual keryx cycle (`flow init --issue`, then PRD and AC to the operator before freeze). Every decision on a card is recorded with its author and time. Without a human the agent only observes and suggests. The card goes to a dedicated service topic "Intake"; decisions go to an intake ledger of their own, without the F2 arms.

## Outcome criteria

- Запрос (дословно): «я хочу более оперативно контролировать рабочий процесс, то есть не самому проверять гитхаб, а что бы мне в телеграм приходили уведомления и прдложения.» (сообщение 175492, 2026-10-01T06:04:53Z)
- Эффект (формализация агента): о новом тикете на оператора, запросе ревью, упавшем CI и комментарии в его PR он узнаёт из Telegram-карточки раньше, чем сам открыл бы GitHub, и может сразу взять тикет в работу кнопкой; каждое решение по карточке записано с автором и временем.
- Как наблюдать (предложение агента): за неделю оператор ни разу не открывал GitHub, чтобы узнать о новом тикете или ревью (отмечает сам, строкой `outcome-observed:` в журнале flow, потому что измерить это инструментом нельзя), и минимум один тикет взят кнопкой; `keryx intake report --json` за семь дней показывает ненулевое число карточек по каждому виду, медиану времени ответа и хотя бы одну связку «карточка → flow → PR».

## Out of Scope

- Any write to GitHub on the operator's behalf (comments, labels, reviews, merge).
- Automatic `flow init`, push or PR without a button press or a confirmation in the topic.
- A second scheduler: the poll is one more trigger on the flow 295/389 machinery.
- GitHub Action and webhook: a separate flow D2 after a week of polling (deferred, see journal).
- Installing anything into work repositories: they are polled only.
- Live runs of external agents: tests use fakes.

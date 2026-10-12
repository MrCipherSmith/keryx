# Own-text answer to questions in shell and Telegram, with a stated reason

Status: draft, awaiting operator approval of PRD and AC before freeze
Source: user description (origin: human-request)

## Problem

When an agent asks the operator a question with options, the operator can only pick one of them. In the keryx shell the question dock has up/down/Enter/Esc and no text input; the "why did you deviate?" prompt offers only "No reason" and "Not now". In Telegram a typed line always starts a new agent turn, so it can never answer a pending question; and `ask_user` questions raised during a Telegram-originated turn are not routed to Telegram at all. The decisions journal truncates a free-form answer and a reason to 300 characters, does not redact them, and does not copy a reason into the flow journal. The operator cannot give a justified answer, and the justification is not traceable.

## Expected Outcome

Every question with options, in the shell dock and in Telegram, offers a "your own answer" path in addition to the options. The typed text is the answer (or the stated reason for a picked option), is bound to exactly that question, is redacted of secrets, is kept in full (up to a stated limit) in the decisions journal and the flow journal, and shows in the `/decisions` modal and in the report.

## Outcome criteria

- Запрос (дословно): «Заведи новое фло с эффектом: я хочу что бы и в keryx shell и в телеграм когда приходят вопросы, был вариант совбстенного ответа, что бы я мог не просто изменить мнение или выбрать -что-то но и обосновать в тексте, что бы это было более отслеживаемо» (source: channel message 182648, 2026-10-04T10:44:01Z)
- Эффект (формализация агента): на любой вопрос с вариантами оператор может ответить собственным текстом и приложить обоснование к выбранному варианту, и в shell, и в Telegram; ответ и обоснование привязаны к конкретному вопросу и сохраняются полностью, без секретов, в журнале решений, журнале flow и отчёте
- Как наблюдать (предложение агента): в `/decisions` и в `keryx decisions report` у записи виден текст оператора и причина; в flow journal.md появилась строка с причиной; в Telegram после нажатия «Свой ответ» бот просит ответить на сообщение, а ответ на него закрывает вопрос

## Out of Scope

- Approval prompts (Allow/Deny, mode, grants) stay button-only: a typed text must never be able to approve a command.
- Free-text answers to questions that are not agent questions (slash-command pickers keep their buttons; only the Yes/No confirm and option pickers that carry a decision get the reason step if the operator approves it).
- Voice answers.

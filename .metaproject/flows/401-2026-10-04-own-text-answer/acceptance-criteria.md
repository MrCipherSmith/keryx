# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: In the keryx shell, an agent question with options (the `ask_user` dock) shows, besides the options, a last row "Свой ответ…". Choosing it opens a one-line-or-multiline text input in the composer; Enter submits, Esc returns to the option list without answering. A test drives the dock and fails if the row or the input step is removed.
- AC2: The text typed in AC1 is returned to the agent as the answer (the tool result states it is the operator's own answer and carries the text), the transcript shows it after the question breadcrumb, and an empty or whitespace-only text is refused and keeps the input open.
- AC3: In the shell, after picking an option the operator can attach a reason: a key (documented in the dock hint) opens the same text input with the chosen option fixed, and the reason is stored for that question. The deviation prompt of the decisions journal accepts typed text too, not only "No reason" and "Not now".
- AC4: In Telegram, a question with options carries a button "✍ Свой ответ". Pressing it posts a ForceReply message quoting the question. A text sent as a reply to that message, by the same user, resolves that exact question with the typed text. A test covers the full press, reply, resolve path.
- AC5: In Telegram, a typed line that is not a reply to an armed own-answer message still starts a normal agent turn, and a reply to an armed message never starts an agent turn. A reply from another user, or to another prompt, resolves nothing. Tests pin all three.
- AC6: An own answer that arrives after the question was answered, cancelled or timed out resolves nothing, and the operator gets one short message that the question is closed and the text was not passed on. The own-answer step has its own timeout of at least 5 minutes; the option timeout is unchanged.
- AC7: An `ask_user` question raised during a Telegram-originated turn is shown in Telegram (picker with the own-answer button) and not only in the local dock; the first answer from either surface wins and the other surface's prompt is closed. Pickers of slash commands keep their buttons and get no own-answer row.
- AC8: Approval prompts (Allow/Deny, mode, grants) in the shell and in Telegram have no own-answer path, and a typed text can never approve or deny: a test sends approval-looking text ("yes", "allow") as an own answer and as a reply and asserts the approval stays pending.
- AC9: The decisions journal stores the own-answer text and the reason in full up to 2000 characters (a longer text is cut with a visible marker, never silently), while the one-line `choice` display keeps its 300-character cap. Both are redacted of secrets before they are written, and a test with a token-shaped string asserts the journal, the flow journal.md and the report contain the placeholder and not the token.
- AC10: Inside a flow, the reason of a question is appended to that flow's `journal.md` as one line with the question id, and `keryx decisions report` prints own answers and reasons in full, in both the text and `--json` form.
- AC11: The `/decisions` modal and its sidebar row mark answers that carry an own text or a reason, and show the text on selection; a test renders the modal for a journal with one own answer and one picked-with-reason answer.
- AC12: `/help` and the cli-registry describe the own-answer path in the shell and in Telegram, the guide `docs/docs/guides/recommendation-journal.md` and the Telegram remote guide are updated, and a docs test fails if the guide omits it.
- AC13: A live run by the operator in the real shell and in the real Telegram topic confirms AC1, AC4 and AC7 end to end (judged by the operator).

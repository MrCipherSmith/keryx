# Implementation Plan

Status: draft, awaiting operator approval

## Approach

One answer contract shared by both surfaces: `{ kind: "option" | "own", choice, text?, reason? }`, redacted at the single point where it enters the decisions journal. The shell and Telegram are two renderers of that contract.

## Steps

1. Core: extend `answerDecision` (src/decisions/journal.ts) with `text` and `reason` kept in full up to 2000 characters (the one-line 300 limit stays for display), redact before write, append reason to the flow `journal.md`. Report and `/decisions` modal show text and reason.
2. Shell: add a "Свой ответ…" row and a text step to `showComposerChoice` (src/tui/composer-choice.ts); wire `askUserInteractive` (tui-shell.ts) to pass `allowFreeform`; make the deviation-reason prompt (src/decisions/ask.ts) accept typed text. Approvals untouched.
3. Telegram: route `ask_user` of a Telegram-originated turn to Telegram (picker with a "Свой ответ" button); the button sends a ForceReply message; `accept()` in shell-bridge.ts matches the reply to that prompt and user; an unbound or expired reply is not an answer and is told so.
4. TUI visibility: sidebar row, `/decisions` modal showing own answers and reasons, `/help` and cli-registry entries, docs page update.
5. Tests per AC, mutation-checked; independent review; draft PR; docs.

## Risks

- A secret typed into an answer reaches journals: redact at one entry point, test it.
- A normal instruction swallowed as an answer (or the reverse): binding by reply-to plus user id, never by "the next message".
- Timeouts while the operator types: own-answer step gets its own timeout; a late reply resolves nothing and is reported.

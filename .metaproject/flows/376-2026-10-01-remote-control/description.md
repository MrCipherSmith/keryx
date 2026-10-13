# Remote control: a shell session in a Telegram topic

Status: draft, awaiting operator check of the acceptance criteria before freeze
Source: ~/notes/flowB-remote-control-prd-draft.md (operator answers B1-B4 in force)

## Problem

A live `keryx shell` session can only be driven from the terminal. `keryx serve`
gives remote turns over HTTP but leaves the Telegram card to the client, and the
existing `keryx-telegram-transport` design is a topic per project with no code. To
work with keryx from Telegram the operator goes through a separate chat bot today.

## Expected Outcome

`/remote-control [name]` in a running shell (TUI and readline) opens one Telegram
topic for that session. Messages in the topic become user lines in the session,
the session's replies come back to the topic, and approval requests arrive as
buttons. `keryx serve` is the single poller of the bot token; the shell is a
client of serve over loopback HTTP and SSE with a local token (mode 600). A killed
shell leaves a status in its topic and the topic is removed after the orphan
timeout; a restart of serve loses nothing and duplicates nothing. The session
history records when remote control was on.

## Outcome criteria

- For 5 days in a row, at least once a day I work with keryx from Telegram through remote-control, without opening the terminal and without using the separate chat bot for keryx. Observed by the operator and recorded as an `outcome-observed:` line in this flow's journal.

## Out of Scope

Voice (a separate flow later), files, photos, several shells in one topic, a web
UI, the per-project topic of `keryx-telegram-transport` (stays as is), a hard
memory limit per run (B4: only the run timeout and process isolation here).
Tests use a fake Bot API only: no live Telegram and no external agents in CI. A
live run against a real bot needs the operator's separate OK in the topic.

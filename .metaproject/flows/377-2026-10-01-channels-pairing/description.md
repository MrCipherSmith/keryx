# channels: connect Telegram from /channels by pairing

Status: draft, awaiting the operator's confirmation of the revised criteria before freeze
Source: operator messages 175641, 175680 (2026-10-01); answers: own bot per machine, shared group, do it right after flow 376, token entered hidden

## Problem

Remote control (flow 376) needs a bot token file, a config file with a supergroup id
and Telegram user ids, written by hand, on every machine. On a second machine that
is a chore with several chances to get an id wrong, and `keryx serve` reads the
files only at start, so nothing can be connected from inside a running shell.

## Expected Outcome

`/channels` in a running shell (TUI and readline) lists the channels, for now only
Telegram. An unconfigured channel offers Connect; a configured one offers Test and
Disconnect. Connect asks for the bot token only. The user id and the group id are
found from Telegram events through a one-time pairing code, so no id is typed and
no value is hard-coded. `keryx serve` always offers the local channel routes on
loopback, validates the bot, creates the test message and reloads its remote
configuration without a restart.

## Outcome criteria

- On a new machine Telegram is connected from `/channels` and the only thing typed by hand is the bot token. Checked by the operator on a second machine and recorded as an `outcome-observed:` line in this flow's journal.

## Out of Scope

Channels other than Telegram, one bot shared between machines (Telegram allows one
poller per token), a token entered anywhere but the hidden field of the modal, voice,
files. Tests use a fake Bot API only: no live Telegram. A live run needs the operator's
separate OK, a BotFather token and a topics-enabled supergroup.

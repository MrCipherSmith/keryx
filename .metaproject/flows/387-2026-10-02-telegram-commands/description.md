# Telegram commands: slash commands and button pickers from the topic

Status: draft, awaiting operator check of the acceptance criteria before freeze
Source: operator request 2026-10-01 (message 176710); operator answers to poll 37 on 2026-10-02 are in force

## Problem

A line typed in a Telegram topic runs in the shell as if typed there, but a line that starts with "/" is refused on purpose (`src/remote/shell-bridge.ts`, "Slash commands are not run from Telegram"). Switching the provider or the model, changing the mode, resuming a session or looking at flows still needs the terminal. The shell's pickers are TUI overlays that cannot run without a terminal, and the output of a command goes to the local transcript or a toast, never to the topic.

## Expected Outcome

The operator works with keryx from Telegram without opening a terminal. A slash command typed in the topic runs through a command gateway with an explicit allowlist. Text commands answer in the topic. Pickers (`/model`, `/connect`, `/resume`, `/mode`, lists) arrive as inline-keyboard buttons: first the provider, then its models, and so on. Commands that weaken approvals (`/mode trust|auto`, `/plan off`) and commands that start paid or external agents (`/delegate`, `/external*`) run only after a Yes/No button press. Commands that handle credentials or end the shell stay local, and the topic says so.

## Decisions (operator, poll 37)

- `/mode trust|auto` and `/plan off` from the topic: allowed after a Yes/No button confirmation.
- First version: text commands (class A) and button pickers (class B).
- `/delegate` and `/external*`: allowed after a Yes/No button confirmation.
- `/new` and `/clear` keep the same topic with a separator line (operator, message 177222: "Согласен").
- Message state as in helyx, in this first version (operator, message 177222): the operator sees that a message arrived, was read and is in work, and a "typing" indicator while the agent works. Done through reactions on the message plus the typing chat action.
- Approval message UX (operator, message 177244, screenshot): today a press leaves the buttons on the question and sends a separate "Approval granted." message. Wanted: the question message is edited, the buttons are removed and replaced by the result. Applies to the existing approval prompts and to the new pickers and confirmations.

Default I chose, not yet confirmed: `/mcp trust`, `/guard`, `/route` and `/editguard` stay local (they change policy and were not part of the poll).

## Outcome criteria

- For 5 days in a row, at least once a day I change the provider or model, or run a shell command, from the Telegram topic without opening the terminal. Observed by the operator and recorded as an `outcome-observed:` line in this flow's journal.

## Out of Scope

Voice (a separate investigation flow), files and photos, credential entry from Telegram (bot token, provider keys, device-code login), several shells in one topic, running the shell's TUI games and editors. Tests use a fake Bot API only. A live run against the real bot needs the operator's OK in the topic.

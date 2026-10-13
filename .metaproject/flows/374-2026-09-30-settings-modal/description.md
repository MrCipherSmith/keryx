# Settings modal: /settings

Status: draft

Source: operator request (operator chat channel, 2026-09-30, message 174480) and answers 174531 (1А 2А 3А 4А): one `/settings` command opening a modal styled like `/connect`, with On/Off buttons like Test/Disconnect, gathering the settings-like slash commands.

## Problem

Settings are scattered across slash commands (`/mode`, `/plan`, `/reasoning`, `/theme`, `/think`, `/guard`, `/route`, `/external`, `/editguard`, `/jevprofile`, `/routing`) with different syntaxes; some work only in the TUI, some in both shells, and external agents (flow 373) gain `/external-agents on|off`. A user cannot see the current values in one place or change them without remembering each command.

## Expected Outcome

- `/settings` in the TUI opens one modal listing each setting by group with its current value and On/Off (or value) buttons in the `/connect` style.
- Every button calls the existing handler of the matching slash command; no setting logic is duplicated.
- In the readline shell `/settings` prints a table of the same current values.
- Session-only values (`/mode`, `/plan`) are labelled as session; persisted values are labelled saved. The modal writes nothing new to disk for session values.
- `auto` permission mode needs a two-step Enter confirmation in the modal, like Disconnect.

## Outcome criteria

- not measured — a usability feature; verified by the acceptance criteria and a live TUI session.

## Out of Scope

- New settings, a settings file format, or persisting `/mode` and `/plan`.
- Changing what any existing command does.
- Renaming `/external` (Jev privacy) or `/external-agents` (external CLI agents): the modal labels them differently.

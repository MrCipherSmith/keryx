# tasks (Task Manager)

Version: 0.1.0

> The `tasks` (Task Manager) module is driven by the `gd-metapro flow` command and the `flow` skill; every command below is invoked as `gd-metapro flow ...`.

## Purpose

Agent-first flow lifecycle: initialization with frozen acceptance criteria,
strict status state machine, draft-PR completion gates, and tracker reporting.

## Commands

- `gd-metapro flow init (--issue <url> | --title "<t>")`
- `gd-metapro flow list | status <id>`
- `gd-metapro flow freeze <id>` / `flow start <id>`
- `gd-metapro flow task add|done ...`
- `gd-metapro flow ac confirm|update ...`
- `gd-metapro flow implemented <id> --pr <url>`
- `gd-metapro flow complete <id> [--comment]`
- `gd-metapro flow block|unblock <id>` / `flow check`

## Entry

- `flows/` (flow packages)
- `skills/flow/SKILL.md`

# tasks (Task Manager)

Version: 0.1.0

## Purpose

Agent-first flow lifecycle: initialization with frozen acceptance criteria,
strict status state machine, reviewed-and-merged PR completion gates, and
tracker reporting.

## Commands

- `keryx flow init (--issue <url> | --title "<t>")`
- `keryx flow list | status <id>`
- `keryx flow freeze <id>` / `flow start <id>`
- `keryx flow task add|done ...`
- `keryx flow owner set <id> --owner "<name>" --reason "<why>"`
- `keryx flow ac confirm|update ...` (`ac update` also takes `--criterion ACn
  --text "<criterion>"` to rewrite/append one line)
- `keryx flow implemented <id> --pr <url>`
- `keryx flow complete <id> [--comment] [--signed-by "<name>"]`
- `keryx flow block|unblock <id>` / `flow check`

Spend, confirmations, signatures and gate outcomes across flows:
`keryx governance report`.

## Entry

- `flows/` (flow packages)
- `skills/flow/SKILL.md`

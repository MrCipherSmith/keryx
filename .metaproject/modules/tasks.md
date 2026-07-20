# tasks (Task Manager)

Version: 0.1.0

## Purpose

Agent-first flow lifecycle: initialization with frozen acceptance criteria,
strict status state machine, draft-PR completion gates, and tracker reporting.

## Commands

- `keryx flow init (--issue <url> | --title "<t>")`
- `keryx flow list [--json] | status <id>`
- `keryx flow plan <id> [--provider <p>] [--json]` — model-suggested atomic task breakdown from description + AC (read-only; does not change flow state)
- `keryx flow freeze <id>` / `flow start <id>`
- `keryx flow task add|done ...`
- `keryx flow ac confirm|update ...`
- `keryx flow implemented <id> --pr <url>`
- `keryx flow complete <id> [--comment]`
- `keryx flow block|unblock <id>` / `flow check`

## Entry

- `flows/` (flow packages)
- `skills/flow/SKILL.md`

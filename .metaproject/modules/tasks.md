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
- `keryx flow ac confirm|update ...`
- `keryx flow implemented <id> --pr <url>`
- `keryx flow complete <id> [--comment]`
- `keryx flow block|unblock <id>` / `flow check`

## Completion gates

`flow complete` runs, in order: `acceptance-criteria`, `pull-request` (or
`main-merge`), `tasks`, `review`, `health`, `security`. A failing gate returns
the flow to `in-progress` with the reason recorded.

`tasks` and `review` are opt-in per package (`gates.tasks`, `gates.review`,
written by `flow init`); a package created before a gate existed reports
`skipped` for it. The `review` gate requires an ingested review round with every
finding at or above the severity floor carrying a terminal disposition backed by
the evidence that disposition requires, run against the PR head, with no
unanswered external comment and the verifier's stats recorded. A condition that
could not be observed fails it; absence is never read as clean. Optional
configuration lives in `.metaproject/tasks.config.json` under `completion`.

## Entry

- `flows/` (flow packages)
- `skills/flow/SKILL.md`

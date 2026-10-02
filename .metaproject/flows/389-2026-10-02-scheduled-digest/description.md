# Scheduled agent: GitHub and board digest on a schedule

Status: draft, awaiting operator check of the PRD and acceptance criteria before freeze
Source: ~/prompts/keryx-supervisor/flow-C-scheduled-agent.md (operator brief)
Precondition: the gateway flow (376) is closed. The flow board (375, G1) may stay paused: the agent reads the product index directly.

## Problem

Nothing in keryx looks at GitHub or at the state of flows while the operator is away. Open issues and PRs, reviews waiting for the operator, failed CI, and chains such as "PR merged, flow closed, effect not checked" are noticed late or by accident.

## Expected Outcome

Inside the permanent `keryx serve` instance, an agent task starts on a schedule without a person. It reads GitHub only through granted read tools: open issues and PRs, reviews waiting for the operator and failed CI in the configured repositories. It reads the flow board from the product index. It writes a digest to Telegram through serve: what changed since the last run, what is stuck, what needs the operator's decision, and the links "PR merged -> flow closed -> effect not checked". The base is the agent-task of flow 295 (trigger and schedule store, unattended sandbox, granted tools, hash confirmation, report.keep). No second scheduler is built, and the schedule is executed by serve.

## Scope

1. Digest delivery to Telegram through serve. A failed delivery is a report entry and a retry, never silence.
2. Memory between runs: a snapshot of what was seen (id + updatedAt) in `.metaproject/data`; the digest is built from the difference. The first run is marked "baseline".
3. The flow board as a source: the agent reads the product index, not the HTML.
4. Optional, only if the operator gives a board: a read-only granted tool for GitHub Projects (needs the `read:project` scope, which the operator adds by hand).

## Constraints

GitHub is read-only with a fixed argv and an allowlist of repositories. Multi-account rule: under `~/work/**` the work `gh`, elsewhere the personal one; no `gh auth switch` or login. A dollar limit per run in dispatch, a memory limit and a timeout per run. cron or systemd only if serve cannot do it, with the reason written here.

## Decisions I take unless the operator objects

- Where the digest goes: the topic of the project's remote session when there is one, otherwise a separate service topic of serve ("Digest").
- Repositories (`<REPOS>`): `MrCipherSmith/keryx` only in the first version; more are config.
- No GitHub Projects tool in the first version (no `<BOARD>` given).

## Outcome criteria

- In 7 days of the schedule running, at least once I did something in GitHub or on the board because of a digest, earlier than I would have noticed myself. Observed by the operator and recorded as an `outcome-observed:` line in this flow's journal.

## Out of Scope

Any GitHub write (comments, labels, merges), a second scheduler, the board UI, Projects access without a given board, voice. Tests use a fake `gh` and a fake Bot API only; real triggers are checked live with the operator's OK.

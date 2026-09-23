---
name: flow
description: Use whenever the user asks to start, create, track, or finish a managed piece of work - "создай фло", "заведи флоу из этой ишью", "create a flow", "start a story", "какой статус по фло", "заверши фло/стори", or pastes an issue link asking to work on it. All flow state changes go through the keryx flow CLI; never edit flow.json or frozen acceptance criteria by hand.
---

# flow Skill (router)

A flow is a story from initialization to completion. The user does NOT need to
know CLI commands - recognize the intent and route it yourself.

## Trigger Examples -> Intent

| User says (RU/EN) | Intent | Do |
|---|---|---|
| "Создай фло: <описание проблемы>" / "create a flow for ..." | init from description | `keryx flow init --title "<формализованный заголовок>"`, then follow [init.md](init.md) |
| "Создай фло на основании <issue URL>" / "make a flow from this issue" / вставил issue-ссылку + "сделай" | init from issue | `keryx flow init --issue <url>`, then [init.md](init.md) |
| "Заведи стори / инициализируй задачу / start a story" | init | ask for a problem description or issue link if missing, then init |
| "Какие фло активны? / статус по фло / where are we on 003" | status | `keryx flow list` / `flow status <id>` |
| "Отметь задачу T2 / добавь задачу в фло" | manage | [manage.md](manage.md): `flow task done/add` |
| "Создай PR и доведи до merge" | create and merge | [manage.md](manage.md): review/fix, merge into base, then `flow implemented --pr <url>` |
| "Заверши фло / закрой стори / finish the flow" | complete | [complete.md](complete.md): confirm ACs, `flow complete` |
| "Фло застрял / поставь на паузу" | block | `flow block <id> --reason` / `flow unblock` |

Ambiguous ("сделай эту фичу" without flow context): if the work is
non-trivial and multi-step, propose starting a flow; for one-liners just do
the work.

## Roles

- Starting new work: [init.md](init.md) - flow-init.
- Orchestrating/implementing an active flow: [manage.md](manage.md) -
  flow-manager (embeds into the orchestrator).
- Finishing a flow whose reviewed PR has merged: [complete.md](complete.md) -
  flow-complete.

## Hard policy (all roles)

- flow.json is CLI-owned. Never edit it by hand.
- Acceptance criteria are frozen after `flow freeze`; edits only via
  `keryx flow ac update <id> --reason "<why>"` (re-freezes as edited) or
  `keryx flow ac update <id> --criterion ACn --text "<criterion>" --reason "<why>"`
  (rewrites/appends one line). Implementors NEVER touch them. Every `ac`
  subcommand refuses an argument it does not use.
- Status changes only through the CLI; invalid transitions are rejected.
- Only flow-manager declares implementation complete (`flow implemented`),
  and only after a reviewed PR has merged into the recorded base branch.
- `flow init --owner "<name>"` / `flow owner set <id> --owner "<name>" --reason
  "<why>"` names who is accountable; never inferred. Opted-in flows fail
  `flow complete` while no owner is set.

## Unattended dispatch (triggers, and `agents external run`)

A flow can advance without a human turn. `keryx trigger list` shows declared
entries; `status [<name>]` shows the last recorded outcome; `run <name>`
performs one pass by hand; `schedule <name>` prints the cron/systemd line for
an external scheduler (keryx runs no daemon of its own); `install`/
`uninstall` manage the git hook blocks for event-fired entries. A `flow-next`
action without a `dispatch` block only REPORTS the flow's next task; with one
it DISPATCHES a keryx agent, unattended, to work that task in a throwaway
worktree and record exactly one closing fact (`task done` only on a green
`keryx health gate`, otherwise `attempt failed|blocked`). A killed dispatch's
spend reservation is closed with `keryx trigger resolve <runId> --spent
<usd>`. Full reference: `keryx trigger --help`.

Unattended means the same floor everywhere in keryx, not just for triggers:
every call that would ask a human is DENIED and recorded rather than
guessed; `permissionMode: "trust"` only runs shell commands inside the
hardened Linux sandbox (network off, home hidden, allow-listed env) and
refuses to start without it; `"ask"` in an unattended run is read-only, never
a silent yes. This is a floor, not a full boundary — read what still is not
contained before trusting a run.

`keryx agents external run <id> --task "<text>" [--unattended] [--write]`
drives ONE ACP-transport agent (today `gemini-acp`) as a subprocess, with
keryx as its ACP client — a different mechanism from a trigger's own dispatch
(which runs keryx's own agent loop). For that agent, keryx controls: the
permission bridge (clamped to `ask` for a foreign agent), filesystem
confinement to the disposable worktree, and a `--write` run's patch, which is
captured but **never applied**. keryx does NOT control what the foreign
agent's own tools do outside ACP messages, or its MCP calls, which bypass the
permission bridge.

A line-stream agent (`claude-cli`, `codex-cli`) is a DIFFERENT thing:
`run` refuses it outright ("speaks the one-way line stream. Delegate to it
from `keryx shell` with /delegate"). There is no ACP permission bridge and
no patch capture for it — this release implements `worktree-write` for the
ACP transport only; a dispatch that asks for `worktree-write` on a
line-stream agent is REFUSED fail-closed with a distinguishable
`not-implemented` reason everywhere keryx dispatches one (the internal
`runtime` block, and `keryx shell`'s /delegate) — never silently accepted
and its writes discarded. It stays `read-only`, contained by the same
disposable worktree as every external run.

See `docs/docs/guides/acp-client.md` for the full ACP contract, including the
output size bounds (a stderr-only flood and an output flood both end the run
with a named reason, not the timeout).

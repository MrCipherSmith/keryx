# Automation and remote control

Keryx can do project upkeep without you at the keyboard: declared triggers fire from git events or a schedule, scheduled agent tasks run unattended and leave a report, and a loopback HTTP listener lets a bot or another product drive the same agent. Keryx runs no daemon of its own; your OS scheduler, git hooks or CI job call it, and every path is bounded by spend ceilings and a refusal floor.

## When to use it

- You want the code graph and wiki rebuilt after every merge or commit without remembering to.
- You want an agent to work the next task of a flow overnight, in a throwaway worktree, with a hard spend limit.
- You want a recurring read-only report, such as a summary of open pull requests every few hours.
- You want a chat bot or a browser workspace to submit turns to keryx and answer approvals.
- You want CI to refresh keryx's artifacts and fail a job on a measured signal.

## Quick example

Declare two triggers by hand in `.metaproject/triggers.json` (keryx never writes this file), then list, install and run them.

```json
{
  "schemaVersion": 1,
  "triggers": [
    { "name": "reconcile-on-merge", "on": { "kind": "event", "event": "post-merge" },
      "action": { "kind": "reconcile" } },
    { "name": "nightly-rebuild", "on": { "kind": "schedule", "cron": "0 2 * * *" },
      "action": { "kind": "rebuild" } }
  ]
}
```

```bash
keryx trigger list
keryx trigger install
keryx trigger run nightly-rebuild
keryx trigger status
```

```text
keryx trigger list (<repo>/.metaproject/triggers.json):
  - reconcile-on-merge  [enabled]  event:post-merge  -> reconcile  hook: NOT installed (post-merge)
  - nightly-rebuild  [enabled]  schedule:"0 2 * * *"  -> rebuild  hook: n/a (schedule — see `keryx trigger schedule nightly-rebuild`)
keryx trigger install: installed 1 hook block(s), extending the existing hook file(s):
  - reconcile-on-merge -> post-merge (written)
…
gdgraph build complete: 0 nodes, 0 edges
keryx trigger run nightly-rebuild: ok — "rebuild" completed.
keryx trigger status (reading <repo>/.metaproject/data/trigger/runs.jsonl):
  - reconcile-on-merge  [enabled]  event:post-merge  -> reconcile
      never fired — no record yet
  - nightly-rebuild  [enabled]  schedule:"0 2 * * *"  -> rebuild
      last: 2026-10-01T09:35:57.472Z — ok — action "rebuild" completed. […]
```

## How it works

**Triggers.** A trigger names what fires it (a git event: `post-merge`, `post-commit`, `post-checkout`, or `ci`; or a cron schedule) and one action. `reconcile` runs `keryx sync --apply`, `rebuild` runs `keryx gdgraph build`, `open-flow` opens a flow from a template, and `flow-next` reports a flow's next task or, with a `dispatch` block, works it. `keryx trigger run <name>` performs exactly one pass and exits. A triggered run refuses at once when another keryx run holds the project's maintenance lock, and when a spend ceiling is already reached.

**Unattended dispatch.** A `flow-next` entry with a `dispatch` block starts an agent in a throwaway git worktree on a `trigger/<flow>-<task>` branch. It commits and never pushes. Spend is reserved before the first model call, and the task counts as done only when the turn ended normally, the branch has a commit and `keryx health gate` passes. Everything that would ask a question is denied and recorded. `trust` mode runs commands only inside the hardened Linux sandbox and refuses to start without it; `auto` is rejected. [Limitations](../limitations.md) states what the refusal floor does and does not guarantee.

**Schedules.** `keryx schedule add` drafts a scheduled agent task from a cadence and a prompt, shows a confirmation card, and installs a per-user timer (systemd on Linux, launchd on macOS, cron elsewhere) only after you confirm at a terminal. Each run leaves a report you read with `keryx schedule show <name>`. A pipe, an agent's shell or an unattended run cannot confirm a schedule.

**Remote entry.** `keryx serve` is a loopback, token-authenticated HTTP listener over the same harness `keryx shell` uses. It is off until you run `keryx serve config init` and `keryx serve token issue`. A turn whose policy decision is `ask` raises a durable pending approval; you answer it once, for that call, with `keryx approvals list|allow|deny` or the approvals route. Unanswered means denied. See [Drive keryx from a bot](../guides/drive-keryx-remotely.md) and [Answer a remote approval](../guides/answer-remote-approvals.md).

**CI.** In a pipeline you call the same commands directly: `keryx gdgraph build`, `keryx health gate --strict-warn`, `keryx security eval --corpus all`. See [Run keryx in CI](../guides/run-in-ci.md).

## Common tasks

| I want to… | Command or page |
|---|---|
| Rebuild the graph after every merge | declare a `reconcile` or `rebuild` trigger, then `keryx trigger install` |
| See what each trigger last did | `keryx trigger status [<name>]` |
| Get the cron line or timer unit for a schedule | `keryx trigger schedule <name>` |
| Run a recurring read-only agent task | `keryx schedule add --name … --every "…" --prompt "…"` |
| Pause or remove a scheduled task | `keryx schedule pause <name>`, `keryx schedule remove <name>` |
| Close a killed dispatch's spend reservation | `keryx trigger resolve <runId> --spent <usd>` |
| Check the remote listener | `keryx serve status` |
| Answer a pending remote approval | `keryx approvals list`, then `keryx approvals allow <id>` |
| Gate a CI job | [Run keryx in CI](../guides/run-in-ci.md) |

## Status

Opt-in. Nothing in this area runs until you declare a trigger, confirm a schedule or configure and start `keryx serve`. Dispatch in `trust` mode needs the Linux sandbox (bubblewrap); on macOS scheduled and triggered runs are limited to `ask` mode.

## Reference

- CLI reference: [trigger](../cli-reference.md#trigger), [schedule](../cli-reference.md#schedule), [serve](../cli-reference.md#serve), [approvals](../cli-reference.md#approvals)
- [Module reference: trigger and schedule](../modules.md#trigger-schedule), [serve](../modules.md#serve)
- [Drive keryx from a bot](../guides/drive-keryx-remotely.md), [Answer a remote approval](../guides/answer-remote-approvals.md), [Run keryx in CI](../guides/run-in-ci.md)
- [Limitations](../limitations.md)
- [Configuration and environment](../reference/configuration.md)

# Use review-service checks in the delivery loop

Two review-service checks, the edit guard and CI triage, are wired into the
delivery orchestrators (`job-orchestrator`, `flow-orchestrator`,
`task-implementer`, `code-verifier`). Both are advisory: nothing here writes
code, reruns a job or merges a pull request on the review service's say alone.
The commands live under `keryx review` as `jev-*` subcommands.

The checks apply automatically as soon as a review-service credential resolves,
as long as [`/external`](../cli-reference.md#external) is on (the default). You
do not need to edit `.metaproject/tasks.config.json`. Run `keryx external off`
(or `/external off` in the TUI) to keep this project's code, diffs and CI logs
from reaching the service at all. An explicit `review.jev.ci_triage` or
`review.jev.edit_guard` of `true` or `false` still wins over the default.

!!! note
    The edit guard fails open. On any error, timeout or missing credential it
    stays silent and exits `0`, and it never blocks the tool call.

## Prerequisites

- A project initialised with `keryx init` (see [Quickstart](../getting-started/quickstart.md)).
- For the edit guard: Claude Code as the editing agent. The guard is a
  `PostToolUse` hook.
- A review-service credential, or the checks stay off.

## Edit guard

The hook checks every `Edit`, `Write` and `MultiEdit` an agent makes against
your project's written rules. It feeds violations back to the agent through the
hook's `additionalContext` channel, one line per flag, before the code reaches
a human reviewer:

```text
Rule check flagged: <clause id> at <file>:<line> — fix it if it is a real violation.
```

- `task-implementer` checks the flagged clause against the named rule as soon
  as the line arrives. It fixes the code if the flag is real, continues if not,
  and records a false flag in the task report (`notes`) so the threshold can be
  tuned.
- `job-orchestrator` and `flow-orchestrator` confirm the guard is installed
  (`keryx review jev-edit-guard status`, else `install`) before the first
  `task-implementer` dispatch of a run, and say why in one line.

Install the hook, then check it:

```bash
keryx review jev-edit-guard install   # merge-safe: writes .claude/settings.local.json
keryx review jev-edit-guard status
```

To record the choice explicitly instead of relying on the default, set it in
`.metaproject/tasks.config.json`:

```json
{ "review": { "jev": { "edit_guard": true, "edit_guard_threshold": 0.5 } } }
```

`status` shows whether the guard is on, the threshold, and today's calls, flags
and cost. The TUI's `/editguard` shows the same plus the most recent flags, with
a one-key toggle. `keryx review jev-edit-guard uninstall` removes only this
hook's entry and leaves every other hook untouched.

**Measured on a real project** (10 tasks, 2 runs each, a large production
React/MobX frontend):

| | violations reaching first review | review rounds | check cost |
|---|---|---|---|
| without the guard | 27 | 31 | none |
| with the guard (threshold 0.5) | 10 (-63%) | 24 | $0.04 for 40 runs |

The agent acted on 79% of the flags at threshold `0.5`. At `0.2` the guard
flagged almost every edit, the agent learned to ignore it, and it had no
measurable effect. Precision matters more than recall here, which is why `0.5`
is the default. Raise the threshold if the guard flags too much for your rule
set. Lower it only if you have evidence the agent acts on the extra flags.

## CI triage

On a failed CI job, `keryx review ci-triage --run <id>` sorts the failure into
`flaky`, `infra` or `real-regression`, alongside deterministic signals: rerun
history, cross-branch history, diff proximity and log markers. The verdict is
always advisory. The command has no rerun, status-check or merge call anywhere
on its path.

Delivery orchestrators use it wherever they react to a red check, and never
merge on it alone:

- **flaky** (or a `deterministic` override): rerun the job once and record the
  rerun in the flow journal or job report. A second failure counts as
  `real-regression` regardless of the first verdict.
- **real-regression**: investigate and fix as usual.
- **infra**: report it and leave the code alone.

`code-verifier` runs the same triage before filing a red GitHub CI check as a
finding, so a flaky or infra failure is not reported as a code defect. Enable
it explicitly with `review.jev.ci_triage: true` in
`.metaproject/tasks.config.json`.

**Measured on a real project** (a large production React/MobX frontend): the
service sorted failed CI jobs correctly 38% of the time, against 25% for a
general-purpose model classifier (p = 0.035). Developer time spent per failure
fell from 30 to 15.4 minutes.

## Verify

```bash
keryx review jev-profile show
```

The table lists each `review.jev.*` key with its current value and effective
source: `explicit`, `default-because-jev-available` or `off-by-external`.
`keryx review jev-profile --apply recommended` turns on `ci_triage`, `select`
and `edit_guard` together and records them explicitly.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `status` reports `enabled: false` | no credential resolves, or `/external` is off | add a credential, or run `keryx external on` |
| Guard never flags anything | threshold too high, or no project rules to check | lower `edit_guard_threshold` toward `0.5`, check your rules with `keryx rules sync` |
| Guard flags every edit | threshold too low | raise `edit_guard_threshold` |

## Next steps

- [Review with a durable record](review-with-a-record.md)
- [Review as a pull request bot](review-as-a-pr-bot.md)
- [`external` in the CLI reference](../cli-reference.md#external)

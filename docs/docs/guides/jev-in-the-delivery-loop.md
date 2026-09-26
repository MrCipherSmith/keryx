# Jev in the delivery loop

Two Jev-backed checks are wired into the delivery orchestrators
(`job-orchestrator`, `flow-orchestrator`, `task-implementer`, `code-verifier`).
Both are advisory — nothing here writes code, reruns a job, or merges a PR
on Jev's say alone.

**Both are now on by default wherever Jev is reachable** (flow 346): edit
guard and CI triage apply automatically as soon as a Jev/OpenRouter
credential resolves, as long as [`/external`](../cli-reference.md#external)
is on (the default) — no per-project `.metaproject/tasks.config.json` edit
required. Run `keryx external off` (or `/external off` in the TUI) to keep
this project's code/diffs/CI logs from reaching Jev/TypeSafe entirely; an
explicit `review.jev.ci_triage`/`edit_guard` of `true`/`false` still wins
over the default either way. The enable instructions below still work —
they just record the choice explicitly instead of leaving it to the
default.

## Edit guard

A Claude Code `PostToolUse` hook asks Jev about every agent edit against the
project's rules and feeds violations back to the agent mid-task, one line per
flag: `Rule check flagged: <clause id> at <file>:<line> — fix it if it is a
real violation.`

- `task-implementer` checks the flagged clause against the named rule as soon
  as the line arrives: fixes it if the flag is real, continues if not, and
  records a false flag in the task report (`notes`) so the threshold can be
  tuned.
- `job-orchestrator` and `flow-orchestrator` confirm the guard is installed
  (`keryx review jev-edit-guard status`, else `install`) before the first
  `task-implementer` dispatch of a run, and say why in one line.

Enable with `review.jev.edit_guard: true` in `.metaproject/tasks.config.json`;
tune sensitivity with `review.jev.edit_guard_threshold` (default `0.5`).
Install/check the hook with `keryx review jev-edit-guard install|uninstall|status`.

**Measured on a real project** (a large production React/MobX frontend), at
the default threshold of `0.5`: **-63%** rule violations reaching the first
review, **-23%** review rounds, the same total cost, and the agent acted on
**79%** of flags. At `0.2` the guard had no measurable effect — the agent
learned to ignore the extra noise.

## CI triage

On a failed CI job, `keryx review ci-triage --run <id>` asks Jev to sort the
failure into `flaky` / `infra` / `real-regression`, alongside deterministic
signals (rerun history, cross-branch history, diff proximity, log markers).
The verdict is always advisory: the command has no rerun, status-check, or
merge call anywhere on its path.

Delivery orchestrators use it wherever they react to a red check, never
merging on it alone:

- **flaky** (or a `deterministic` override) → rerun the job once, record the
  rerun in the flow journal / job report; a **second** failure counts as
  `real-regression` regardless of what Jev said the first time.
- **real-regression** → investigate and fix as usual.
- **infra** → report it and leave the code alone.

`code-verifier` runs the same triage before filing a red GitHub CI check as a
finding, so a flaky or infra failure is not reported as a code defect.

Enable with `review.jev.ci_triage: true` in `.metaproject/tasks.config.json`.

**Measured on a real project** (a large production React/MobX frontend): Jev
sorted failed CI jobs correctly **38%** of the time versus **25%** for a
Sonnet-based classifier (p = 0.035), cutting developer minutes spent per
failure from **30 to 15.4**.

## Related

`keryx review jev-profile --apply recommended` turns on `ci_triage`, `select`,
and `edit_guard` together in one step, explicitly — though as of flow 346
all three already apply by default wherever Jev is reachable (see above).
`keryx review jev-profile show` names each key's effective source
(`explicit`/`default-because-jev-available`/`off-by-external`).
See [Keeping private work in-house](../../../README.md#keeping-private-work-in-house-external)
for the `/external` switch itself.

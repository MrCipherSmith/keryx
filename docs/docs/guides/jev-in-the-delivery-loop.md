# Jev in the delivery loop

Two Jev-backed checks are wired into the delivery orchestrators
(`job-orchestrator`, `flow-orchestrator`, `task-implementer`, `code-verifier`).
Both are opt-in and advisory — nothing here writes code, reruns a job, or
merges a PR on Jev's say alone.

## Edit guard

A Claude Code `PostToolUse` hook asks Jev about every agent edit against the
project's rules and feeds violations back to the agent mid-task, as a tool
result beginning `Rule check flagged: <rule> — <what>`.

- `task-implementer` checks the flagged line against the named rule as soon as
  the result arrives: fixes it if the flag is real, continues if not, and
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
and `edit_guard` together in one step, once it ships.

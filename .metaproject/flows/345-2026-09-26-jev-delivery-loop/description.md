# Wire Jev edit-guard and ci-triage into delivery orchestrators

Status: formalized
Source: user description

## Problem

Two Jev-backed checks are proven on a real project but not wired into keryx's
own delivery orchestrators (`job-orchestrator`, `flow-orchestrator`,
`task-implementer`, `code-verifier`):

1. **Edit guard** — a Claude Code `PostToolUse` hook that asks Jev about every
   agent edit against the project's rules. Measured: -63% rule violations
   reaching first review, -23% review rounds, same cost, 79% of flags acted on
   (threshold 0.5); no effect at 0.2. Command `keryx review jev-edit-guard
   install|uninstall|status` ships in a parallel branch (`feat/jev-edit-guard`).
2. **CI triage** — `keryx review ci-triage --run <id>` sorts failed CI jobs
   flaky/regression/infra better than a Sonnet classifier (38% vs 25%,
   p=0.035), cutting minutes-per-failure 30 -> 15.4. This command already
   ships on `main`.

Without wiring, the orchestrators never install/check the guard before
dispatching implementers, never triage a red check before treating it as a
fix task or a code defect, and `task-implementer` has no rule for reacting to
the guard's tool-result feedback.

## Expected Outcome

- `job-orchestrator` and `flow-orchestrator` confirm the edit-guard hook is
  installed before the first `task-implementer` dispatch when
  `review.jev.edit_guard` is on, and triage a red CI/required check with
  `keryx review ci-triage` before treating it as a fix task, wherever they
  react to CI.
- `task-implementer` has a short rule for `Rule check flagged: …` tool
  results: check it, fix if real, note false flags in the task report.
- `code-verifier` runs the same CI triage before filing a red GitHub check as
  a code-defect finding.
- A short docs-site note ("Jev in the delivery loop") with the measured
  numbers, a README line + link, and an additive `CHANGELOG.md` entry under
  `## [Unreleased]`.
- Guidance/wiring only — no new model features, no changes to the edit-guard
  or ci-triage implementations themselves.

## Out of Scope

- Implementing `jev-edit-guard install|uninstall|status` itself (parallel
  branch `feat/jev-edit-guard`).
- Implementing `jev-profile --apply recommended` (parallel branch
  `feat/jev-orchestrator`) — referenced by name only.
- Any change to `keryx review ci-triage`'s own logic.

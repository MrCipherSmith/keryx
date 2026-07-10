# Documentation

This directory separates documentation by purpose so current behavior, product
intent, implementation plans, and release evidence do not get mixed together.

## Current behavior

- [Developer documentation](docs/README.md) — entry point for setup,
  architecture, modules, CLI behavior, and workspace lifecycle.
- [Complete setup and agent workflows](docs/complete-setup-and-agent-workflows.md)
  — global installation, project configuration, command reference, scripts, and
  copy-ready agent prompts.
- [Documentation index](docs/index.md) — compact navigation for the generated
  current-behavior reference.

## Product intent

- [Requirements roadmap](requirements/roadmap.md) — requirements packages and
  their verified implementation state.
- [Managed Review Feedback Loop](requirements/managed-review-feedback-loop/README.md)
  — requirements and contracts for managed review packages.

## Plans and reports

- [Implementation plans](plans/) — bounded plans that may become cleanup
  candidates after their acceptance criteria are implemented and verified.
- [Release readiness — 2026-07-10](report/release-readiness-2026-07-10/release-readiness.md)
  — verification results, release blockers, and the prioritized cleanup plan.
- [Implementation spec](report/release-readiness-2026-07-10/implementation-spec.md)
  — approved scope and acceptance criteria for this documentation pass.

## Documentation policy

- Repository documentation is English-only.
- `docs/docs/` describes current behavior and must be verified against source or
  live CLI help.
- `docs/requirements/` describes intended behavior and must label implementation
  status explicitly.
- Generated `.metaproject` artifacts are refreshed through the project CLI; raw
  and reproducible outputs remain ignored according to the managed `.gitignore`
  policy.

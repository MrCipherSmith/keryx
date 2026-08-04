# keryx — Documentation Index

Auto-generated developer documentation for the **keryx** CLI (reverse-engineered from source).

This index describes the current `main` implementation. Product intent and
future work remain under `docs/requirements/`; release-readiness audits live
under `docs/report/`.

## Contents

- [onboarding.md](./onboarding.md) — Install, first-run walkthrough, the typical build loop, and TTY/CI behavior.
- [complete-setup-and-agent-workflows.md](./complete-setup-and-agent-workflows.md) — Complete global installation, project configuration, commands, operational scripts, and agent prompts.
- [agent-installation-playbook.md](./agent-installation-playbook.md) — Agent-executable Gherkin setup, repair, validation, and handoff scenarios.
- [architecture.md](./architecture.md) — System overview, layered architecture, invariants, cross-module data flows, integrations.
- [modules.md](./modules.md) — Per-module reference: purpose, CLI surface, key files, mechanics, and data paths.
- [cli-reference.md](./cli-reference.md) — Every command, subcommand, flag, and exit code.
- [workspace-and-lifecycle.md](./workspace-and-lifecycle.md) — The `.metaproject/` contract, manifest, agent entrypoints, and `init`/`update` lifecycle.
- [limitations.md](./limitations.md) — Known gaps, platform support, optional AI features, and what to use instead.

## Release and planning

- [CHANGELOG](https://github.com/MrCipherSmith/keryx/blob/main/CHANGELOG.md) — what has landed since `v0.1.0`, with a standing known-gaps list.
- [Release readiness report](https://github.com/MrCipherSmith/keryx/blob/main/docs/report/release-readiness-2026-08-03/release-readiness.md) — the current readiness verdict and verification matrix.
- [Community documentation plan](https://github.com/MrCipherSmith/keryx/blob/main/docs/plans/community-documentation-plan.md) — the plan for publishable documentation, diagrams, and a docs site.

## Guides — organised by what you are trying to do

- [Give an agent context about my repository](guides/give-an-agent-context.md)
- [Run an agent against a repository without giving it my machine](guides/contain-an-agent.md)
- [Drive keryx from a bot or another product](guides/drive-keryx-remotely.md)
- [Review a branch and keep a durable record](guides/review-with-a-record.md)
- [Run keryx in CI](guides/run-in-ci.md)

**Start here:** new to the project? Begin with [onboarding.md](./onboarding.md),
then pick the guide that matches your task.

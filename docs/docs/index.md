# keryx — Documentation Index

Developer documentation for the **keryx** CLI.

These pages describe what the current `main` implementation actually does.
Product intent and future design work live separately, under
`docs/requirements/` in the repository; where the two disagree, this section is
the one that describes shipped behaviour.

## Contents

- [onboarding.md](./onboarding.md) — Install, first-run walkthrough, the typical build loop, and TTY/CI behavior.
- [complete-setup-and-agent-workflows.md](./complete-setup-and-agent-workflows.md) — Complete global installation, project configuration, commands, operational scripts, and agent prompts.
- [agent-installation-playbook.md](./agent-installation-playbook.md) — Agent-executable Gherkin setup, repair, validation, and handoff scenarios.
- [architecture.md](./architecture.md) — System overview, layered architecture, invariants, cross-module data flows, integrations.
- [harness.md](./harness.md) — The agent runtime: doors, providers, sessions and forking, policy, containment, evidence and the completion gate, record/replay.
- [modules.md](./modules.md) — Per-module reference: purpose, CLI surface, key files, mechanics, and data paths.
- [cli-reference.md](./cli-reference.md) — Every command, subcommand, flag, and exit code.
- [workspace-and-lifecycle.md](./workspace-and-lifecycle.md) — The `.metaproject/` contract, manifest, agent entrypoints, and `init`/`update` lifecycle.
- [limitations.md](./limitations.md) — Known gaps, platform support, optional AI features, and what to use instead.

## Releases

- [Changelog](https://github.com/MrCipherSmith/keryx/blob/main/CHANGELOG.md) — what has landed in each release, with a standing known-gaps list.
- [Releases](https://github.com/MrCipherSmith/keryx/releases) — tagged versions, each published to npm with provenance.

## Guides — organised by what you are trying to do

- [Give an agent context about my repository](guides/give-an-agent-context.md)
- [Use Shared Agent Context (workspaces, FWK, proposals)](guides/shared-agent-context.md)
- [Choose an approval mode: ask, trust, auto](guides/permission-modes.md)
- [Run an agent against a repository without giving it my machine](guides/contain-an-agent.md)
- [Use local SearXNG for agent web search](guides/use-local-searxng.md)
- [Drive keryx from a bot or another product](guides/drive-keryx-remotely.md)
- [Review a branch and keep a durable record](guides/review-with-a-record.md)
- [`/goal` — deterministic starts, optional autonomous continuation](guides/goal.md)
- [Slate for external agents](guides/slate.md)
- [Run keryx in CI](guides/run-in-ci.md)

**Start here:** new to the project? Begin with [onboarding.md](./onboarding.md),
then pick the guide that matches your task.

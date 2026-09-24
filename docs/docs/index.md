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
- [integrations.md](./integrations.md) — The harness adapter registry: `keryx integrations install|doctor|uninstall|matrix`, install-state and drift, the generated capability matrix, and per-harness notes (Gemini CLI, Kiro, GitHub Copilot agent, Zed).
- [hooks.md](./hooks.md) — The `keryx shell` lifecycle hook runtime: the ten events, config files, composition with the policy engine, built-ins, the `keryx hooks` CLI, and the W3/W8 extension points.
- [modules.md](./modules.md) — Per-module reference: purpose, CLI surface, key files, mechanics, and data paths.
- [learning.md](./learning.md) — The self-learning loop: observe, extract, review/accept, apply, promote, graduate, prune — what is observed, what is never stored, the confidence model, and consent guarantees.
- [cli-reference.md](./cli-reference.md) — Every command, subcommand, flag, and exit code.
- [commands-by-task.md](./commands-by-task.md) — Every command grouped by task, generated from the same table `keryx help` and the TUI's `/help` modal use.
- [workspace-and-lifecycle.md](./workspace-and-lifecycle.md) — The `.metaproject/` contract, manifest, agent entrypoints, and `init`/`update` lifecycle.
- [limitations.md](./limitations.md) — Known gaps, platform support, optional AI features, and what to use instead.

## Releases

- [Changelog](https://github.com/MrCipherSmith/keryx/blob/main/CHANGELOG.md) — what has landed in each release, with a standing known-gaps list.
- [Releases](https://github.com/MrCipherSmith/keryx/releases) — tagged versions, each published to npm with provenance.

## Guides — organised by what you are trying to do

- [Give an agent context about my repository](guides/give-an-agent-context.md)
- [Give a subagent a name instead of a paragraph](guides/agent-catalog.md)
- [Use Shared Agent Context (workspaces, FWK, proposals)](guides/shared-agent-context.md)
- [Choose an approval mode: ask, trust, auto](guides/permission-modes.md)
- [Run an agent against a repository without giving it my machine](guides/contain-an-agent.md)
- [Drive a foreign ACP agent (Gemini CLI) under keryx's policy](guides/acp-client.md)
- [Agent web search](guides/web-search.md)
- [Use local SearXNG for agent web search](guides/use-local-searxng.md)
- [Drive keryx from a bot or another product](guides/drive-keryx-remotely.md)
- [Review a branch and keep a durable record](guides/review-with-a-record.md)
- [`/goal` — deterministic starts, optional autonomous continuation](guides/goal.md)
- [Slate for external agents](guides/slate.md)
- [Keep the wiki current](guides/keep-the-wiki-current.md)
- [Run keryx in CI](guides/run-in-ci.md)
- [Move skills, rules, agents, and memory between projects and machines](guides/portability.md)
- [Write a rubric (judge) eval scenario](guides/write-a-rubric-scenario.md)

**Start here:** new to the project? Begin with [onboarding.md](./onboarding.md),
then pick the guide that matches your task.

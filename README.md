# keryx

**One project-local brain for your AI agents and your team.**

[![CI](https://github.com/MrCipherSmith/keryx/actions/workflows/ci.yml/badge.svg)](https://github.com/MrCipherSmith/keryx/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](package.json)

`keryx` is a CLI that installs a small `.metaproject/` workspace into any codebase, giving AI agents and developers one shared, versioned source of context: a code graph, an architecture wiki, normalized health and test reports, long-term memory, and agent skills. Instead of context scattered across scratchpads, CI logs, and IDE rule files that never agree, everything lives in one git-diffable place that both humans and agents read from.

The core is deterministic, local, and offline — with zero runtime dependencies. Every model-backed or precision feature is strictly opt-in, so a fresh install behaves identically whether or not you enable them.

## Quick Start

```bash
# Install the CLI globally
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/keryx/main/scripts/install.sh | bash -s -- --global

# Initialize the workspace in your project
cd path/to/your-project
keryx init

# Build the first artifacts
keryx gdgraph build          # code dependency graph
keryx test analyze           # testing context report
keryx health run --changed   # normalized health report

# Open the human admin dashboard
keryx dash
```

`keryx init` creates a `.metaproject/` workspace and connects your existing
`AGENTS.md` / `CLAUDE.md` entrypoints to it, so agents are routed to the right
module automatically. See the
[onboarding guide](docs/docs/onboarding.md) for the full first-run walkthrough
and alternative install paths (global via `bun`, or project-local).

**Requirements:** `git` and `bun` (>= 1.1.0).

## Core Ideas

A few pieces of jargon, defined once:

- **gdgraph** — a *code graph*: dependency and import graph of your repo, with
  cycle/orphan queries, an N-hop "what does this change affect" blast radius,
  and a PageRank-ranked repo map.
- **gdctx** — *compact context output*: runs commands, searches, and file reads
  and stores condensed results so agents don't flood their context with raw logs.
- **gdwiki** — an *architecture wiki*: a Markdown knowledge base of domain
  models, decisions, and flows, with grounded `wiki ask` retrieval.
- **gdskills** — *agent skills*: bundled and project-generated skills that route
  agents to the right workflow, plus verification and export to different runtimes.

## Modules

`keryx` itself is the toolkit core (`init`, `status`, `update`, `dashboard`,
`rules`, `standard`, `agents`) and manages the `.metaproject/` structure. It
ships these modules:

- **gdgraph** — code dependency graph; affected-set blast radius, PageRank repo map, optional tree-sitter symbol/call graph.
- **gdctx** — compact command / search / read output for agents.
- **gdwiki** — Markdown project wiki with templates, link checks, index generation, and grounded retrieval.
- **gdskills** — bundled and generated agent skills with routing, verification, learning, and export.
- **health** — normalized code-health reports from TypeScript, tests, audit, complexity, coverage, and lint (optional SonarQube).
- **testing** — testing context, related-test selection, changed-scope runs, and an opt-in coverage-map Test Impact Analysis.
- **memory** — long-term Markdown project memory with indexing, search, dedup, bitemporal validity, and optional local embeddings.
- **tasks** — an agent-first Task Manager driven by `keryx flow` for issue/task lifecycle tracking.
- **security** — deterministic secrets / PII / prompt-injection / egress scanning, redaction, and a policy gate at agent write seams.
- **mcp** — opt-in [Model Context Protocol](https://modelcontextprotocol.io) server exposing read-only module services to agents.

## How Agents Use It

After `init`, agents follow the root `AGENTS.md`/`CLAUDE.md` pointer to
`.metaproject/index.md`, which routes them to the right module. For example:

```text
Find the files related to payment retry handling, explain the relationships,
and use the keryx tools for context discovery before broad raw search.
```

The agent is directed to use `gdgraph` for navigation, `gdctx` for large output,
`gdwiki` and `memory` for decisions and history, and `flow` for managed work —
only for the modules you've enabled.

For agents that speak the Model Context Protocol, `keryx mcp install` wires a
read-only MCP server into Cursor or Claude in one command (opt-in, off by
default). See the [architecture doc](docs/docs/architecture.md) for the module
data flows.

## CI Integration

`keryx` is designed so CI can publish normalized, committable artifacts that
humans and agents read later:

```bash
keryx gdgraph build
keryx test analyze
keryx health run --changed
keryx dashboard build
```

Use `keryx health gate --strict-warn` to fail a job on the normalized health
gate instead of parsing raw linter/test logs, and `keryx security eval --corpus
all` to fail on any detector breaching its committed false-negative threshold.

## Documentation

Full developer documentation — reverse-engineered from the source — lives under
[docs/docs/](docs/docs/):

- **[Onboarding](docs/docs/onboarding.md)** — install paths, first-run walkthrough, the build loop.
- **[Architecture](docs/docs/architecture.md)** — the four-layer pattern, invariants, cross-module data flows.
- **[Module reference](docs/docs/modules.md)** — one section per module: purpose, CLI surface, mechanics, data paths.
- **[CLI reference](docs/docs/cli-reference.md)** — every command, subcommand, and flag.
- **[Workspace & lifecycle](docs/docs/workspace-and-lifecycle.md)** — the `.metaproject/` contract and `init`/`update` lifecycle.

Run `keryx <command> --help` (or `keryx` with no arguments) for the live command
surface.

## Local Development

```bash
bun ./src/cli.ts init
bun ./src/cli.ts status
bun run check      # typecheck + tests
```

## License

MIT. See [LICENSE](LICENSE).

<p align="center">
  <img src="docs/assets/keryx-logo.png" alt="keryx" width="440">
</p>

<h1 align="center">keryx</h1>

<p align="center"><strong>One project-local brain for your AI agents and your team.</strong></p>

<p align="center">
  <a href="https://github.com/MrCipherSmith/keryx/actions/workflows/ci.yml"><img src="https://github.com/MrCipherSmith/keryx/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/version-0.2.0-blue.svg" alt="Version"></a>
</p>

`keryx` is a CLI that installs a small `.metaproject/` workspace into any codebase, giving AI agents and developers one shared, versioned source of context: a code graph, an architecture wiki, normalized health and test reports, long-term memory, and agent skills. Instead of context scattered across scratchpads, CI logs, and IDE rule files that never agree, everything lives in one git-diffable place that both humans and agents read from.

The core is deterministic, local, and offline — with zero runtime dependencies. Every model-backed or precision feature is strictly opt-in, so a fresh install behaves identically whether or not you enable them.

> **Model assets are optional.** Tree-sitter parsing uses downloadable grammars
> that are **not bundled and not required**; when a grammar is absent, the graph
> falls back to its deterministic resolver.
>
> **Two model-backed features are off in a way a download will not fix.**
> Semantic memory search and the ML security detectors have no runtime shipped —
> the ONNX stack was removed for weight, so their runtime identifiers are empty
> strings (`src/security/detect/index.ts`, `src/memory/config.ts`). Re-enabling
> them means editing those constants and installing a transformers.js-API
> package, not supplying an asset. Both run on their deterministic floor
> instead: lexical recall, and regex plus entropy.

Most things degrade rather than break, but not everything. `keryx ctx rg` exits
non-zero without `ripgrep` on `PATH` rather than falling back, and the
model-backed commands — `test suggest`, `flow plan`, `memory reflect --narrate`,
`health explain --narrate` — have no deterministic mode and exit non-zero
without a credential. `wiki enrich` is the exception that degrades: it exits 0
and marks pages skipped.

## Quick Start

**Requirements:** `git` and `bun` (>= 1.1.0). Code search (`keryx ctx rg` and the
agent's `search_code` tool) additionally requires [ripgrep](https://github.com/BurntSushi/ripgrep)
(`rg`) on `PATH` — install it with `brew install ripgrep` (macOS) or `apt install ripgrep`
(Debian/Ubuntu). Without it, code search is unavailable and the harness falls back to
reading files directly.

### Install / update (global)

```bash
npm install -g @mrciphersmith/keryx
```

> **The package is scoped, and the scope matters.** The unscoped name `keryx` on
> npm belongs to [an unrelated project](https://github.com/actionhero/keryx) —
> `npm install -g keryx` installs a different program. The executable this
> package installs is still called `keryx`.

Or use the managed installer, which lays out `~/.keryx/keryx` with a wrapper at
`~/.local/bin/keryx`. Re-run either command to upgrade.

```bash
# curl (short)
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/keryx/main/install | bash

# bun (short) — pipe into bun (Bun cannot run remote https://…/file.ts as entrypoint)
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/keryx/main/install.ts | bun -
```

Pure Bun without the `curl` binary:

```bash
bun -e 'await Bun.spawn(["bash","-s"],{stdin:await fetch("https://raw.githubusercontent.com/MrCipherSmith/keryx/main/install"),stdout:"inherit",stderr:"inherit"}).exited'
```

Both paths run `scripts/install.sh --global` under the hood. Ensure `~/.local/bin` is on `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Interactive shell (TUI agent harness)

Bare `keryx` is the **CLI** (lists commands / usage). The interactive TUI agent
harness starts only with **`keryx shell`**:

```bash
keryx              # CLI help — metaproject commands
keryx shell        # OpenTUI + agent harness (default UI)
```

Useful `shell` flags:

| Flag | Effect |
|------|--------|
| *(default)* | TUI + agent |
| `--no-tui` | classic readline shell |
| `--chat` | chat without tools (readline) |
| `--agent` | agent mode explicitly |
| `--provider <p> --model <m>` | skip the provider/model picker |
| `--base-url <url>` | custom provider endpoint |

Examples:

```bash
keryx shell --provider ollama --model llama3.1:latest
keryx shell --no-tui
keryx shell --chat
```

### First project setup

```bash
cd path/to/your-project
keryx init

keryx gdgraph build          # code dependency graph
keryx test analyze           # testing context report
keryx health run --changed   # normalized health report

keryx dash                   # human admin dashboard
```

`keryx init` creates a `.metaproject/` workspace and connects your existing
`AGENTS.md` / `CLAUDE.md` entrypoints to it, so agents are routed to the right
module automatically. See the
[onboarding guide](docs/docs/onboarding.md) for the full first-run walkthrough
and alternative install paths (managed curl installer, or project-local).

## Core Ideas

A few pieces of jargon, defined once:

- **gdgraph** — a *code graph*: language-aware dependency and import graph of your
  repo (TypeScript/JavaScript, Java via Maven/Gradle, and Python), with
  cycle/orphan queries, concept and symbol lookup, call-aware impact analysis,
  shortest paths, and a PageRank-ranked repo map.
- **gdctx** — *compact context output*: runs commands, searches, and file reads
  and stores condensed results so agents don't flood their context with raw logs.
- **gdwiki** — an *architecture wiki*: a Markdown knowledge base of domain
  models, decisions, and flows, with grounded `wiki ask` retrieval, hierarchical
  indexes, and backlinks between wiki pages and code.
- **gdskills** — *agent skills*: bundled and project-generated skills that route
  agents to the right workflow, plus verification and export to different runtimes.

## Modules

`keryx` itself is the toolkit core (`init`, `status`, `update`, `dashboard`,
`rules`, `standard`, `agents`) and manages the `.metaproject/` structure. It
ships these modules:

- **gdgraph** — code dependency graph with language-aware import resolution (TypeScript/JavaScript, Java Maven/Gradle, Python); concept search, file/symbol paths, affected-set blast radius, PageRank repo map, and an optional tree-sitter symbol/call graph.
- **gdctx** — compact command / search / read output plus opt-in routing guards for supported agent runtimes.
- **gdwiki** — Markdown project wiki with hierarchical indexes, backlinks, link checks, collection, and grounded retrieval.
- **gdskills** — bundled and generated agent skills with routing, verification, learning, and export.
- **health** — normalized code-health reports from TypeScript, tests, audit, complexity, coverage, and lint (optional SonarQube).
- **testing** — testing context, related-test selection, changed-scope runs, and an opt-in coverage-map Test Impact Analysis.
- **memory** — long-term Markdown project memory with indexing, lexical search, dedup and bitemporal validity. The embedding seam exists but ships with no runtime — see the note above.
- **tasks** — an agent-first Task Manager driven by `keryx flow` for issue/task lifecycle tracking.
- **security** — deterministic secrets / PII / prompt-injection / egress scanning, redaction, and a policy gate at agent write seams.
- **mcp** — opt-in [Model Context Protocol](https://modelcontextprotocol.io) server exposing read-only module services to agents. A real module, but **off by default** — the nine above are on after `init`, this one is not.

`keryx modules` toggles modules by manifest key. Two caveats worth knowing:
`security` is enabled by default but is **not** in that command's module list, so
it cannot be toggled there; and toggling any module currently drops an enabled
`mcp` from the manifest.

**`review` and `serve` are commands, not modules.** They have no manifest entry
and are not toggleable — `keryx review` writes managed review packages under
`.metaproject/reviews/`, and `keryx serve` is the loopback HTTP entry described
below. Earlier versions of this README listed them alongside the modules; that
conflated three different things.

Two cross-cutting commands improve agent startup and routing:

- `keryx orient` emits or installs a compact graph + wiki orientation block at
  turn start for Claude, Codex, and Cursor.
- `keryx agents bootstrap` installs the Metaproject discovery rule in supported
  global agent entrypoints.

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

For an always-current starting map, install the optional orientation hook:

```bash
keryx orient install-hook --runtime codex
```

For traceable review work, create a standalone review package or attach one to
an existing flow:

```bash
keryx review start --target branch --ref feature/example
keryx review attach --flow 001 --target pull-request --ref 42
```

For agents that speak the Model Context Protocol, `keryx mcp install` wires a
read-only MCP server into Cursor or Claude in one command (opt-in, off by
default). See the [architecture doc](docs/docs/architecture.md) for the module
data flows.

## Remote Entry (opt-in, off by default)

`keryx serve` is a second door into the same agent harness `keryx shell` uses —
a loopback-bound HTTP listener, so a Telegram bot or a browser workspace can
drive a run without a second agent runtime or a second owner of session state.

```bash
keryx serve config init          # write the listener config
keryx serve token issue          # print a bearer token (only a salted hash is stored)
keryx serve                      # bind 127.0.0.1 and listen
keryx serve status --json        # configuration state
```

It is **off unless you configure it**, binds loopback unless you pass
`--acknowledge-non-loopback`, and authenticates *before* routing — so an
unauthenticated caller cannot tell a known path from an unknown one. Routes
today: `GET /v1/status`, `GET /v1/projects`, `POST /v1/turns` with
per-project idempotency keys, and `GET /v1/turns/<id>` for the durable record
and its server-sent-event stream.

Two boundaries worth knowing before you point anything at it:

- **The remote policy profile may never be weaker than the local one**; it is
  compared on every turn, and a weaker profile is refused rather than accepted.
- **Approvals are not implemented yet.** A turn whose policy decision is `ask`
  terminates in a *recorded denial* — it is never auto-approved.

`keryx projects` manages the user-global registry these routes address projects
by; `keryx init` registers a project into it.

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

- **[Changelog](CHANGELOG.md)** — what has landed since `v0.1.0`, including a
  standing list of known gaps.

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

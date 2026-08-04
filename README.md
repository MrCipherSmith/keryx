<p align="center">
  <img src="docs/assets/keryx-logo.png" alt="keryx" width="440">
</p>

<h1 align="center">keryx</h1>

<p align="center"><strong>One project-local brain for your AI agents and your team.</strong></p>

<p align="center">
  Version-controlled repository context for Codex, Claude, Cursor,<br>
  and any other AI coding agent.
</p>

<p align="center">
  <a href="https://github.com/MrCipherSmith/keryx/actions/workflows/ci.yml"><img src="https://github.com/MrCipherSmith/keryx/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@mrciphersmith/keryx"><img src="https://img.shields.io/npm/v/@mrciphersmith/keryx.svg" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

`keryx` turns what agents keep rediscovering about your repository into durable
Markdown and JSON under `.metaproject/`: code relationships, architecture,
project memory, relevant tests, quality signals, agent skills, and task state.
Every agent and every teammate reads the same context, and it is reviewed in a
diff like the rest of the code.

The core is deterministic, local, offline, and has no required runtime
dependencies. keryx does not take your coding agent away and does not make
engineering decisions for you — it gives every agent the same project context
instead of letting each one reconstruct the repository from scratch.

It also ships **an agent runtime of its own**, built directly on that context:
durable sessions, an allow/ask/deny policy engine, kernel-enforced sandboxing,
child agents and evidence-gated completion. Keep using Codex, Claude or Cursor,
run `keryx shell`, or do both — they all read the same project brain.

```bash
npm install -g @mrciphersmith/keryx

cd path/to/your-project
keryx init --yes
keryx gdgraph build
```

Local-first · deterministic core · offline by default · MIT

## Why keryx

An agent starts every task by re-deriving what your repository already knows:

- which files and symbols are connected;
- what a change is going to affect;
- which architectural decision constrains it, and why;
- which tests verify the behaviour;
- what broke the last time someone tried this;
- which project rules apply.

That work is repeated per task, per agent, per person — and the answers land in
scratchpads, CI logs and IDE rule files that never agree with each other.

keryx materializes those answers **into the repository**. The context is
versioned with the code, readable in a diff, and shared by humans and agents
alike, whichever agent runtime happens to be open.

## What you get

| Need | keryx provides |
|------|----------------|
| Understand a change | Dependency and call graph, symbol/concept lookup, affected-set blast radius |
| Recover project intent | Architecture wiki with grounded retrieval and code↔wiki backlinks |
| Avoid repeating an investigation | Long-term project memory: lessons, decisions, constraints, known mistakes |
| Choose what to verify | Related tests for a file, changed-scope runs, coverage-map test impact analysis |
| Judge readiness | Normalized health reports and a quality gate over lint, types, tests, coverage, complexity |
| Coordinate work | Versioned task flows, managed review packages, generated agent skills |
| Keep agents inside boundaries | Deterministic secret / PII / prompt-injection scanning, redaction, policy gate, OS sandbox |
| Run an agent at all | A first-party harness on top of all of the above: durable sessions, allow/ask/deny policy, child agents, evidence-gated completion |

## A typical agent workflow

One task, one repository, no re-exploration:

```bash
keryx gdgraph affected src/payments/retry.ts   # what a change here touches
keryx wiki ask "How are payment retries designed?"
keryx memory search "payment retry"            # decisions and past failures
keryx test related src/payments/retry.ts       # the verification scope
keryx health run --changed                     # normalized quality result
```

The agent gets structural context, architectural intent, previous decisions, the
tests that matter, and a normalized health result — without reconstructing any of
it by reading files at random.

### What it looks like on a real repository

Real output from a fresh clone of
[express](https://github.com/expressjs/express) — four commands, nothing edited:

```console
$ keryx init --yes
  ✓ gdgraph  ✓ gdctx  ✓ gdwiki  ✓ gdskills
  ✓ health   ✓ testing  ✓ memory  ✓ tasks  ✓ security

$ keryx gdgraph build
gdgraph build complete: 139 nodes, 153 edges

$ keryx gdgraph query cycles
No cycles found.

$ keryx gdgraph affected lib/express.js
# Affected context for lib/express.js

## Dependencies
- lib/application.js
- lib/request.js
- lib/response.js

## Dependents
- examples/route-map/index.js
- examples/route-middleware/index.js
- index.js
```

That last answer — *what breaks if I change this* — is exactly the context the
affected graph supplies deterministically, in one command.

### What lands in your repository

```text
.metaproject/
├── index.md              # the routing index every agent reads first
├── wiki/                 # architecture, domain models, decisions, flows
├── memory/               # lessons, decisions, constraints, known mistakes
├── skills/               # bundled agent skills and routing
├── project-skills/       # skills generated from your own modules
├── rules/                # your AGENTS.md / CLAUDE.md as project rules
├── data/gdgraph/         # graph artifacts, module map, query results
├── data/testing/         # test context, related tests, normalized reports
├── data/health/          # normalized health artifacts and trends
└── flows/                # task flows with frozen acceptance criteria
```

All Markdown and JSON. All diffable. All yours. And readable as a dashboard when
a human wants to look at it (`keryx dash`):

<p align="center">
  <img src="docs/assets/dashboard.png" alt="The keryx dashboard: health score, attention signals, and the enabled modules" width="880">
</p>

## The agent harness

This is the half that makes the other half worth having.

> **The agent is ephemeral; the project brain is durable.**

keryx ships its own agent runtime — not a wrapper around someone else's. It owns
the execution loop, the tool registry, permissions, sessions, subagents and
completion gates, and it assembles its context from the same `.metaproject/`
graph, wiki, memory, rules, skills, testing, health and security that every other
agent reads. That combination is the point: an agent that starts a turn already
knowing the repository, and that cannot end one by asserting it is done.

```bash
keryx shell                                   # TUI + agent (default UI)
keryx shell --no-tui                          # classic readline shell
keryx shell --chat                            # chat without tools
keryx shell --provider ollama --model gemma4:e4b     # fully local
```

Here it is answering a blast-radius question through the project graph rather
than by reading files and guessing — one tool call, twelve seconds:

<p align="center">
  <img src="docs/assets/shell.png" alt="keryx shell answering a blast-radius question with the graph_affected tool" width="880">
</p>

And when it needs a decision from you, it asks with structured options instead
of guessing — the same `ask` the policy engine raises for a guarded action:

<p align="center">
  <img src="docs/assets/shell-ask.png" alt="keryx shell asking the user a structured question with selectable options" width="880">
</p>

What is in it today:

- **Provider-neutral loop.** Anthropic, Ollama, OpenRouter and Grok, plus an
  offline fake provider for deterministic runs. Swapping the model does not
  change the loop, the tools or the policy.
- **Durable sessions, per project.** Append-only event log on disk, resume across
  a process restart, branching, and context compaction that keeps the archive.
  `/resume`, `/compact`, `/new` — and `keryx sessions list|export`.
- **A policy engine with three answers, not two.** `allow`, `ask`, `deny` over
  paths, commands, tools, network and resources. Filesystem mutation is
  path-checked, security-scanned, approval-bound and recorded as evidence.
- **Kernel-enforced containment underneath.** The OS sandbox sits *below* the
  policy engine — Seatbelt on macOS, bubblewrap on Linux — with network off/on,
  and on macOS a loopback domain allowlist, credential masking behind a per-run
  sentinel, and opt-in TLS termination. It fails closed when a launcher or a
  posture is missing rather than quietly doing less.
- **Child agents with budgets.** Dispatch over the canonical
  `subagent-dispatch`/`subagent-result` contracts, token budgets per child,
  bounded parallel scheduling, and a fleet monitor (`keryx agents monitor`).
- **Completion you can audit.** An evidence ledger backs the completion gate: a
  run that cannot produce the evidence its flow requires does not get to claim
  it finished.
- **Deterministic replay.** Recorded provider and tool fixtures replay a run with
  no network and no mutation, and report where the state transitions diverge.
- **Four doors, one loop.** The CLI (`keryx harness run|exec|extension|wave`),
  JSONL/RPC, the TUI, and the loopback HTTP entry (`keryx serve`) all drive the
  same execution loop and the same session state.

Provider-neutral means what it says — the same loop, the same tool registry and
the same policy, with the model swapped out from under it:

<p align="center">
  <img src="docs/assets/shell-deepseek.png" alt="The same keryx shell running the same tools against a different provider" width="880">
</p>

You do not have to use it. Every module above works with Codex, Claude Code or
Cursor driving them instead. But if you want an agent that is native to the
project rather than a guest in it, it is here and it is the same install.

## Core capabilities

Grouped by what you are trying to do, not by internal module layout.

**Understand the codebase**

- **gdgraph** — language-aware dependency graph for TypeScript/JavaScript, Java
  (Maven/Gradle) and Python: cycle and orphan queries, concept and symbol lookup,
  shortest paths, affected-set blast radius, PageRank repo map, and an optional
  tree-sitter symbol/call graph.
- **gdwiki** — a Markdown architecture wiki with hierarchical indexes, link
  checks, code↔wiki backlinks, and grounded `wiki ask` retrieval.
- **gdctx** — compact command, search and file-read output, so agents keep raw
  logs out of their context window while the full output stays on disk.

**Preserve knowledge**

- **memory** — long-term project memory with indexing, lexical search, dedup and
  bitemporal validity, so a lesson learned once stays learned.
- **gdskills** — bundled and project-generated agent skills with routing,
  verification, learning from reviews, and export to different agent runtimes.

**Change with confidence**

- **testing** — testing context, related-test selection, changed-scope runs, and
  an opt-in coverage-map Test Impact Analysis.
- **health** — normalized reports from TypeScript, tests, audit, complexity,
  coverage and lint (optional SonarQube), plus a quality gate and trends.
- **review** — managed review packages under `.metaproject/reviews/`, standalone
  or attached to a flow, so review findings become durable project artifacts.

**Operate agents**

- **tasks** — an agent-first Task Manager driven by `keryx flow`, with frozen
  acceptance criteria and status gates.
- **security** — deterministic secrets / PII / prompt-injection / egress
  scanning, redaction, and a policy gate at agent write seams, with a committed
  evaluation corpus.
- **mcp** — an opt-in [Model Context Protocol](https://modelcontextprotocol.io)
  server exposing read-only module services to agents.

**Run agents inside boundaries**

- **harness** — the first-party agent runtime described above: provider-neutral
  loop, durable sessions, policy engine, child agents, evidence-gated completion,
  deterministic replay.
- **sandbox** — kernel-enforced containment under the policy engine
  (`keryx harness exec`), with filesystem boundaries, network posture and, on
  macOS, a domain allowlist with credential masking.
- **remote entry** — `keryx serve`, a loopback-bound authenticated HTTP door into
  the same harness, so a bot or a browser workspace can drive a run.

`keryx modules` toggles modules by manifest key; `keryx status` shows what is
enabled. Nine modules are on after `init`; `mcp` is opt-in.

## Quick start

**Requirements:** `git` and `bun` (>= 1.1.0).

```bash
npm install -g @mrciphersmith/keryx

cd path/to/your-project
keryx init
keryx gdgraph build          # code dependency graph
keryx test analyze           # testing context report
keryx health run --changed   # normalized health report
keryx dash                   # human admin dashboard
```

`keryx init` creates the `.metaproject/` workspace and connects your existing
`AGENTS.md` / `CLAUDE.md` entrypoints to it, so agents are routed to the right
module automatically.

> **The package is scoped, and the scope matters.** The unscoped name `keryx` on
> npm belongs to [an unrelated project](https://github.com/actionhero/keryx).
> Install `@mrciphersmith/keryx`; the executable it installs is called `keryx`.

Alternative install paths — the managed installer (`~/.keryx` with a wrapper in
`~/.local/bin`), project-local installs, and running from source — are in the
[onboarding guide](docs/docs/onboarding.md).

Bare `keryx` prints the CLI surface; `keryx shell` starts the agent harness
described [above](#the-agent-harness).

## Agent integrations

| Runtime | Integration |
|---------|-------------|
| Claude Code | `CLAUDE.md` routing, orientation hook, security hooks, MCP server |
| Codex | `AGENTS.md` routing and orientation hook |
| Cursor | Rules/orientation, security hooks, MCP server |
| Any other agent | Repository-local Markdown/JSON artifacts under `.metaproject/` |

After `init`, agents follow the root `AGENTS.md`/`CLAUDE.md` pointer to
`.metaproject/index.md`, which routes them to the right capability. Two commands
sharpen that routing:

```bash
keryx orient install-hook --runtime codex   # graph + wiki map at turn start
keryx agents bootstrap install --runtime claude
keryx mcp install --runtime cursor          # opt-in read-only MCP server
```

## Requirements and compatibility

| Requirement | Status |
|-------------|--------|
| Bun | >= 1.1.0 |
| Git | Required |
| ripgrep | Required only for `keryx ctx rg` and the agent's `search_code` tool |
| Model provider credential | Required only for the optional AI commands below |
| macOS | Full support, including the complete policy sandbox |
| Linux | Full core support; filesystem containment and network on/off (needs `bubblewrap`) |
| Windows | Core CLI is not verified in CI; the OS sandbox is macOS/Linux only |
| CI | Ubuntu and macOS runners on every push |

## Optional AI features

The graph, wiki, memory, testing, health, task, review and security workflows are
deterministic and run with no model provider at all. A small set of commands adds
model-generated suggestions or narration on top, and those require a configured
credential:

- `keryx test suggest <file>` — a test plan matching your project's frameworks
- `keryx flow plan <id>` — task breakdown for a flow
- `keryx memory reflect --narrate` — a narrative summary of project memory
- `keryx health explain <target> --narrate` — a readable explanation of a health result
- `keryx wiki enrich` — model-written wiki pages (skips pages without a credential)

Semantic embeddings and ML security classifiers are not bundled in the current
release. Memory search uses lexical retrieval, and security scanning uses
deterministic rules plus entropy analysis — both fully functional on that floor.
The seams exist for the model-backed variants when they ship.

Tree-sitter grammars for the symbol/call graph are downloadable and optional; the
graph falls back to its deterministic resolver when a grammar is absent.

## Current limitations

| Limitation | Impact | Alternative |
|------------|--------|-------------|
| No remote approval transport | A remote turn whose policy decision is `ask` ends in a recorded denial | Run approval-requiring turns locally |
| Domain allowlist is macOS-only | Domain-level egress policy, credential masking and TLS termination refuse to run on Linux rather than silently doing less | Filesystem containment and network on/off work on both |
| No bundled embedding runtime | No semantic ranking in memory search | Lexical memory search remains fully available |
| ripgrep is external | `keryx ctx rg` needs `rg` on `PATH` | Install ripgrep, or let the agent read files directly |
| Model commands need a credential | The five commands above exit non-zero without one | Everything else runs deterministically offline |

Full detail, including known defects and platform caveats:
[limitations](docs/docs/limitations.md).

## Remote entry (opt-in, off by default)

`keryx serve` is a second door into the same agent harness `keryx shell` uses — a
loopback-bound HTTP listener, so a Telegram bot or a browser workspace can drive
a run without a second agent runtime or a second owner of session state.

```bash
keryx serve config init          # write the listener config
keryx serve token issue          # print a bearer token (only a salted hash is stored)
keryx serve                      # bind 127.0.0.1 and listen
keryx serve status --json        # configuration state
```

It is off unless you configure it, binds loopback unless you pass
`--acknowledge-non-loopback`, and authenticates *before* routing, so an
unauthenticated caller cannot tell a known path from an unknown one. The remote
policy profile may never be weaker than the local one — it is compared on every
turn and a weaker profile is refused. See
[drive keryx remotely](docs/docs/guides/drive-keryx-remotely.md) for routes and
setup.

## CI integration

CI can publish normalized, committable artifacts that humans and agents read
later:

```bash
keryx gdgraph build
keryx test analyze
keryx health run --changed
keryx dashboard build
```

`keryx health gate --strict-warn` fails a job on the normalized health gate
instead of parsing raw linter/test logs, and `keryx security eval --corpus all`
fails on any detector breaching its committed false-negative threshold. See
[run keryx in CI](docs/docs/guides/run-in-ci.md).

## Documentation

Full documentation site: **<https://mrciphersmith.github.io/keryx/>**

- **[Onboarding](docs/docs/onboarding.md)** — install paths, first-run walkthrough, the build loop.
- **[Architecture](docs/docs/architecture.md)** — the four-layer pattern, invariants, cross-module data flows.
- **[Module reference](docs/docs/modules.md)** — one section per module: purpose, CLI surface, mechanics, data paths.
- **[CLI reference](docs/docs/cli-reference.md)** — every command, subcommand, flag and exit code.
- **[Workspace & lifecycle](docs/docs/workspace-and-lifecycle.md)** — the `.metaproject/` contract and `init`/`update` lifecycle.
- **[Limitations](docs/docs/limitations.md)** — known gaps, platform caveats, and what to do instead.
- **[Changelog](CHANGELOG.md)** — what has landed since `v0.1.0`.

Run `keryx <command> --help` (or `keryx` with no arguments) for the live command
surface.

## Local development

```bash
bun ./src/cli.ts init
bun ./src/cli.ts status
bun run check      # typecheck + tests
```

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).

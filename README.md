# gd-metapro

**gd-metapro** is a single-binary Bun/TypeScript CLI whose one job is to scaffold and maintain a per-project **`.metaproject/`** workspace — a file-based "agent operating system" that materializes a repository's structure, quality, tests, conventions, and history as durable Markdown plus machine-readable JSON.

Instead of an AI coding agent re-deriving a project's context from raw files on every task, gd-metapro captures that knowledge under `.metaproject/` and installs routing rules so any agent that reads the repo's `AGENTS.md`/`CLAUDE.md` is directed to consult the workspace first.

> The product/CLI name is `gd-metapro`; `meta-project` is the GitHub repository slug (`MrCipherSmith/meta-project`).

## Highlights

- **Local-first, offline.** No database, no HTTP server. State lives on disk under `.metaproject/`; external tools (`git`, `gh`, `eslint`, `tsc`) are optional and degrade gracefully.
- **Deterministic mechanics, delegated cognition.** The CLI only scans, graphs, scores, checksums, and renders templates — the "thinking" is delegated to the agent skills the workspace ships.
- **Idempotent by design.** `init` and `update` are safe to re-run: managed files use seed-once / reconcile-on-change writes and sentinel-delimited managed blocks, so your hand edits are preserved.
- **Eight optional modules**, loosely coupled through files under `.metaproject/data/` rather than direct calls.

## Requirements

- `git`
- `bun` (>= 1.1.0)

## Install

### Global

```bash
bun install -g github:MrCipherSmith/meta-project
gd-metapro init
```

Or via the installer script (clones the runtime into `~/.gd-metapro/gd-metapro` and writes a wrapper script at `~/.local/bin/gd-metapro`):

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/meta-project/main/scripts/install.sh | bash -s -- --global
gd-metapro init
```

Make sure `~/.local/bin` is on your `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Project-local

Installs the runtime under `.metaproject/runtime/gd-metapro` and runs `init` immediately — no global command:

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/meta-project/main/scripts/install.sh | bash -s -- --project
```

See [docs/docs/onboarding.md](docs/docs/onboarding.md) for the private-repo (`gh`) install variants and non-interactive (`--yes`) mode.

## Quick start

```bash
gd-metapro init                 # scaffold .metaproject/, enable modules, wire AGENTS.md/CLAUDE.md
gd-metapro gdgraph build        # build the dependency graph
gd-metapro wiki collect         # draft wiki pages from module artifacts
gd-metapro health run           # score code quality against the gate
gd-metapro test analyze         # detect the test stack and context
gd-metapro dashboard build      # regenerate the HTML dashboard
gd-metapro status               # show enabled modules
```

`init` is interactive by default (pass `--yes` to accept defaults). After pulling changes, run `gd-metapro update` to refresh managed service files without touching `.metaproject/data/**`.

## Modules

The eight optional product modules (all enabled by default at `init`; disable any with `--no-<module>`):

| Module | Command | Role |
|---|---|---|
| gdgraph | `gd-metapro gdgraph` | Build and query a regex-based intra-project import/dependency graph (cycles, orphans, affected). |
| gdctx | `gd-metapro ctx` | Token-aware wrapper: run git/rg/shell/read, persist raw output, print a compacted Markdown summary. |
| gdwiki | `gd-metapro wiki` | File-based project knowledge base; hand-authored pages plus auto-collected drafts from sibling modules' data. |
| gdskills | `gd-metapro skills` | Manage bundled and project agent skills — install, route, verify, learn, export/sync; owns the JSON interop contracts. |
| health | `gd-metapro health` | Aggregate code-quality signals into per-scope scores, compare to baseline, evaluate a pass/warn/fail gate. |
| testing | `gd-metapro test` | Detect the test stack, run the project's existing runner (optionally changed-scoped), normalize results into a report. |
| memory | `gd-metapro memory` | Long-term typed project memory (lessons/decisions/constraints) with deterministic search, dedup, ingest, reflect. |
| tasks (flow) | `gd-metapro flow` | Agent-first work lifecycle: scaffold a "flow" package, drive a status state machine, enforce completion gates. |

Modules can be toggled after `init` with `gd-metapro modules [status | enable <name> | disable <name>]`. The `rules` command (`gd-metapro rules`) and the CLI core (`init`/`status`/`update`/`dashboard`/`modules`) are cross-cutting rather than optional modules.

## The `.metaproject/` workspace

`init` scaffolds a workspace that separates **source-of-truth** files (human-editable, seed-once or hand-authored) from **generated `data/` artifacts** (disposable module outputs the lifecycle commands never overwrite):

```text
.metaproject/
  metaproject.json          # manifest — authoritative runtime config
  index.md                  # agent entrypoint: module/rules/skills/data map
  gd-metapro-dashboard.html # self-contained human dashboard
  rules/  skills/  modules/ # agent-facing rules, skills, module manifests (versioned)
  wiki/   flows/            # knowledge base + task flows (source of truth)
  data/                     # generated module artifacts (mostly gitignored)
  hooks/                    # post-update hooks
```

Full details — the manifest, agent entrypoints and the `<!-- gd-metapro:index -->` routing block, versioned-vs-ignored paths, and `init`/`update` semantics — are in [docs/docs/workspace-and-lifecycle.md](docs/docs/workspace-and-lifecycle.md).

## Documentation

Full developer documentation lives in **[docs/docs/](docs/docs/)** (reverse-engineered from the source):

- **[Onboarding](docs/docs/onboarding.md)** — install paths, first-run walkthrough, the build loop, TTY/CI behavior.
- **[Architecture](docs/docs/architecture.md)** — the four-layer pattern, the two invariants, cross-module data flows, integrations.
- **[Module reference](docs/docs/modules.md)** — one section per module: purpose, CLI surface, key files, mechanics, data paths.
- **[CLI reference](docs/docs/cli-reference.md)** — every command, subcommand, and flag.
- **[Workspace & lifecycle](docs/docs/workspace-and-lifecycle.md)** — the `.metaproject/` contract and `init`/`update` lifecycle.

Product specifications (intended design) live separately under [docs/requirements/](docs/requirements/). Where the two disagree, `docs/docs/` describes current behavior.

## Development

```bash
bun ./src/cli.ts init --yes     # run the CLI from source
bun test                        # run the test suite
bun run build                   # bundle to dist/cli.js
bun run check                   # typecheck + tests
```

## License

See the repository for license details.

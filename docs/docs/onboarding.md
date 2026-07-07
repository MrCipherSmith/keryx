# Onboarding

Welcome to **gd-metapro** — a CLI-first toolkit (Bun/TypeScript) that installs and maintains a local `.metaproject/` workspace inside any codebase. That workspace is a file-based "agent operating system": durable Markdown + JSON artifacts (a code graph, a knowledge wiki, health scores, test reports, memory, and agent skills) that let AI agents and developers share the same structured project context. Everything is local-first and offline — no server, no database, and external tools (git, gh, eslint, tsc) are optional and degrade gracefully.

The public command is `gd-metapro`. This guide gets you from zero to a running workspace.

## Requirements

- `git`
- `bun` (>= 1.1.0)

External tools like `gh` (GitHub CLI), `eslint`, and `tsc` are used opportunistically by some modules but are never hard dependencies.

## Install

You can install `gd-metapro` as a global command, as a project-local runtime, or run it straight from source for local development.

### Global install

Installs a wrapper at `~/.local/bin/gd-metapro` that execs the cloned runtime via `bun`. The runtime lives in `~/.gd-metapro/gd-metapro`.

Using Bun directly from the GitHub source:

```bash
bun install -g github:MrCipherSmith/meta-project
gd-metapro init
```

Using the installer script (public/raw):

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/meta-project/main/scripts/install.sh | bash -s -- --global
gd-metapro init
```

Private repository (through GitHub CLI):

```bash
gh auth setup-git
gh api repos/MrCipherSmith/meta-project/contents/scripts/install.sh --jq .content | base64 -d | bash -s -- --global
gd-metapro init
```

Make sure `~/.local/bin` is on your `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Project-local install

Use this when you do not want a global command. It clones the runtime into the current project under `.metaproject/runtime/gd-metapro` and immediately runs `init`.

Public/raw:

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/meta-project/main/scripts/install.sh | bash -s -- --project
```

Non-interactive:

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/meta-project/main/scripts/install.sh | bash -s -- --project --yes
```

Private repository:

```bash
gh auth setup-git
gh api repos/MrCipherSmith/meta-project/contents/scripts/install.sh --jq .content | base64 -d | bash -s -- --project
```

### Local development (from a clone of this repo)

Run the CLI directly from source with Bun — no build step required:

```bash
bun ./src/cli.ts init
bun ./src/cli.ts init --yes
bun ./src/cli.ts status
```

Run tests, build the distributable, and run the full quality gate:

```bash
bun test                 # run the co-located *.test.ts suite
bun run build            # bundle src/cli.ts -> dist/cli.js (the published bin)
bun run check            # quality gate: tsc --noEmit && bun test
```

`bun run typecheck` (`tsc --noEmit`) is available on its own, and `bun run gd-metapro` is a shortcut for `bun ./src/cli.ts`.

## First-run walkthrough

### Step 1 — Initialize the workspace

From the root of the project you want to instrument:

```bash
gd-metapro init
```

`init` is interactive by default: it asks which of the 8 optional modules to enable (all default on) and, for `gdskills`, which install profile to use. Pass `--yes` to accept defaults non-interactively.

It scaffolds `.metaproject/` with:

```text
.metaproject/
  index.md                    # agent entrypoint: module / rules / skills / data map
  gd-metapro-dashboard.html   # self-contained human dashboard
  metaproject.json            # authoritative runtime manifest
  README.md
  core/  data/  rules/  skills/  modules/  reports/  templates/
  hooks/post-update.d/
```

It also connects your repo's agent entrypoints — importing an existing `AGENTS.md`/`CLAUDE.md` into `.metaproject/rules/` (or creating `AGENTS.md` if none exists) and injecting a managed routing block that points agents at `.metaproject/index.md` first. Each enabled module adds its own `core/`, `data/`, and `skills/` subtrees. On a project with `.git`, opt-in git hooks (post-commit graph/skills/health reminders, dashboard rebuild) can be installed.

`init` is idempotent — re-running it refreshes managed files but never clobbers your hand-edited files or anything under `.metaproject/data/`.

Useful `init` flags:

```bash
gd-metapro init --yes                 # non-interactive, accept defaults
gd-metapro init --no-gdgraph          # disable a module (also --no-gdctx, --no-gdwiki,
                                      #   --no-gdskills, --no-health, --no-testing,
                                      #   --no-memory, --no-tasks)
gd-metapro init --gdskills-profile <v>
gd-metapro init --yes --no-gdgraph-hook   # skip a specific git hook
```

### Step 2 — The typical loop

Once the workspace exists, this is the usual cycle for producing and refreshing project knowledge. Modules are loosely coupled through files under `.metaproject/data/` — later steps read what earlier steps wrote, so ordering matters (each is a no-op-friendly read if upstream data is missing).

```bash
gd-metapro gdgraph build      # 1. build the import/dependency graph
gd-metapro wiki collect       # 2. draft wiki pages from graph/health/testing data
gd-metapro health run         # 3. aggregate code-health signals into scored reports
gd-metapro test analyze       # 4. detect the test stack and build testing context
gd-metapro dashboard build    # 5. regenerate the self-contained HTML dashboard
gd-metapro status             # 6. print which modules are enabled
```

Notes on each:

- **`gdgraph build`** writes `data/gdgraph/storage/{nodes,edges}.jsonl` plus a summary and module map. Query it with `gd-metapro gdgraph query cycles`, `... query orphans`, or `gd-metapro gdgraph affected <file>`.
- **`wiki collect`** reads the graph, latest health report, and testing context (all optional) and emits draft architecture/component wiki pages. Run it *after* `gdgraph build` / `health run` to get the richest drafts.
- **`health run`** scores code quality from tsc, tests, audit, complexity, coverage, and lint signals. Add `--changed` to scope to changed files.
- **`test analyze`** inspects your existing test stack and writes testing context; `gd-metapro test run --changed` runs the project's own test runner scoped to changes.
- **`dashboard build`** rebuilds `.metaproject/gd-metapro-dashboard.html` from current service files and data snapshots. Use `gd-metapro dashboard open` (or bare `gd-metapro dash`) to build and open it. The dashboard reads data only — it never runs analyzers or writes under `data/`.
- **`status`** reads the manifest and reports `enabled`/`disabled` per module (or tells you the workspace is not initialized / incomplete).

Two other modules round out the loop as you work:

```bash
gd-metapro memory search "decision"   # long-term typed project memory
gd-metapro flow init --title "..."    # agent-first task lifecycle (the `tasks` module)
```

Every command exposes more subcommands and flags — run `gd-metapro <command> --help`, or `gd-metapro` with no arguments for the full usage block.

## After pulling changes

When you pull updates to the toolkit or your teammates' workspace changes, refresh the managed runtime and service layer:

```bash
gd-metapro update
```

`update` refreshes managed scripts, skills, module manifests, hook definitions, and the dashboard. It does **not** run analyzers and does **not** write `.metaproject/data/**` — your accumulated project knowledge is left untouched (it reports "Data artifacts were left untouched"). By default it also self-refreshes the runtime from `origin/main` before updating service files.

```bash
gd-metapro update --skip-runtime   # skip the network runtime refresh
gd-metapro update --no-tasks       # skip auto-backfilling the tasks module
gd-metapro update --hooks          # run executables in hooks/post-update.d/
```

Workspaces created before the `tasks` module existed are automatically backfilled by `update` (opt out with `--no-tasks`).

## TTY / CI behavior

`gd-metapro` is safe to run in pipelines and non-interactive shells:

- **Non-interactive prompts** — pass `--yes` to `init` to accept all defaults without prompting. When stdin is not a TTY, prompts fall back to their defaults automatically, so piped/CI runs never hang.
- **Color output** — color is gated on the terminal. Set `NO_COLOR` to disable ANSI color, or `FORCE_COLOR` to force it on; when output is not a TTY, color is off by default so logs stay clean.

## Where things live

- **Workspace layout, the `.metaproject/` contract, and the init/update lifecycle:** see `docs/docs/workspace-and-lifecycle.md`.
- **Every command, subcommand, and flag:** see `docs/docs/cli-reference.md`.

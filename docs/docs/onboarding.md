# Onboarding

Welcome to **keryx** — a CLI-first toolkit (Bun/TypeScript) that installs and maintains a local `.metaproject/` workspace inside any codebase. That workspace is a file-based "agent operating system": durable Markdown + JSON artifacts (a code graph, a knowledge wiki, health scores, test reports, memory, and agent skills) that let AI agents and developers share the same structured project context. Everything is local-first and offline — no server, no database, and external tools (git, gh, eslint, tsc) are optional and degrade gracefully.

The public command is `keryx`. This guide gets you from zero to a running workspace.

## Requirements

- `git`
- `bun` (>= 1.1.0)

External tools like `gh` (GitHub CLI), `eslint`, and `tsc` are used opportunistically by some modules but are never hard dependencies.

## Install

You can install `keryx` as a global command, as a project-local runtime, or run it straight from source for local development.

### Global install

Managed layout: clones into `~/.keryx/keryx` and writes `~/.local/bin/keryx`.
Re-run either short command to update:

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

Both are thin wrappers around `scripts/install.sh --global`.

Private repository (through GitHub CLI):

```bash
gh auth setup-git
gh api repos/MrCipherSmith/keryx/contents/scripts/install.sh --jq .content | base64 -d | bash -s -- --global
```

Make sure `~/.local/bin` is on your `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Then:

```bash
keryx init
```

### Project-local install

Use this when you do not want a global command. It clones the runtime into the current project under `.metaproject/runtime/keryx` and immediately runs `init`.

Public/raw:

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/keryx/main/scripts/install.sh | bash -s -- --project
```

Non-interactive:

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/keryx/main/scripts/install.sh | bash -s -- --project --yes
```

Private repository:

```bash
gh auth setup-git
gh api repos/MrCipherSmith/keryx/contents/scripts/install.sh --jq .content | base64 -d | bash -s -- --project
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

`bun run typecheck` (`tsc --noEmit`) is available on its own, and `bun run keryx` is a shortcut for `bun ./src/cli.ts`.

#### Running the suite concurrently (several worktrees at once)

The suite is safe to run concurrently — several agent sessions routinely run
`bun test` at the same time from different worktrees. That only holds because
**every test fixture root is unique per run**. A fixture rooted at a fixed path
is not private to one run: `tmpdir()/keryx-foo` resolves to the same directory
for every checkout on the machine, and `<repo>/.tmp-foo` for every process in
one worktree. One run's `rm -rf` then deletes another run's fixture mid-test.

So when you add a test that needs a directory on disk, build its root with
`uniqueTestRoot(parent, prefix)` from `src/lib/test-tmp.ts` — never
`path.join(tmpdir(), "fixed-name")`. The same applies to any other externally
visible identity a test claims: ports (`listen(0)`), and artifact run ids, which
are only safe because they live under a root that is already unique.

Collisions are silent and look like unrelated bugs, so they are worth
recognising: an `ENOENT` for a file the test just wrote, an
`immutable … run already exists` error from another run's leftover artifact, or
`ENOENT: no such file or directory, posix_spawn 'git'` — which reports the
*binary* but actually means the spawn's **cwd** was deleted underneath it.

To verify concurrency safety after a change, run the stress harness:

```bash
bun scripts/stress/concurrent-suite-stress.ts --runs 6 --repeat 2
```

It runs N full suites at once and reports per-run tallies plus failing test
names; transcripts of failing runs are kept in `.tmp-stress-logs/`. It exits
non-zero if any run failed.

One known residual, unrelated to shared state: the live-loopback TLS tests in
`src/harness/process/sandbox/proxy-tls.test.ts` do real TLS handshakes and
shell out to `openssl`, so they are load-sensitive and can time out on a
saturated machine (observed once in 48 concurrent runs). They use ephemeral
ports and an `mkdtemp` CA workspace, so this is machine load, not a collision.

## First-run walkthrough

### Step 1 — Initialize the workspace

From the root of the project you want to instrument:

```bash
keryx init
```

`init` is interactive by default: it asks which of the 9 optional modules to enable — `gdgraph`, `gdctx`, `gdwiki`, `gdskills`, `health`, `testing`, `memory`, `tasks`, and `security` (all default on) — and, for `gdskills`, which install profile to use. It also offers one opt-in module, the MCP server, which defaults **off** (see [Wiring the workspace into an editor/agent](#wiring-the-workspace-into-an-editoragent-mcp) below). Pass `--yes` to accept defaults non-interactively.

It scaffolds `.metaproject/` with:

```text
.metaproject/
  index.md                    # agent entrypoint: module / rules / skills / data map
  keryx-dashboard.html   # self-contained human dashboard
  metaproject.json            # authoritative runtime manifest
  README.md
  core/  data/  rules/  skills/  modules/  reports/  templates/
  hooks/post-update.d/
```

It also connects your repo's agent entrypoints — importing an existing `AGENTS.md`/`CLAUDE.md` into `.metaproject/rules/` (or creating `AGENTS.md` if none exists) and injecting a managed routing block that points agents at `.metaproject/index.md` first. Each enabled module adds its own `core/`, `data/`, and `skills/` subtrees. On a project with `.git`, opt-in git hooks (post-commit graph/skills/health reminders, dashboard rebuild) can be installed.

`init` is idempotent — re-running it refreshes managed files but never clobbers your hand-edited files or anything under `.metaproject/data/`.

Useful `init` flags:

```bash
keryx init --yes                 # non-interactive, accept defaults
keryx init --no-gdgraph          # disable a module (also --no-gdctx, --no-gdwiki,
                                      #   --no-gdskills, --no-health, --no-testing,
                                      #   --no-memory, --no-tasks, --no-security)
keryx init --gdskills-profile <v>
keryx init --yes --no-gdgraph-hook   # skip a specific git hook
```

### Step 2 — The typical loop

Once the workspace exists, this is the usual cycle for producing and refreshing project knowledge. Modules are loosely coupled through files under `.metaproject/data/` — later steps read what earlier steps wrote, so ordering matters (each is a no-op-friendly read if upstream data is missing).

```bash
keryx gdgraph build      # 1. build the import/dependency graph
keryx wiki collect       # 2. draft wiki pages from graph/health/testing data
keryx health run         # 3. aggregate code-health signals into scored reports
keryx test analyze       # 4. detect the test stack and build testing context
keryx dashboard build    # 5. regenerate the self-contained HTML dashboard
keryx status             # 6. print which modules are enabled
```

Notes on each:

- **`gdgraph build`** writes `data/gdgraph/storage/{nodes,edges}.jsonl` plus a summary and module map. Use `gdgraph find` for concepts, `affected` for blast radius, `path` for relationships, and the optional `symbol --impact` surface when tree-sitter symbols are enabled.
- **`wiki collect`** reads the graph, latest health report, and testing context (all optional), emits a hierarchical full-coverage draft scaffold, updates backlinks, and reports how many component pages still need prose enrichment. Run it *after* `gdgraph build` / `health run` to get the richest drafts.
- **`health run`** scores code quality from tsc, tests, audit, complexity, coverage, and lint signals. Add `--changed` to scope to changed files.
- **`test analyze`** inspects your existing test stack and writes testing context; `keryx test run --changed` runs the project's own test runner scoped to changes.
- **`dashboard build`** rebuilds `.metaproject/keryx-dashboard.html` from current service files and data snapshots. Use `keryx dashboard open` (or bare `keryx dash`) to build and open it. The dashboard reads data only — it never runs analyzers or writes under `data/`.
- **`status`** reads the manifest and reports `enabled`/`disabled` per module (or tells you the workspace is not initialized / incomplete).

Three other modules round out the loop as you work:

```bash
keryx memory search "decision"   # long-term typed project memory
keryx flow init --title "..."    # agent-first task lifecycle (the `tasks` module)
keryx security status            # policy-based scanning, redaction, guardrails, audit
```

Optional integrations improve agent startup and review traceability:

```bash
keryx orient install-hook --runtime codex
keryx ctx install-hook --runtime codex
keryx review start --target branch --ref feature/example
```

The orientation hook injects a bounded graph + wiki map at turn start. The gdctx
routing guard keeps broad raw shell/search output out of the agent context.
Managed review packages preserve coverage, findings, decisions, and learning
candidates for standalone or flow-attached reviews.

The `security` module is enabled by default, so `init` asks whether to enable it (and, on a git repo, whether to install a pre-push guard and project-local `.claude/settings.json` agent hooks). Once the workspace exists, check its state with `keryx security status` and scan a path for secrets/policy findings with `keryx security scan <path>`. Disable the module entirely with `keryx init --no-security`.

Every command exposes more subcommands and flags — run `keryx <command> --help`, or `keryx` with no arguments for the full usage block.

## After pulling changes

When you pull updates to the toolkit or your teammates' workspace changes, refresh the managed runtime and service layer:

```bash
keryx update
```

`update` refreshes managed scripts, skills, module manifests, hook definitions, and the dashboard. It does **not** run analyzers and does **not** write `.metaproject/data/**` — your accumulated project knowledge is left untouched (it reports "Data artifacts were left untouched"). By default it also self-refreshes the runtime from `origin/main` before updating service files.

```bash
keryx update --skip-runtime   # skip the network runtime refresh
keryx update --no-tasks       # skip auto-backfilling the tasks module
keryx update --hooks          # run executables in hooks/post-update.d/
```

Workspaces created before the `tasks` module existed are automatically backfilled by `update` (opt out with `--no-tasks`).

After updating, confirm the workspace still conforms to the Metaproject Standard:

```bash
keryx standard validate    # PASS/FAIL report, non-zero exit on violations
keryx standard doctor      # actionable fix hints
keryx standard capabilities # standard version, profiles, enabled modules
```

## Wiring the workspace into an editor/agent (MCP)

The MCP server module exposes the `.metaproject/` workspace to editors and agents (Cursor, Claude Code, or any generic MCP client) over the Model Context Protocol. It is the one module that defaults **off** — `init` asks whether to enable it, and you can always wire it up later.

```bash
keryx mcp install --runtime cursor    # write .cursor/mcp.json
keryx mcp install --runtime claude    # write .mcp.json (Claude Code)
keryx mcp install --runtime generic   # print a config snippet to paste anywhere
keryx mcp install --runtime all        # cursor + claude (the default)
```

`install` writes a project-local MCP client config, sets `modules.mcp.enabled=true` in `.metaproject/metaproject.json`, and prints a snippet for `generic`. Pass `--dry-run` to preview the change without writing anything, and use `keryx mcp uninstall --runtime <...>` to remove just the managed keryx entry.

The server itself runs over stdio by default:

```bash
keryx mcp serve                # stdio JSON-RPC MCP server (what clients launch)
keryx mcp serve --http         # isolated localhost HTTP/SSE transport (opt-in)
```

Serving requires the optional `@modelcontextprotocol/sdk`; `install` only probes for it and never installs it or opens a network connection.

## TTY / CI behavior

`keryx` is safe to run in pipelines and non-interactive shells:

- **Non-interactive prompts** — pass `--yes` to `init` to accept all defaults without prompting. When stdin is not a TTY, prompts fall back to their defaults automatically, so piped/CI runs never hang.
- **Color output** — color is gated on the terminal. Set `NO_COLOR` to disable ANSI color, or `FORCE_COLOR` to force it on; when output is not a TTY, color is off by default so logs stay clean.

## Where things live

- **Workspace layout, the `.metaproject/` contract, and the init/update lifecycle:** see [workspace-and-lifecycle.md](./workspace-and-lifecycle.md).
- **Every command, subcommand, and flag:** see [cli-reference.md](./cli-reference.md).

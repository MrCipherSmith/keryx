# Set up a project end to end

This guide takes a real project from no Keryx to a fully built and validated
workspace connected to your coding agent. The [quickstart](../getting-started/quickstart.md)
is the short version; this is the one to follow for a project your team will
use.

Run every command from the repository root.

## Prerequisites

- Keryx installed: `keryx --version` prints a version. See [Install](../getting-started/install.md).
- `git` and Bun 1.3.14 or newer.
- Optional: `gh` for pull-request and issue integration, `ripgrep` for code
  search, and the tools your project already uses for lint, type checks and
  tests.

`keryx setup` prints this sequence as a checklist without running anything.
`keryx setup refresh` and `keryx setup repair` print the variants for an
existing workspace.

## 1. Initialize the workspace

```bash
keryx init --yes
```

`--yes` turns on the nine default modules (graph, compact output, wiki, skills,
health, testing, memory, tasks, security), installs the recommended skills and
the default git hooks, and asks nothing. Without `--yes`, `init` first asks
whether to accept the recommended defaults, then asks module by module.

Three optional layers stay off unless you ask for them. Turning them on records
the choice in the manifest; it does not download anything or change your
editor's configuration:

```bash
keryx init --yes --mcp --treesitter --testing-tia
```

| Option | Effect |
|---|---|
| `--yes`, `-y` | Accept the recommended defaults without prompts. |
| `--no-gdgraph`, `--no-gdctx`, `--no-gdwiki`, `--no-gdskills`, `--no-health`, `--no-testing`, `--no-memory`, `--no-tasks`, `--no-security` | Leave that module off. |
| `--gdskills-profile <profile>` | Skill profile: `minimal`, `recommended`, `full` or `custom`. |
| `--no-<name>-hook` | Skip one git hook, for example `--no-gdgraph-hook`. |
| `--mcp` | Turn on the MCP server module ([step 5](#5-optional-publish-the-workspace-over-mcp)). |
| `--treesitter` | Turn on the symbol layer ([step 6](#6-optional-add-the-symbol-layer)). |
| `--testing-tia` | Turn on coverage-based test selection ([step 7](#7-optional-add-coverage-based-test-selection)). |
| `--sac` | Turn on Shared Agent Context (experimental). |
| `--external-agents` | Allow delegation to external agent CLIs in this project. |

`init` is idempotent. Re-running it refreshes managed files and never overwrites
your edits or anything under `.metaproject/data/`.

Commit the result. The workspace is meant to be versioned with the code; see
[The Metaproject](../concepts/metaproject.md#what-gets-committed).

## 2. Build the project context

Run these once after `init`. Each reads what the previous ones wrote, so the
order matters.

```bash
keryx gdgraph build
keryx test analyze
keryx test run --strict
keryx health run --strict
keryx wiki collect --force
keryx wiki index
keryx wiki check-links
keryx wiki validate
keryx memory index
keryx memory check
keryx dashboard build
```

| Command | What it produces |
|---|---|
| `gdgraph build` | The file dependency graph, a module map and a summary. |
| `test analyze` | The detected test frameworks, scripts and conventions. It does not run tests. |
| `test run --strict` | Runs your own test command and writes a normalized report. |
| `health run --strict` | Collects lint, type, test, complexity, coverage and audit signals and evaluates the gate. |
| `wiki collect --force` | Drafts wiki pages from the graph, health and testing data. Pages a person has edited are kept. |
| `wiki index`, `check-links`, `validate` | Rebuild the wiki index and check links and metadata. |
| `memory index`, `memory check` | Rebuild the memory catalog and check entries and links. |
| `dashboard build` | A self-contained HTML dashboard at `.metaproject/keryx-dashboard.html`. |

`health run --strict` exits 1 when a required source is missing. That is the
intended result, not a crash: a missing source is a gap, not a pass.

```text
# Code Health: INCOMPLETE

scope: project (strict)
…
- INCOMPLETE: required source unavailable: eslint
- INCOMPLETE: required source unavailable: typescript
…
```

Install the missing tool, or set that source's `"required"` to `false` in
`.metaproject/health.config.json` if the project does not use it.

## 3. Validate the workspace

```bash
keryx standard validate
keryx standard doctor
keryx security policy validate
keryx flow check
```

```text
keryx standard validate
  Standard version 0.1.0

  ✓ PASS — workspace is Metaproject Standard compliant
```

Do not treat setup as complete until these pass, or until every failure is
written down with a reason.

## 4. Connect your coding agent

There are three independent pieces. Use the ones your agent supports; the
[agent installation playbook](../agent-installation-playbook.md#runtime-compatibility-matrix)
has the full matrix.

**Global discovery.** A short block in the agent's user-level instruction file
tells it to look for `.metaproject/index.md` in any project. This writes outside
the repository, so preview it first:

```bash
keryx agents bootstrap install --runtime codex --dry-run
keryx agents bootstrap install --runtime codex
keryx agents bootstrap status --runtime all
```

**Hooks in the agent.** `keryx integrations install` adds, per agent, the
orientation hook (a short project summary at the start of each turn), the
compact-output guard (redirects broad raw searches and reads to `keryx ctx`)
and the security checks on the agent's input and output. Preview, install, then
check:

```bash
keryx integrations install --runtime codex --dry-run
keryx integrations install --runtime codex
keryx integrations doctor --runtime codex
```

```text
keryx integrations install (dry run)
  codex
  · ctx-guard (block) -> .codex/hooks.json would-install
  · orient (inject-context) -> .codex/hooks.json would-install
```

`--runtime` takes one id, a comma-separated list, or `all`. `--surface` limits
the install to one kind of hook. `keryx integrations matrix` lists every agent
and what it supports.

The older per-hook commands (`keryx orient install-hook`,
`keryx ctx install-hook`, `keryx security hooks install`) still work and
install the same hooks.

## 5. Optional: publish the workspace over MCP

An editor or agent that speaks MCP can query the workspace through
`keryx serve-mcp`. `keryx integrate` writes the server entry into the client's
project configuration and turns the `mcp` module on:

```bash
keryx integrate all --dry-run
keryx integrate claude
```

Targets are `cursor`, `claude`, `opencode`, `vscode` and `generic` (prints a
snippet to paste anywhere); `all` writes the first three. `--remove` takes the
managed entry out again. The server runs over stdio by default; `--http` serves
on localhost only, and `--read-only` hides every tool that writes. It needs the
optional `@modelcontextprotocol/sdk` package. See
[Connect your agents](../modules/integrations.md).

## 6. Optional: add the symbol layer

The file graph always works. Symbols and call edges need tree-sitter grammars,
which you download explicitly:

```bash
keryx gdgraph symbols enable
keryx gdgraph assets list
keryx gdgraph assets pull tree-sitter-typescript
keryx gdgraph build
keryx gdgraph symbols status
```

Each grammar is verified against a pinned checksum before it is used. If a
grammar is missing, the graph falls back to files and says how to finish.

## 7. Optional: add coverage-based test selection

```bash
keryx test coverage-map build
keryx test coverage-map status
keryx test run --changed --strict
```

With a coverage map, `--changed` runs the tests that cover the changed files.
Without one, it falls back to a heuristic selection.

## Verify the setup

- `keryx doctor` shows no failures, and every warning is understood.
- `keryx status` lists the modules you expect.
- `keryx standard validate`, `keryx security policy validate` and
  `keryx flow check` pass.
- `keryx wiki check-links` and `keryx wiki validate` pass.
- `keryx integrations doctor --runtime <your agent>` reports no drift.
- The workspace is committed.

## Keep it current

**After pulling changes:**

```bash
keryx update --skip-runtime
keryx sync --apply
keryx test analyze
keryx dashboard build
keryx standard validate
```

`keryx sync` reports which of the graph, wiki and memory are behind the code,
and `--apply` rebuilds only those. `keryx sync install-hooks` runs the report
automatically after `git pull` and branch switches.

**Before committing:**

```bash
keryx ctx diff --stat
keryx test run --changed --strict
keryx health run --changed --strict
keryx wiki check-links
keryx security report
```

**Before a release:**

```bash
keryx test run --strict
keryx health run --strict
keryx standard validate
keryx wiki validate
keryx memory check
keryx flow check
keryx security policy validate
keryx security eval --corpus all
```

## Use in scripts and CI

Keryx is safe to run without a terminal:

- `keryx init --yes` accepts every default. When stdin is not a terminal, any
  other prompt falls back to its default, so a pipeline never hangs.
- Colour is off when output is not a terminal. `NO_COLOR` turns it off and
  `FORCE_COLOR` turns it on explicitly.

[Run keryx in CI](run-in-ci.md) covers the gates to run in a pipeline.

## Troubleshooting

See [Troubleshooting](../getting-started/troubleshooting.md). The most common
setup problems are a missing ripgrep, a stale graph after files moved, and a
health gate that is incomplete because a tool is not installed.

## Next steps

- [Copy-ready agent prompts](agent-prompts.md): ask your agent to do this setup, or to work through the workspace.
- [Agent installation playbook](../agent-installation-playbook.md): the same setup as a specification an agent can execute unattended.
- [Managed work](../modules/managed-work.md): flows with frozen acceptance criteria.

# CLI Reference

Complete reference for the `keryx` command-line interface. `keryx`
manages a per-project `.metaproject/` workspace: it scaffolds the workspace,
keeps managed "service" files in sync (never touching your `data/` artifacts),
and exposes feature commands for the dependency graph, wiki, skills, code health,
testing, memory, an agent-first work-flow lifecycle, and agent-security scanning.

## Global usage

```
keryx <command> [args] [flags]
```

| Global flag | Alias | Effect |
|---|---|---|
| `--help` | `-h` | Print the top-level usage block. Also works (per subcommand) as `keryx <command> --help`. |
| `--version` | `-v` | Print the installed version and exit. |

Running `keryx` with no command, or with `--help`/`-h`, prints the usage
block. An unknown command prints an error plus the usage block and exits with
code `1`.

### Top-level commands

| Command | Purpose |
|---|---|
| `init` | Initialize `.metaproject/` in the current project. |
| `status` | Show local Metaproject status. |
| `update` | Refresh managed service files without touching data artifacts. |
| `dashboard` / `dash` | Build or open the project admin dashboard. |
| `gdgraph` | Build and query the code dependency graph. |
| `ctx` | Run compact, token-aware context commands and save raw output. |
| `wiki` | Manage the local project knowledge base. |
| `skills` | Manage bundled and project working skills. |
| `skill-verify-skill` | Alias for `skills verify`. |
| `health` | Aggregate code-quality signals and run the quality gate. |
| `test` | Analyze testing context and normalize test reports. |
| `memory` | Store and search long-term project memory. |
| `flow` | Agent-first work lifecycle (Task Manager). |
| `rules` | Sync/distill root AGENTS.md/CLAUDE.md into project rules. |
| `standard` | Validate the workspace against the Metaproject Standard and report capabilities. |
| `security` | Policy-based scanning, redaction, guardrails, and audit reports for agent input/output and artifacts. |
| `mcp` | Expose read-only Metaproject services over the Model Context Protocol (opt-in, off by default). |

### Optional dependencies and graceful degradation

Several commands ship as opt-in capabilities that lean on an optional dependency
(e.g. a tree-sitter grammar, an embedding/model backend) or a pulled asset. When
that dependency or asset is absent, the command **degrades gracefully**: it warns
once, falls back to the deterministic built-in path, and still exits `0` (for
example `memory index --embeddings` builds the lexical index only, and
`security eval --with-model` silently uses the pure detector path). The single
sanctioned exception is **`mcp serve`**, which hard-fails with an actionable
message when the optional MCP SDK is not installed.

---

## init

Initialize the `.metaproject/` workspace in the current directory: scaffold
directories, enable the optional modules, optionally install git hooks, and write
the `metaproject.json` manifest. Re-running `init` over an existing workspace
updates managed files but never clobbers seeded user files or `data/`.

```
keryx init [--yes] [module flags] [hook flags] [capability flags]
```

| Flag | Description |
|---|---|
| `--yes`, `-y` | Non-interactive: accept every module default (enabled) instead of prompting. |
| `--help`, `-h` | Print `init` usage and exit. |
| `--gdskills-profile <profile>` | Set the gdskills install profile (`minimal`, `recommended`, `full`, `custom`); defaults to `recommended`. |

**Module flags** — each of the 9 modules is enabled by default; pass its
`--no-<module>` flag to disable it:

| Flag | Disables module |
|---|---|
| `--no-gdgraph` | Dependency graph. |
| `--no-gdctx` | Compact context commands. |
| `--no-gdwiki` | Project knowledge base. |
| `--no-gdskills` | Working-skills subsystem. |
| `--no-health` | Code-health quality gate. |
| `--no-testing` | Testing context / reports. |
| `--no-memory` | Long-term project memory. |
| `--no-tasks` | Flow / Task Manager lifecycle. |
| `--no-security` | Metaproject Security (input/output + artifact scanning). |

**Hook flags** — git hooks are installed only for enabled modules. Under `--yes`
most default on; the testing **pre-push** hook stays off even under `--yes` (opt-in).
Pass the matching `--no-*-hook` flag to force a hook off:

| Flag | Skips hook |
|---|---|
| `--no-gdgraph-hook` | gdgraph post-commit hook. |
| `--no-gdskills-hook` | gdskills post-commit hook. |
| `--no-health-hook` | health post-commit hook. |
| `--no-testing-post-commit-hook` | testing post-commit (refresh) hook. |
| `--no-testing-pre-push-hook` | testing pre-push (gate) hook. |
| `--no-security-hook` | security **pre-push** gate hook. |
| `--no-security-agent-hook` | security **`.claude/settings.json`** agent hook. |

**Capability flags** — opt-in ceilings that are **off by default**. Each has a
matching `--no-<capability>` form (the default) that keeps the generated
`metaproject.json` byte-identical to a plain `init`; only passing the positive
flag touches the manifest:

| Flag | Enables capability |
|---|---|
| `--mcp` / `--no-mcp` | The opt-in MCP server module (`mcp serve`). Interactively, `init` also offers this as a question (default No); `--mcp`/`--no-mcp` set it non-interactively. Wire a client config afterwards with `mcp install`. |
| `--treesitter` / `--no-treesitter` | The gdgraph tree-sitter symbol layer (optional `web-tree-sitter` dependency). |
| `--testing-tia` / `--no-testing-tia` | The testing coverage-map test-impact analysis (drives map-first `test run --changed`). |

The two security hooks are offered only when the `security` module is enabled and
default on (confirm prompt; accepted under `--yes`). The **pre-push** hook adds a
managed block to `.git/hooks/pre-push` that scans changed files with
`keryx security scan` before a push — it warns in `advisory` (the default)
and blocks the push only in `enforced`/`ci` mode; it coexists with the testing
pre-push hook and any user content. The **agent** hook merges (merge-safe, never
clobbering existing settings) two Claude Code hooks into `.claude/settings.json`:
`UserPromptSubmit` → `security check-input` and `PreToolUse(Write|Edit)` →
`security check-output`, advisory by default.

---

## status

Print the local Metaproject status. Takes no arguments. Read-only — never writes.

```
keryx status
```

Reports one of: `not initialized` (no `.metaproject/`), `incomplete` (missing or
invalid `metaproject.json`), or `ready` — in which case it prints the workspace
root and each module as `enabled` or `disabled`.

---

## modules

View and toggle Metaproject modules. Enabling or disabling a module re-runs
`init` with the appropriate `--no-<module>` flags to add or remove its scaffold.

```
keryx modules [status | enable <name> | disable <name>]
```

| Subcommand | Description |
|---|---|
| `status` (alias `list`) | Print each module and whether it is enabled. Also the default in a non-interactive (non-TTY) context. |
| `enable <name>` (alias `on`) | Enable a module by its `metaproject.json` key and re-scaffold it. |
| `disable <name>` (alias `off`) | Disable a module and drop it from the workspace. |
| _(no argument)_ / `interactive` / `-i` | Interactively toggle modules on/off, then apply via `init`. |

Module names are the manifest keys: `gdgraph`, `gdctx`, `gdwiki`, `gdskills`,
`health`, `testing`, `memory`, `tasks`, `security`.

---

## update

Refresh managed "service" files (templates, manifests, skills, hooks, dashboard)
to match the current runtime, without ever writing under `.metaproject/data/`.
Also self-updates the runtime it was launched from and backfills newly added
modules. Errors with exit code `1` if `.metaproject/` does not exist.

```
keryx update [--skip-runtime] [--hooks] [--no-tasks]
```

| Flag | Description |
|---|---|
| `--skip-runtime` | Skip the git fetch/checkout that self-updates the vendored runtime. |
| `--hooks` | After refreshing, run every executable in `.metaproject/hooks/post-update.d`. Without it, a hint is printed instead. |
| `--no-tasks` | Do not auto-enable (backfill) the tasks/flow module on pre-tasks workspaces. |
| `--help`, `-h` | Print `update` usage and exit. |

---

## dashboard (and `dash`)

Build or open the self-contained project admin dashboard, a single HTML file at
`.metaproject/keryx-dashboard.html` embedding health, graph, testing, wiki,
and memory snapshots.

```
keryx dashboard build      # rebuild the HTML, print its path
keryx dashboard open       # rebuild, then open in the default browser
keryx dash [build|open]    # bare `dash` defaults to `open`
```

| Subcommand | Description |
|---|---|
| `build` | Rebuild `keryx-dashboard.html` and print its relative path. |
| `open` | Rebuild then open the file (platform-aware: `open` / `start` / `xdg-open`). |

`dash` is a shortcut for `dashboard`; with no subcommand it defaults to `open`.
Requires an initialized workspace; an unknown subcommand exits `1`.

---

## gdgraph

Build a lightweight intra-project import/dependency graph (regex-based) and query
it. Delegates the legacy `build`/`query`/flag-less `affected` subcommands to a
project-local `.metaproject/core/gdgraph/cli.ts` if present (unless
`KERYX_GDGRAPH_LOCAL=1`); the newer `repomap`/`assets` surfaces and the
`affected` flags run in the package runner.

```
keryx gdgraph build
keryx gdgraph query <cycles|orphans>
keryx gdgraph affected <file> [--depth N] [--ranked] [--json]
keryx gdgraph repomap [--budget N] [--seed <path>...] [--changed]
keryx gdgraph assets list | verify [<id>] | pull <id>
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `build` | — | Scan the tree, build the graph, write JSONL storage + `summary.md`/`module-map.json`, print node/edge counts. |
| `query cycles` | — | Print dependency cycles (`a -> b -> a`), or "No cycles found." |
| `query orphans` | — | Print modules with no resolved inbound or outbound edges. |
| `affected <file>` | `--depth <N>`, `--ranked`, `--json` | Print `## Dependencies` and `## Dependents` for the target file. Default (or `--depth 1`) output is byte-for-byte unchanged; a higher `--depth` walks the transitive closure. `--ranked` appends a `## Blast Radius (ranked)` section (by hop + fan-in); `--json` emits the full result object. |
| `repomap` | `--budget <N>`, `--seed <path>...`, `--changed` | Write a token-budgeted repo map artifact. `--budget` caps the token estimate, `--seed` biases toward one or more paths (repeatable), and `--changed` seeds from locally changed files (`git diff --name-only HEAD`). |
| `assets list \| verify [<id>] \| pull <id>` | — | Manage declared assets from `assets.lock.json`: `list` shows resolved/missing state, `verify` checks checksums (exit `1` on mismatch), `pull` fetches and verifies one asset (the only networked verb). |

Only the exact queries `cycles` and `orphans` are accepted; anything else exits
`1`. `affected` with no file argument prints usage and exits `1`.

---

## ctx

Token-aware wrapper that runs common developer commands and reads files, printing
a compact Markdown summary while persisting the full raw output under
`.metaproject/data/gdctx/`.

```
keryx ctx status
keryx ctx diff [git-diff-args...]
keryx ctx rg "<pattern>" [path]
keryx ctx read <file> [--mode outline|compact|full]
keryx ctx run -- <command...>
keryx ctx show [latest|<name>] [--raw]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `status` | — | Report metaproject/manifest/config/data presence and whether gdctx is enabled. |
| `diff` | git-diff args (e.g. `--staged`, `--stat`) | Run `git diff <args>` and summarize (files, risk hints, hunks, errors). |
| `rg` | `"<pattern>" [path]` | Run ripgrep and summarize top files + example matches. Requires ≥1 arg. |
| `read` | `<file>`, `--mode outline\|compact\|full` | Read and summarize a file. Default mode `compact`. |
| `run` | `-- <command...>` | Run an arbitrary command after `--` and summarize its output. Errors if empty. |
| `show` | `[latest\|<name>]`, `--raw` | Print a saved artifact summary (`.md`), or the raw `.log` with `--raw`. |

---

## wiki

Manage the local, Markdown-on-disk project knowledge base under
`.metaproject/wiki/` (architecture, domain models, business rules, decisions, and
more), including auto-collected drafts from other modules' data.

```
keryx wiki status
keryx wiki new <type> <slug> --title "<title>" [--force]
keryx wiki collect [--force] [--limit <n>] [--changed]
keryx wiki index
keryx wiki check-links
keryx wiki validate
keryx wiki ask "<question>" [--k <n>] [--rerank]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `status` | — | Show enabled state, root, total pages, per-type counts, last index/link-check state. |
| `new` | `<type> <slug>`, `--title "<t>"`, `--force` | Scaffold a page from template. Refuses to overwrite unless `--force`. |
| `collect` | `--force`, `--limit <n>`, `--changed` | Auto-generate draft pages from gdgraph/health/testing data, then rebuild the index. `--limit` defaults to 12; `--changed` restricts collection to recently changed inputs for incremental, hook-friendly runs. |
| `index` | — | Rebuild the managed page-index block in `wiki/index.md`. |
| `check-links` | — | Validate internal Markdown links; write a report. Exits `1` if any broken. |
| `validate` | — | Metadata + link + index-staleness checks (superset of `check-links`). Exits `1` on issues. |
| `ask "<question>"` | `--k <n>`, `--rerank` | Answer a question from the local wiki with a deterministic, citation-backed retrieval pass over the pages. `--k` caps the number of retrieved passages; `--rerank` applies the extra reranking step. |

Page types: `architecture`, `domain-model`, `business-rule`, `user-scenario`,
`component`, `service`, `integration`, `decision`.

When the `security` module is enabled, `collect` runs an advisory security check
before writing each draft. Advisory (the default) reports and writes anyway;
`enforced`/`ci` mode can suppress a draft's write with a masked reason.

---

## skills

Manage the working-skills subsystem: a bundled catalog of skills and per-project
skill packages, plus routing, verification, learning, export, and JSON contracts.

```
keryx skills status
keryx skills list
keryx skills inspect <project-skill>
keryx skills route <query-or-target>
keryx skills catalog [--profile recommended]
keryx skills install [--profile recommended]
keryx skills create <target> --module <module> --name <skill-name>
keryx skills verify <skill-or-target>
keryx skills learn --from-review <path> --skill <module>/<skill>
keryx skills learn apply <proposal.json>
keryx skills export <project-skill> --runtime codex|claude|plugin
keryx skills sync --runtime codex|claude --target <dir>
keryx skills contracts validate <file> --schema <name>
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `status` | `--json` | Print the local gdskills install status summary. |
| `list` | `--json` | List registered project skills as a table. |
| `inspect <project-skill>` | `--json` | Inspect one project skill: metadata + file presence. Missing target exits `1`. |
| `route <query-or-target>` | `--json` | Score/rank registry entries against a free-text query or path. |
| `catalog` | `--profile minimal\|recommended\|full\|custom` | Print the bundled catalog for a profile. |
| `install` | `--profile <profile>` | Install bundled skills, catalog, manifest, and contracts. Requires `.metaproject/`. |
| `create <target>` | `--module <m>`, `--name <n>`, `--format auto\|single\|package`, `--dry-run` | Create and register a project-skill package. (`generate` is an alias.) |
| `verify <skill-or-target>` | `--dry-run`, `--json` | Verify a project skill against evidence; write a report. `--all` verifies every registered skill. |
| `learn --from-<source> <path> --skill <m>/<s>` | `--from-review\|--from-test\|--from-failure\|--from-health\|--from-memory <path>`, `--skill`, `--dry-run`, `--json` | Create an auditable learning proposal (does not mutate SKILL.md). |
| `learn apply <proposal.json>` | `--dry-run`, `--json` | Apply a reviewed proposal to SKILL.md + changelog; bump patch version. |
| `export <project-skill>` | `--runtime codex\|claude\|plugin`, `--dry-run`, `--json` | Export a project skill to a runtime artifact. The `plugin` runtime (alongside `codex` and `claude`) emits a Claude Code plugin package. |
| `sync` | `--runtime codex\|claude`, `--target <dir>`, `--dry-run`, `--json` | Sync exported runtime skills to an explicit target dir. Requires both `--runtime` and `--target`. |
| `contracts list` | — | Print name/path/description for all contract schemas. |
| `contracts validate <file>` | `--schema <name>` | Validate a JSON file against a named contract schema. Exits `1` on failure. |

Profiles: `minimal`, `recommended` (default), `full`, `custom`. Contract schemas:
`subagent-result`, `subagent-dispatch`, `agent-event`, `orchestrator-state`,
`review-finding`.

---

## skill-verify-skill

Top-level alias for `skills verify` — verify a project skill against current repo
evidence and write a verification report.

```
keryx skill-verify-skill <skill-or-target>
```

Accepts the same flags as `skills verify` (`--dry-run`, `--json`, `--all`).

---

## health

Aggregate code-quality signals from multiple tools (ESLint, TypeScript, tests,
dependency audit, SonarQube, plus built-in complexity/coverage/churn) into
per-scope health scores, compare against a baseline, and evaluate a pass/warn/fail
quality gate.

```
keryx health run [--strict] [--scope <sel>] [--changed [--since <ref>]] [--source <list>]
keryx health status
keryx health gate [--strict-warn]
keryx health sources
keryx health explain <file-or-module>
keryx health baseline update [--scope <sel>]
keryx health trend [--scope <key>] [--limit <n>]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `run` | `--strict`, `--scope project\|module:<name>\|file:<path>`, `--changed`, `--since <ref>`, `--source eslint,typescript,...` | Run the full pipeline, write `latest.json`/`latest.md` + history, print gate + score. Exit `1` if gate = fail. |
| `status` | — | Read the last report: enabled, last run, gate, project score, regressed scopes, per-source status, trend. |
| `gate` | `--strict-warn` | Re-read the last report's gate (no re-run). Exit `1` on fail, or on warn with `--strict-warn`. |
| `sources` | — | Detect and list each source's mode/required/status without running the tools. |
| `explain <file-or-module>` | — | Print a scope's metrics + its first 20 findings from the last report. |
| `baseline update` | `--scope <sel>` | Write current scores into the baseline (all scopes, or those matching the selector). Runs health first if no report exists. |
| `trend` | `--scope <scope-key>`, `--limit <n>` | Print a scope's health-score trend over history. Defaults: scope `project`, limit `20`. |

---

## test

Discover the project's test context and run its existing test runner, normalizing
output into JSON + Markdown reports under `.metaproject/data/testing/`.

```
keryx test init
keryx test analyze
keryx test run [--changed] [--since <ref>] [--strict] [--scope <path>] [--kind <k>]
keryx test status
keryx test context
keryx test report latest [--json]
keryx test related <file>
keryx test explain <file-or-scope>
keryx test coverage-map build|status
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `init` | — | Alias of `analyze` (same code path). |
| `analyze` | — | Scan the tree, detect the test stack, write `context.{json,md}` + `recommendations.md`. |
| `run` | `--changed`, `--since <ref>`, `--strict` (alias `--gate`), `--scope <path>`, `--kind unit\|integration\|e2e\|smoke` | Select tests, run the runner, parse output, write the report. Exit `1` on fail/error. |
| `status` | — | One-line summary: enabled, frameworks, test-file count, last run + status. |
| `context` | — | Print saved context + recommendations (hints to run `analyze` if absent). |
| `report latest` | `--json` | Print the latest normalized report (Markdown, or raw JSON with `--json`). |
| `related <file>` | — | List tests related to a source file by naming/directory heuristics. |
| `explain <file-or-scope>` | — | Frameworks + related tests + latest failures filtered by the target. |
| `coverage-map build` | — | Build the test-impact coverage map (source → covering tests) and write the artifact. Prints the source strategy and entry count. |
| `coverage-map status` (default) | — | Report the coverage-map capability + config state, whether a map is present, its `gitRef`, and whether it is stale (a stale map falls back to static selection). Bare `coverage-map` defaults to `status`. |

`--changed` selects tests for changed files (via `git`); with `--strict` and no
matched tests, the run fails — this drives the pre-push gate.

When the opt-in testing coverage-map TIA capability is enabled (see
`init --testing-tia`) and a fresh map exists, `run --changed` prefers the
coverage map to pick precisely the tests that cover the changed sources; it falls
back to the static naming/directory heuristics when the map is missing or stale.
The `smoke` tier (`--kind smoke`) selects the fast smoke subset.

When the `security` module is enabled, `run` runs an advisory security check on the
captured raw log before persisting it. Advisory (the default) reports and still
writes the log; `enforced`/`ci` mode can suppress raw-log persistence with a masked
reason (the run itself is never broken).

---

## memory

Long-term, typed project memory: durable Markdown entries (lessons, decisions,
constraints, known mistakes, patterns, …) under `.metaproject/memory/`, with
deterministic (non-LLM) search, dedup, and consolidation.

```
keryx memory new <type> [slug] --title "<title>" [--force]
keryx memory index [--embeddings]
keryx memory search "<query>" [--module <m>] [--entity <e>] [--status <s>] [--limit <n>] [--as-of <YYYY-MM-DD>] [--class <semantic|episodic|procedural>] [--semantic]
keryx memory supersede <old-path> --by <new-path> [--date <YYYY-MM-DD>]
keryx memory assets list | verify [<id>] | pull <id>
keryx memory ingest --from-<source> <path>
keryx memory check
keryx memory reflect
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `new <type> [slug]` | `--title "<t>"`, `--force` | Scaffold a new draft entry; print possible duplicates. |
| `index` | `--embeddings` | Build `data/memory/index/index.json` from all entries. `--embeddings` additionally builds a vector index when the embedding capability is available; if it is absent, it warns and keeps the lexical index only. |
| `search "<query>"` | `--module <m>`, `--entity <e>`, `--status <s>` (e.g. `accepted`), `--limit <n>`, `--as-of <YYYY-MM-DD>`, `--class <semantic\|episodic\|procedural>`, `--semantic` | Ranked retrieval; write `latest.md`/`latest.json`, print the ranked list. `--as-of` restricts to entries as of a date, `--class` filters by memory class, and `--semantic` prefers semantic (vector) ranking when available. |
| `supersede <old-path>` | `--by <new-path>` (required), `--date <YYYY-MM-DD>` | Mark one entry as superseded by another. Non-destructive and git-diffable — both entries stay on disk. A blocking security gate can abort the write. |
| `assets list \| verify [<id>] \| pull <id>` | — | Manage declared assets from `assets.lock.json` (`list`/`verify`/`pull`; `pull` is the only networked verb). |
| `ingest` | `--from-review\|--from-health\|--from-job\|--from-skill-verifier <path>` | Extract candidate insights from a source artifact into ADD/UPDATE entries. |
| `check` | — | Integrity/lint pass (metadata, links, dedup, conflicts, index). Exit `1` on issues. |
| `reflect` | — | Cluster entries by tag and create `pattern` drafts for clusters ≥ min size. |

Entry types: `lesson`, `decision`, `constraint`, `known-mistake`,
`historical-context`, `pattern`, `task-note`, `review-note`, `incident`,
`migration-note`, `integration-note`.

When the `security` module is enabled, `ingest` runs an advisory security check
before writing each accepted entry. Advisory (the default) reports and writes;
`enforced`/`ci` mode can skip an entry's write with a masked reason.

---

## flow

Agent-first work lifecycle ("Task Manager"; manifest module id `tasks`). Each unit
of work is a self-contained package under `.metaproject/flows/`, driven through a
strict status state machine with hard completion gates. The CLI is the sole writer
of flow state.

```
keryx flow init (--issue <url> | --title "<t>") [--slug <s>]
keryx flow list
keryx flow status <id>
keryx flow freeze <id>
keryx flow start <id>
keryx flow task add <id> --title "<t>" [--kind <k>]
keryx flow task done <id> <taskId>
keryx flow ac confirm <id> <ACn> [--note "<evidence>"]
keryx flow ac update <id> --reason "<why>"
keryx flow implemented <id> --pr <url>
keryx flow complete <id> [--comment]
keryx flow block <id> --reason "<why>"
keryx flow unblock <id>
keryx flow check
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `init` | `--issue <url>` \| `--title "<t>"`, `--slug <s>` | Scaffold a flow package. Requires a title or issue URL. |
| `list` | — | List all flows with status + task counts. |
| `status <id>` | — | Print one flow: status, source, AC state, PR, tasks, recent history. |
| `freeze <id>` | — | Record the AC checksum; transition `initializing → ready`. |
| `start <id>` | — | Transition `ready → in-progress`. |
| `task add <id>` | `--title "<t>"` (required), `--kind context\|implement\|test\|review\|docs` | Append a task. |
| `task done <id> <taskId>` | — | Mark a task `done`. |
| `ac confirm <id> <ACn>` | `--note "<evidence>"` | Confirm one acceptance criterion. |
| `ac update <id>` | `--reason "<why>"` (required) | Re-freeze the AC checksum; void prior confirmations. |
| `implemented <id>` | `--pr <url>` (required) | Transition `in-progress → implemented`; record the draft PR. |
| `complete <id>` | `--comment` | Run completion gates; on pass `→ done` (optionally comment the issue), on fail `→ in-progress`. |
| `block <id>` | `--reason "<why>"` (required) | Transition any status `→ blocked`, saving the previous status. |
| `unblock <id>` | — | Restore the saved previous status. |
| `check` | — | Consistency audit across all flows. |

Statuses: `initializing`, `ready`, `in-progress`, `implemented`, `completing`,
`done`, `blocked`. `task` and `ac` are command groups — the atomic verbs are
`task add`, `task done`, `ac confirm`, `ac update`.

When the `security` module is enabled, `complete` adds a `security` completion
gate. Advisory (the default) makes it informational (`pass`, never blocks);
`enforced`/`ci` mode can fail the gate and hold the flow in `in-progress`. The gate
is omitted entirely when the module is disabled.

---

## rules

Keep the root agent entrypoints (`AGENTS.md`, `CLAUDE.md`) in sync with the
`.metaproject/` workspace by importing them as high-priority project rules and
injecting a managed routing block. Requires an initialized workspace.

```
keryx rules sync
keryx rules distill
```

| Subcommand | Description |
|---|---|
| `sync` | Import each root entrypoint into `.metaproject/rules/<slug>.md`, inject/upgrade the managed Metaproject routing block, and refresh the index. |
| `distill` | Superset of `sync`: additionally split large entrypoints into typed artifacts (project rules, project skills, root-only sections) and rewrite the trimmed root file. |

Only `sync` and `distill` are accepted; the only recognized flag is `--help`/`-h`.
An unknown subcommand prints an error and exits `1`.

---

## standard

Validate the workspace against the [Metaproject Standard](../requirements/metaproject-standard/specification.md)
v0.1 and report its declared capabilities. The checks and schemas are bundled
into the CLI (`src/standard/`), so no network or `docs/` access is needed at
runtime.

```
keryx standard validate
keryx standard doctor
keryx standard capabilities
keryx standard emit llms [--stdout]
```

| Subcommand | Description |
|---|---|
| `validate` | Check required files/dirs, the `metaproject.json` schema (`metaproject.schema.json` + per-module `module.schema.json`), declared `paths.*`, enabled-module manifests, and that root `AGENTS.md`/`CLAUDE.md` link `.metaproject/index.md`. Prints a `PASS`/`FAIL` report and exits `1` on failure. |
| `doctor` | Same findings as `validate`, rendered as actionable diagnostics with a concrete fix hint per issue. Exits `1` when unresolved issues remain. |
| `capabilities` | Print the standard version, declared and satisfied profiles, and each enabled module with its commands/capabilities, sourced from `metaproject.json`. Exits `0`. |
| `emit llms` | Generate a deterministic `llms.txt` from the manifest + artifact index. Writes the file by default (validating the result), or streams it to stdout with `--stdout`. Exits `1` if the generated file is not valid `llms.txt`. |

`validate` and `doctor` also emit profile warnings when the manifest's declared
`profiles` array drifts from the profiles the workspace actually satisfies
(`minimal`, `agent`, `ci`, `full`). `keryx init` and `keryx update`
keep `standardVersion`, `profiles`, and `updatedAt` current in the manifest, so a
freshly generated workspace validates cleanly.

The only recognized flag is `--help`/`-h`. An unknown subcommand prints an error
and exits `1`.

---

## agents

Manage optional global bootstrap instructions for coding agents. This command is
not project initialization: it only writes a small managed block into the selected
global `AGENTS.md` / `CLAUDE.md` file. The block tells agents to look for
`.metaproject/index.md` in the current directory or ancestors and route through
Metaproject when present. It also contains an explicit guard: when no metaproject
is installed, ignore the block and continue normally.

```
keryx agents bootstrap status --runtime <claude|opencode|zcode|codex|antigravity|all>
keryx agents bootstrap install --runtime <claude|opencode|zcode|codex|antigravity|all> [--dry-run]
keryx agents bootstrap uninstall --runtime <claude|opencode|zcode|codex|antigravity|all> [--dry-run]
keryx agents bootstrap print
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `bootstrap status` | `--runtime <id\|all>` | Show whether each runtime's global instruction file has the current managed Metaproject bootstrap block and print the install command when missing/outdated. |
| `bootstrap install` | `--runtime <id\|all>`, `--dry-run` | Merge-safe install/update. Inserts the managed block near the top of the global instruction file, after frontmatter and the H1 when present, preserving user content. |
| `bootstrap uninstall` | `--runtime <id\|all>`, `--dry-run` | Remove only the managed Metaproject bootstrap block, preserving all user-authored content. |
| `bootstrap print` | — | Print the managed block for manual installation. |

Runtime ids: `claude` (`~/.claude/CLAUDE.md`), `opencode`
(`~/.config/opencode/AGENTS.md`), `zcode` (`~/.zcode/AGENTS.md`), `codex`
(`~/.codex/AGENTS.md`), `antigravity`
(`~/.config/antigravity/AGENTS.md`; alias `antigravuty`), or `all`.

---

## security

Policy-based scanning, redaction, guardrails, and audit reports for agent
input/output and `.metaproject/` artifacts. The engine is deterministic (rule +
entropy detectors, no model backend) and local-first: config lives at
`.metaproject/security.config.json`, data under `.metaproject/data/security/`,
and the local-only HMAC key under `data/security/raw/` (gitignored). This is
Phase 1+2+3 of the spec — the engine, the CLI below, and the write-seam
integrations (an advisory-by-default guard at `memory ingest`, `wiki collect`,
`test run`, `gdctx`, and `flow complete`) are shipped. Model/API backends and
gateway mode (Phase 4) are not implemented.

```
keryx security status
keryx security scan <path> [--json] [--source <kind>]
keryx security scan-mcp <manifest.json|dir> [--json] [--pin <manifest>] [--strict]
keryx security check-input [--source <kind>] [--file <path>] [--json]
keryx security check-output [--target <kind>] [--file <path>] [--json]
keryx security redact <path> [--out <path>]
keryx security report [--since <ref>] [--json]
keryx security policy validate
keryx security incidents [--limit <n>]
keryx security hooks install|uninstall --runtime <claude|cursor|windsurf|generic-mcp|all>
keryx security eval [--corpus <name|all>] [--with-model] [--json]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `status` | — | Print the effective config: mode, raw-retention, gate (`failOn` + `minConfidence`), config-checksum state, and each policy with its action. |
| `scan <path>` | `<path>`, `--json`, `--source <kind>` | Scan a file, resolve findings into a decision, and write committable artifacts (`data/security/artifacts/latest.{md,json}`). Prints the gate, action, and findings (or raw JSON with `--json`). |
| `scan-mcp <manifest\|dir>` | `--json`, `--pin <manifest>`, `--strict` | Scan one MCP tool manifest (or every `*.json` under a directory, recursively) for MCP threats. Findings are leak-safe (category + policy id only). `--pin` records a rug-pull baseline instead of scanning; `--strict` exits `1` when any threat is found. Pure and network-free. |
| `check-input` | `--source <kind>`, `--file <path>`, `--json` | Evaluate incoming content (defaults source `untrusted-external`). Reads from `--file` or stdin. Prints the decision. |
| `check-output` | `--target <kind>`, `--file <path>`, `--json` | Evaluate outgoing/generated content (defaults source `generated`, target `unknown`). Reads from `--file` or stdin. Prints the decision and, when applicable, the redacted preview. |
| `redact <path>` | `<path>`, `--out <path>` | Apply fixed-width masks to detected sensitive spans. Writes to `--out`, else prints the redacted content to stdout. Reads from the path or stdin. |
| `report` | `--since <ref>`, `--json` | Aggregate the latest scan artifact (never re-scans) into a summary: gate, mode, and finding counts by category. |
| `policy validate` | — | Validate the config against its schema and verify the config checksum. Exit `1` on schema errors or a checksum mismatch. |
| `incidents` | `--limit <n>` | List the append-only incident trail (mode downgrades, disabled policies, checksum mismatches). Newest first; `--limit` caps the count. |
| `hooks install\|uninstall` | `--runtime <id>` | Merge-safe install/uninstall of the agent security hooks for one or more runtimes. `--runtime` takes a runtime id, a comma-separated list, or `all` (defaults to `claude`); after install the rendered settings are validated. |
| `eval` | `--corpus <name\|all>`, `--with-model`, `--json` | Run the labeled security corpora through the detectors and print a deterministic per-detector false-negative-rate report, exiting `1` when a detector breaches its committed threshold. `--corpus` defaults to `all` (or a comma list of corpus names); `--with-model` also exercises the opt-in model backends, warning once and falling back to the pure path when the model asset is absent. |

Runtime ids (`--runtime`): `claude`, `cursor`, `windsurf`, `generic-mcp`, or
`all`. Eval corpora (`--corpus`): `injection`, `exfil`, `structured-pii`,
`secret`, or `all`.

Source kinds (`--source`): `trusted-project`, `trusted-user`,
`untrusted-external`, `tool-output`, `generated`. Target kinds (`--target`):
`model`, `memory`, `wiki`, `report`, `external`, `task`, `unknown`.

**Exit behavior.** `scan`, `check-input`, and `check-output` honor the config
`mode`: in **advisory** mode (the default) they always exit `0` after reporting;
in **ci** mode they exit `1` on a gate **fail**; in **enforced** mode they exit
`1` on a gate **fail** or **needs-approval**. `report` exits `1` only under `ci`
mode when the aggregated gate is `fail`. `policy validate` exits `1` on schema or
checksum failure. `scan-mcp` exits `1` only with `--strict` when a threat is
found; `eval` exits `1` when any detector breaches its threshold; `hooks` exits
`1` on an unknown runtime or a post-install validation error. `status`, `redact`,
and `incidents` do not gate. An unknown subcommand prints an error and exits `1`.

---

## mcp

Expose read-only Metaproject services (code graph, security, flow status, memory,
health, wiki, standard) over the [Model Context Protocol](https://modelcontextprotocol.io).
A thin protocol adapter — it defines no new module logic and routes every tool
result through the security redaction seam before transport. Opt-in: the module is
off by default; enable it with `keryx init --mcp`.

```
keryx mcp serve [--cwd <project-root>]          # stdio JSON-RPC MCP server (default transport)
keryx mcp serve --http [--cwd <project-root>]   # isolated HTTP/SSE opt-in (localhost only)
keryx mcp                  # alias for `mcp serve`
keryx mcp install --runtime <cursor|claude|generic|all> [--dry-run]
keryx mcp uninstall --runtime <cursor|claude|generic|all>
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `serve` (default) | `--http`, `--cwd <project-root>` | Start the MCP server over stdio (the default). `--cwd` selects the project root whose `.metaproject/` workspace is exposed; this is what makes editor/client launches independent from their process cwd. `--http` switches to the isolated localhost-only HTTP/SSE transport, which additionally requires `http.enabled=true` in the module's manifest entry. Bare `mcp` is an alias for `mcp serve`. |
| `install` | `--runtime <cursor\|claude\|generic\|all>` (comma-separated; default `all`), `--dry-run` | Merge-safely wire this project into an editor/agent's MCP client config: `cursor` → `.cursor/mcp.json`, `claude` → `.mcp.json` (project root), `generic` prints a ready snippet and writes no file. `all` targets cursor + claude. Adds `mcpServers.keryx = { command: "keryx", args: ["mcp","serve","--cwd","<absolute-project-root>"] }` (marked with a managed sentinel), preserving existing servers/keys and staying idempotent. Also sets `modules.mcp.enabled=true` in `metaproject.json` and probes the optional SDK (printing `bun add @modelcontextprotocol/sdk` when absent — it never auto-installs or opens a network connection). `--dry-run` prints the planned change and writes nothing. |
| `uninstall` | `--runtime <cursor\|claude\|generic\|all>` (default `all`) | Remove ONLY the managed `keryx` server (and its sentinel) from each runtime's client config, leaving other servers and user content intact. A no-op when nothing is installed. |

`init` also offers to enable the MCP server interactively (default **No**); the
`--mcp` / `--no-mcp` flags set it non-interactively. The default non-interactive
`init` never enables MCP nor writes a client config.

Tool and resource exposure is filtered by the manifest's `expose.modules` list — a
disabled module is hidden from `tools/list` and `resources/list`.

Unlike every other opt-in command, `mcp serve` **hard-fails** (prints an actionable
message and exits `1`) when the optional `@modelcontextprotocol/sdk` dependency is
not installed — this is the one sanctioned exception to graceful degradation. An
unknown subcommand prints an error and exits `1`.

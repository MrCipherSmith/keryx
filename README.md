# meta-project

`meta-project` is a CLI-first Metaproject toolkit. It installs a local `.metaproject/` workspace into any codebase so AI agents and developers can share the same structured context, generated data, module manifests, and project-specific skills.

The public command is `gd-metapro`. The product/CLI name is `gd-metapro`; `meta-project` is the GitHub repository slug (`MrCipherSmith/meta-project`).

## Why This Exists

Most AI-assisted projects accumulate context in temporary notes, agent scratchpads,
CI logs, wiki pages, and IDE-specific rule files that do not agree with each
other. `gd-metapro` gives those moving parts one project-local coordinate system:

- developers get a CLI and dashboard;
- agents get deterministic entrypoints, skills, rules, graph, health, testing,
  memory, and wiki artifacts;
- CI can publish normalized reports instead of raw logs;
- teams can keep the useful context versioned while leaving runtime/generated
  internals out of Git.

Use it when a repository has several agents, documentation sources, test tools,
quality reports, or task flows and you want them to operate from the same
`.metaproject/` brain instead of ad-hoc hidden folders.

## How It Feels In Practice

```bash
# 1. Install the CLI globally.
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/meta-project/main/scripts/install.sh | bash -s -- --global

# 2. Initialize a repository.
cd path/to/your-project
gd-metapro init

# 3. Build the first project map and reports.
gd-metapro gdgraph build
gd-metapro test analyze
gd-metapro health run --changed
gd-metapro wiki collect --limit 12

# 4. Open the human admin view.
gd-metapro dash

# 5. Start a managed agent-facing task flow.
gd-metapro flow init --title "Refactor payment retry handling"
gd-metapro flow list
```

After init, ask an agent something like:

```text
Find the files related to payment retry handling, explain the relationships,
and use the metaproject tools for context discovery before broad raw search.
```

The agent entrypoint points it at `.metaproject/index.md`, which in turn routes
it to `gdgraph`, `gdctx`, `gdwiki`, `health`, `testing`, `memory`, `gdskills`,
and `flow` only when those modules are enabled.

## Global Install

From the GitHub package source after build hooks:

```bash
bun install -g github:MrCipherSmith/meta-project
gd-metapro init
```

Private repository install through GitHub CLI:

```bash
/opt/homebrew/bin/gh auth setup-git
/opt/homebrew/bin/gh api repos/MrCipherSmith/meta-project/contents/scripts/install.sh --jq .content | base64 -d | bash -s -- --global
gd-metapro init
```

Public/raw install:

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/meta-project/main/scripts/install.sh | bash -s -- --global
gd-metapro init
```

The installer clones the runtime into `~/.gd-metapro/gd-metapro` and writes a wrapper shell script at `~/.local/bin/gd-metapro` that execs the runtime via `bun`.

Make sure `~/.local/bin` is in your `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Install Script Behavior

The shell installer is intentionally small and only does these side effects:

- requires `git` and `bun`;
- optionally runs `gh auth setup-git` when `gh` exists, so private GitHub SSH
  URLs can work;
- in `--global` mode, clones or refreshes the runtime under
  `~/.gd-metapro/gd-metapro`;
- in `--global` mode, writes a wrapper at `~/.local/bin/gd-metapro`;
- in `--project` mode, clones or refreshes the runtime under
  `.metaproject/runtime/gd-metapro` and then runs `gd-metapro init`;
- respects `GD_METAPRO_REPO_URL`, `GD_METAPRO_REF`,
  `GD_METAPRO_HOME`, and `GD_METAPRO_BIN_DIR`.

It does not install shell profiles, global agent rules, IDE extensions, package
manager hooks, or system services. To remove a global install:

```bash
rm -rf ~/.gd-metapro/gd-metapro ~/.local/bin/gd-metapro
```

To inspect before running:

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/meta-project/main/scripts/install.sh
```

## Project-Local Install And Init

Use this when you do not want to install a global command. It installs the runtime into the current project and immediately runs init.

Private repository:

```bash
/opt/homebrew/bin/gh auth setup-git
/opt/homebrew/bin/gh api repos/MrCipherSmith/meta-project/contents/scripts/install.sh --jq .content | base64 -d | bash -s -- --project
```

Public/raw:

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/meta-project/main/scripts/install.sh | bash -s -- --project
```

Non-interactive mode:

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/meta-project/main/scripts/install.sh | bash -s -- --project --yes
```

Project-local install stores the CLI runtime under:

```text
.metaproject/runtime/gd-metapro
```

## What Init Creates

`gd-metapro init` creates:

```text
.metaproject/
  index.md
  gd-metapro-dashboard.html
  README.md
  metaproject.json
  core/
  data/
  rules/
  skills/
  modules/
  reports/
  templates/
  hooks/
    post-update.d/
```

The tree above shows the base structure and the example modules below (`gdgraph`, `gdctx`); enabled modules add their own `core/`, `data/`, `modules/`, and `skills/` scaffolds.

It also connects repository-level agent entrypoints:

- imports existing `AGENTS.md`, `agents.md`, `CLAUDE.md`, or `claude.md` into `.metaproject/rules/`;
- creates `AGENTS.md` when none of those files exist;
- appends a reference from each root entrypoint to `.metaproject/index.md`;
- creates `.metaproject/skills/project-rules/`;
- lists imported rules and skills in `.metaproject/index.md`.
- creates `.metaproject/gd-metapro-dashboard.html`, a static human-readable overview of enabled modules, artifact links, and common commands.

If `gdgraph` is enabled, it also creates:

```text
.metaproject/
  core/gdgraph/
    cli.ts
    build.ts
    query.ts
    types.ts
    README.md
  data/gdgraph/
  modules/gdgraph.md
  skills/gdgraph/SKILL.md
```

Agent rule files are mirrored into:

```text
.metaproject/rules/
.metaproject/skills/project-rules/
```

Graph navigation skill:

```text
.metaproject/skills/gdgraph/SKILL.md
```

This skill tells agents to use `gd-metapro gdgraph ...` by default for project navigation, file discovery, and code-related work before broad raw file search. The user does not need to ask for graph usage explicitly.

If `gdctx` is enabled, init also creates:

```text
.metaproject/
  core/gdctx/
    README.md
  data/gdctx/
    raw/
    artifacts/
    queries/
  gdctx.config.json
  modules/gdctx.md
  skills/gdctx/SKILL.md
```

The `gdctx` skill tells agents to use compact command/search/read output before loading large raw command output into context.

## Versioning Policy

`gd-metapro init` keeps agent-facing Metaproject files versioned and ignores executable/generated internals.

Versioned by default:

- `.metaproject/index.md`
- `.metaproject/README.md`
- `.metaproject/metaproject.json`
- `.metaproject/rules/`
- `.metaproject/skills/`
- `.metaproject/modules/`
- `.metaproject/data/*/artifacts/`
- except `.metaproject/data/gdctx/artifacts/` and `.metaproject/data/gdwiki/artifacts/`, which are transient command output

Ignored by default:

- `.metaproject/runtime/`
- `.metaproject/core/**/*.ts`
- `.metaproject/data/**/storage/`
- `.metaproject/data/**/raw/`
- `.metaproject/data/**/queries/`
- `.metaproject/data/**/summaries/`
- `.metaproject/data/gdctx/artifacts/`
- `.metaproject/data/gdwiki/artifacts/`
- `.metaproject/data/gdwiki/link-check/`
- `.metaproject/data/health/history/`
- `.metaproject/data/health/artifacts/latest.md`
- `.metaproject/data/health/artifacts/latest.json`
- `.metaproject/data/testing/history/`
- `.metaproject/data/testing/logs/`
- `.metaproject/data/testing/artifacts/latest.md`
- `.metaproject/data/testing/artifacts/latest.json`
- `.metaproject/reports/`

## Capability System

The deterministic, local, offline, git-diffable core is preserved. Every model
or precision feature added since the roadmap-2026 blocks is an **opt-in
capability**, so with zero opt-in flags and no assets every command is
byte-identical to before.

- **Zero runtime dependencies.** `package.json` `dependencies` stays `{}`.
  Optional runtimes (`web-tree-sitter`, `@modelcontextprotocol/sdk`,
  `@xenova/transformers`) live only under `optionalDependencies` and are never
  required.
- **One seam.** `resolveCapability(cwd, spec)` (`src/capability/seam.ts`) returns
  an adapter only when the capability is (1) manifest-enabled, (2) its optional
  dependency imports via lazy `await import()`, and (3) its asset resolves and
  passes sha256 verification. It never throws — any missing part degrades to the
  deterministic fallback plus a single stderr warning and exit 0.
- **Assets are never bundled or auto-downloaded.** They resolve through the Asset
  Resolver (`.metaproject/assets.lock.json`), managed per module with
  `gd-metapro <module> assets list | verify [<id>] | pull <id>`.

## Commands

```bash
gd-metapro --version
gd-metapro init
gd-metapro init --yes
gd-metapro init --no-gdgraph
gd-metapro init --no-gdctx
gd-metapro init --no-memory
gd-metapro init --no-gdgraph-hook
gd-metapro status
gd-metapro update
gd-metapro update --skip-runtime
gd-metapro update --hooks
gd-metapro dashboard build
gd-metapro dashboard open
gd-metapro dash
gd-metapro rules sync
gd-metapro gdgraph build
gd-metapro gdgraph query cycles
gd-metapro gdgraph query orphans
gd-metapro gdgraph affected src/example.ts [--depth N] [--ranked] [--json]
gd-metapro gdgraph repomap [--budget N] [--seed <path>...] [--changed]
gd-metapro ctx status
gd-metapro ctx diff
gd-metapro wiki status
gd-metapro wiki ask "How does auth work?"
gd-metapro skills status
gd-metapro test analyze
gd-metapro test run --changed
gd-metapro test coverage-map build
gd-metapro health run --changed
gd-metapro memory search "decision"
gd-metapro memory search "retry" --as-of 2026-01-01 --class procedural
gd-metapro memory supersede <old> --by <new>
gd-metapro memory index --embeddings
gd-metapro flow init --title "Task title"
gd-metapro flow list
gd-metapro flow status <id>
gd-metapro flow complete <id>
gd-metapro standard validate
gd-metapro standard doctor
gd-metapro standard capabilities
gd-metapro standard emit llms
gd-metapro security status
gd-metapro security scan src/example.ts
gd-metapro security scan-mcp <manifest.json|dir>
gd-metapro security check-output --file draft.md
gd-metapro security report
gd-metapro security hooks install --runtime claude
gd-metapro security eval --corpus all
gd-metapro mcp serve
```

This lists the most common entry points only. Each command has additional
subcommands and flags; run `gd-metapro <command> --help` (or `gd-metapro`
with no arguments) for the full subcommand and flag surface.

## Developer Documentation

Full developer documentation — reverse-engineered from the source — lives under
[docs/docs/](docs/docs/):

- **[Onboarding](docs/docs/onboarding.md)** — install paths, first-run walkthrough, the build loop, TTY/CI behavior.
- **[Architecture](docs/docs/architecture.md)** — the four-layer pattern, the two invariants, cross-module data flows, integrations.
- **[Module reference](docs/docs/modules.md)** — one section per module: purpose, CLI surface, key files, mechanics, data paths.
- **[CLI reference](docs/docs/cli-reference.md)** — every command, subcommand, and flag.
- **[Workspace & lifecycle](docs/docs/workspace-and-lifecycle.md)** — the `.metaproject/` contract and `init`/`update` lifecycle.

Product specifications (the intended design) live separately under
[docs/requirements/](docs/requirements/). Where the two disagree, `docs/docs/`
describes current behavior.

## Current Modules

The `gd-metapro` CLI itself is the toolkit core: it provides install, `init`,
`status`, `update`, `dashboard`, `rules`, and `standard` (validate the workspace
against the [Metaproject Standard](docs/requirements/metaproject-standard/specification.md))
and manages the `.metaproject` structure and module manifest. It ships the
following modules:

- `gdgraph`: code graph module for dependencies and affected context; N-hop `affected` blast radius and PageRank `repomap`, with an opt-in tree-sitter symbol/call graph (`init --treesitter`).
- `gdctx`: context module for compact command/search/read output.
- `gdwiki`: Markdown project knowledge base with page templates, link checks, and index generation; grounded `wiki ask` retrieval over the pages.
- `gdskills`: bundled agent-facing skills plus generated project-skill creation, routing, verification, learning, export (`codex|claude|plugin`), and sync.
- `health`: normalized code health reports from TypeScript, tests, audit, complexity, coverage, lint, and optional SonarQube; opt-in churn×complexity hotspot signal (`scoring.hotspotWeight`, default 0, so scores are unchanged by default).
- `testing`: project testing context, related-test selection, changed-scope runs, and normalized reports; an always-on smoke tier plus an opt-in coverage-map Test Impact Analysis (`init --testing-tia`).
- `memory`: long-term Markdown project memory with indexing, search, ingest, deduplication, and reflection; bitemporal `Valid-From`/`Valid-To`/`Superseded-By` fields, semantic/episodic/procedural classes, non-destructive `supersede`, opt-in local embeddings, and procedural memory auto-injected into task-implementer prompts.
- `tasks`: agent-first Task Manager, driven by `gd-metapro flow`, for issue/task lifecycle tracking.
- `security`: agent input/output and artifact security, driven by `gd-metapro security` - deterministic secrets/PII/prompt-injection/egress scanning, redaction, and a policy gate, with in-process guards at the memory/wiki/testing/gdctx/flow write seams and optional git + multi-runtime agent hooks. See [Security](#security).
- `mcp`: opt-in Model Context Protocol server (`gd-metapro mcp serve`) exposing read-only module services to agents; disabled by default (`modules.mcp.enabled=false`, needs the optional MCP SDK). See [Agent And IDE Integration](#agent-and-ide-integration).

## Security

Metaproject Security is the local security/privacy/exfiltration-control layer for
agent inputs, outputs, and `.metaproject/` artifacts. It is deterministic
(regex + entropy, no network, no model backends) and is intentionally separate
from `security-audit` (dependencies / secrets in git history).

**Detects** secrets (provider keys, private keys, `.env`, URL creds, JWT),
checksum-verified structured PII (IBAN/Luhn/SSN/IP alongside email/phone/…),
prompt-injection, modern exfiltration (markdown-image/EchoLeak, SSRF/metadata),
and egress attempts against a deny-by-default `policies.egress.allowlist`, then
applies a policy action with the precedence
`block > require-approval > redact > warn > allow`.
Redaction is leak-safe: fixed-width masks, HMAC-keyed hashing with a local-only,
never-committed key, and committable reports that carry no raw secrets.

**CLI:**

```bash
gd-metapro security status
gd-metapro security scan <path> [--json]
gd-metapro security scan-mcp <manifest.json|dir> [--json] [--pin <manifest>] [--strict]
gd-metapro security check-input [--source <kind>] [--file <path>]
gd-metapro security check-output [--target <kind>] [--file <path>]
gd-metapro security redact <path> [--out <path>]
gd-metapro security report [--since <ref>]
gd-metapro security policy validate
gd-metapro security incidents [--limit <n>]
gd-metapro security hooks install|uninstall --runtime <claude|cursor|windsurf|generic-mcp|all>
gd-metapro security eval [--corpus <name|all>] [--with-model]
```

**Opt-in model backends.** On the `backends` seam, an optional Prompt Guard 2
injection model and an NER PII backend can raise recall; both are off by default
and degrade to the deterministic detectors when their assets are absent.
`security eval` runs labeled corpora through the detectors and reports a
per-detector false-negative rate, exiting non-zero when a detector breaches its
committed threshold.

**Modes** (`.metaproject/security.config.json`): `advisory` (default - report and
continue, never block), `enforced` (block the controlled write), `ci` (exit
non-zero on a blocker).

**Write-seam guards.** When the module is enabled, the guard runs in-process
before writes at `memory ingest`, `wiki collect`, `test` publish, `gdctx` raw
output, and `flow complete`. Advisory only warns; enforced/ci can stop the write.

**Hooks** (opt-in at `init`, offered only when security is enabled):

- **git pre-push** (`--no-security-hook`) - scans the commits being pushed and
  blocks the push in `enforced`/`ci` (warns in `advisory`).
- **agent hook** (`--no-security-agent-hook`) - a merge-safe block in
  `.claude/settings.json` that runs `security check-input` on `UserPromptSubmit`
  and `security check-output` on `PreToolUse(Write|Edit)`.

See [docs/requirements/security/specification.md](docs/requirements/security/specification.md)
for the full contract.

## gdgraph MVP

`gdgraph` installs local project scripts into:

```text
.metaproject/core/gdgraph/
```

The global command delegates to the local runner first:

```text
.metaproject/core/gdgraph/cli.ts
```

Build graph data:

```bash
gd-metapro gdgraph build
```

Generated output:

```text
.metaproject/data/gdgraph/storage/nodes.jsonl
.metaproject/data/gdgraph/storage/edges.jsonl
.metaproject/data/gdgraph/artifacts/summary.md
.metaproject/data/gdgraph/artifacts/module-map.json
```

Frontend defaults:

- skips generated/static output such as `storybook-static/**`, `public/**`, `.docusaurus/**`, `dist/**`, `build/**`, `coverage/**`, `.next/**`, and `out/**`;
- extracts imports through Bun's parser-backed scanner for static imports, re-exports, literal dynamic imports, and `require(...)`, with regex fallback only when scanner parsing fails;
- resolves root `tsconfig.json` `baseUrl` and `paths` aliases for local source and asset imports;
- resolves imported assets such as CSS, SVG, JSON, handlebars/raw templates and image/font files as `asset` graph nodes instead of counting them as unresolved imports;
- summary reports source files, asset nodes, import resolution percent, skipped directories, top modules, and unresolved imports by type.

Run built-in queries:

```bash
gd-metapro gdgraph query cycles
gd-metapro gdgraph query orphans
gd-metapro gdgraph affected <file>
```

`affected` takes an optional `--depth N` for a transitive N-hop blast radius,
plus `--ranked` and `--json`; the default (`--depth 1`) output is unchanged.
`gdgraph repomap [--budget N] [--seed <path>...] [--changed]` writes a
PageRank-ranked, token-budgeted `repomap.md`:

```bash
gd-metapro gdgraph affected <file> --depth 3 --ranked
gd-metapro gdgraph repomap --budget 2000 --changed
```

An opt-in tree-sitter symbol graph (`gd-metapro init --treesitter`) additively
writes `symbols.jsonl`/`calls.jsonl`; the regex-based scanner stays the default
and the graph is byte-identical without it.

## gdgraph Refresh Policy

Agents should not rebuild the graph on every question. The graph is refreshed:

- when the user explicitly runs `gd-metapro gdgraph build`;
- by the optional Git `post-commit` hook installed during `gd-metapro init`.

When `gdgraph` is enabled, interactive init asks whether to install the hook. In `--yes` mode the hook is installed by default; disable it with:

```bash
gd-metapro init --yes --no-gdgraph-hook
```

The hook checks files changed in the last commit and runs `gd-metapro gdgraph build` only when graph-relevant files changed.

Git hooks are installed as `gd-metapro` managed blocks. `gd-metapro update --hooks`
replaces only those marked blocks and preserves existing user hook content,
including Husky, Lefthook, lint-staged, or custom shell commands.

## Update

Refresh the managed runtime and local service layer:

```bash
gd-metapro update
```

`update` refreshes managed scripts, skills, module manifests, dashboard and hook definitions. It does not run module analyzers and does not write `.metaproject/data/**` artifacts by default.

By default `update` also refreshes the managed runtime from origin/main before
updating service files. Skip that network step with `--skip-runtime`:

```bash
gd-metapro update --skip-runtime
```

Projects initialized before the `tasks` module was added are backfilled: `update`
enables and scaffolds the Task Manager automatically. Skip the backfill with
`--no-tasks`:

```bash
gd-metapro update --no-tasks
```

Run executable project hooks explicitly when a module needs a post-update refresh:

```bash
gd-metapro update --hooks
```

Project hooks live in:

```text
.metaproject/hooks/post-update.d/
```

## Dashboard

Rebuild or open the project admin dashboard:

```bash
gd-metapro dashboard build
gd-metapro dashboard open
```

The dashboard is written to `.metaproject/gd-metapro-dashboard.html` from existing service files and data artifacts. It does not run analyzers or modify `.metaproject/data/**`.

The dashboard is meant to be a project admin surface, not just a status page. It
shows enabled modules, attention signals, health scores by scope/file/source,
graph summary, testing context, wiki pages, memory entries, and common commands.

## Agent And IDE Integration

`gd-metapro init` connects existing `AGENTS.md` and `CLAUDE.md` style entrypoints
to `.metaproject/index.md`. Keep those root files short: high-priority global
rules plus a strict pointer to the Metaproject index. Put detailed project rules,
skills, memory, and wiki content inside `.metaproject/`.

Example agent instruction:

```text
Before planning, editing, or reviewing this repository, read
.metaproject/index.md. For file discovery and project navigation, prefer the
Metaproject gdgraph skill before broad raw search. For large command output,
diffs, test logs, and long files, use gdctx. For architecture, business rules,
known decisions, and historical context, use gdwiki and memory first.
```

Practical integration pattern:

- Claude Code / Codex / Cursor / other coding agents: keep the root
  `AGENTS.md` or `CLAUDE.md` small and let it point to `.metaproject/index.md`.
- Project-specific skills: generate or store canonical skills under
  `.metaproject/project-skills/` and export/sync only when a runtime needs it.
- Review or implementation agents: read `health`, `testing`, `memory`, and
  `gdgraph` artifacts before touching broad source files.

### MCP Server

For agents that speak the Model Context Protocol, `gd-metapro mcp serve` exposes
the module services as a stdio-first MCP server (`--http` is a separate opt-in).
The tools are thin, read-only adapters over the module service facades
(`gdgraph.affected`/`cycles`/`orphans`, `security.check`/`scan`/`scan-mcp`,
`flow.status`, `memory.search`, `health.gate`/`status`, `wiki.query`,
`standard.validate`), plus read-only Resources under
`metaproject://<class>/<relpath>`. The `mcp` module is off by default and needs
the optional MCP SDK. Related surfaces: `security scan-mcp`,
`standard emit llms`, and `skills export --runtime plugin`.

Wire the server into an editor/agent in one command, project-scoped and
merge-safe:

```bash
gd-metapro mcp install --runtime cursor      # writes .cursor/mcp.json
gd-metapro mcp install --runtime claude      # writes .mcp.json (project root)
gd-metapro mcp install --runtime all         # cursor + claude (default)
gd-metapro mcp install --runtime generic     # prints a ready snippet, writes no file
gd-metapro mcp install --runtime cursor --dry-run   # preview only, writes nothing
gd-metapro mcp uninstall --runtime cursor    # removes only the managed gd-metapro server
```

`install` merges `mcpServers.gd-metapro = { command: "gd-metapro", args: ["mcp",
"serve"] }` into the client config (preserving any existing servers and keys; a
re-install is idempotent), sets `modules.mcp.enabled=true` in
`.metaproject/metaproject.json`, and probes the optional MCP SDK — printing
`bun add @modelcontextprotocol/sdk` when it is absent. It never auto-installs the
SDK and never opens a network connection. The managed entry carries a sentinel so
`uninstall` removes only `gd-metapro` and leaves your other servers intact. Since
`init` also offers to enable MCP interactively (default **No**), the default
non-interactive `init` never enables MCP or writes a client config.

## CI Integration

`gd-metapro` is designed so CI can publish normalized artifacts that agents and
humans can read later:

```bash
gd-metapro gdgraph build
gd-metapro test analyze
gd-metapro test run --changed
gd-metapro health run --changed
gd-metapro dashboard build
```

Recommended CI artifacts:

```text
.metaproject/gd-metapro-dashboard.html
.metaproject/data/health/artifacts/latest.md
.metaproject/data/health/artifacts/latest.json
.metaproject/data/testing/artifacts/latest.md
.metaproject/data/testing/artifacts/latest.json
.metaproject/data/gdgraph/artifacts/summary.md
.metaproject/data/gdgraph/artifacts/module-map.json
```

Use `gd-metapro health gate --strict-warn` when you want a CI job to fail on
the normalized health gate instead of parsing raw linter/test logs.

For security-sensitive repositories, `gd-metapro security eval --corpus all`
runs the red-team corpora and fails the job when any detector's false-negative
rate breaches its committed threshold (gate the model-backed run separately with
`--with-model`).

## Custom Module Convention

The built-in module set is opinionated, but `.metaproject/` is intentionally
structured so teams can add their own module domains. A custom module should
follow the same shape:

```text
.metaproject/
  modules/<module-name>.md
  skills/<module-name>/SKILL.md
  data/<module-name>/
    artifacts/
  core/<module-name>/
```

Minimum manifest pattern:

```markdown
# <module-name>

Purpose: what this module owns.

Agent entry: `skills/<module-name>/SKILL.md`
Data: `data/<module-name>/artifacts/`
Commands: project-local or external commands that refresh the data.
```

Then add the module to `.metaproject/index.md` so agents can discover it.
First-class CLI support for third-party module registration is a future
extension; today this is a stable project convention for teams that need
`gdai`, `gdobservability`, or other local domains.

## Flow (Task Manager)

The `tasks` module tracks agent-first managed work through `gd-metapro flow`:

```bash
gd-metapro flow init (--issue <url> | --title "<title>")
gd-metapro flow list
gd-metapro flow status <id>
gd-metapro flow start <id>
gd-metapro flow task <id> ...
gd-metapro flow ac <id> ...
gd-metapro flow implemented <id>
gd-metapro flow complete <id> [--comment]
gd-metapro flow block <id>
gd-metapro flow unblock <id>
gd-metapro flow freeze <id>
gd-metapro flow check
```

Run `gd-metapro flow --help` for the full argument list of each subcommand.

## Requirements

- `git`
- `bun` (>= 1.1.0)

## Local development

```bash
bun ./src/cli.ts init
bun ./src/cli.ts init --yes
bun ./src/cli.ts status
```

## Project Feedback And Roadmap

Good early feedback is especially useful around:

- first-run onboarding and dashboard clarity;
- agent/IDE integration examples;
- CI artifact publishing patterns;
- custom module conventions;
- health/testing defaults for large frontend repositories;
- project-skill generation and verification loops.

Open a GitHub issue with the bug report or feature request templates, and attach
the relevant `.metaproject/data/*/artifacts/latest.md` files when possible.

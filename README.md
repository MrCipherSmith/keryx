# meta-project

`meta-project` is a CLI-first Metaproject toolkit. It installs a local `.metaproject/` workspace into any codebase so AI agents and developers can share the same structured context, generated data, module manifests, and project-specific skills.

The public command is `gd-metapro`.

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

The installer clones the runtime into `~/.gd-metapro/gd-metapro` and creates a symlink at `~/.local/bin/gd-metapro`.

Make sure `~/.local/bin` is in your `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
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
```

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
- except `.metaproject/data/gdctx/artifacts/`, which is transient command output

Ignored by default:

- `.metaproject/runtime/`
- `.metaproject/core/**/*.ts`
- `.metaproject/data/**/storage/`
- `.metaproject/data/**/raw/`
- `.metaproject/data/**/queries/`
- `.metaproject/data/**/summaries/`
- `.metaproject/data/gdctx/artifacts/`
- `.metaproject/reports/`

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
gd-metapro update --hooks
gd-metapro gdgraph build
gd-metapro gdgraph query cycles
gd-metapro gdgraph query orphans
gd-metapro gdgraph affected src/example.ts
gd-metapro ctx status
gd-metapro ctx diff
gd-metapro wiki status
gd-metapro skills status
gd-metapro test analyze
gd-metapro test run --changed
gd-metapro health run --changed
gd-metapro memory search "decision"
```

## Current Modules

- `spec-orchestrator`: CLI, install, init, manifest, and `.metaproject` structure.
- `gdgraph`: code graph module for dependencies and affected context.
- `gdctx`: context module for compact command/search/read output.
- `gdwiki`: Markdown project knowledge base with page templates, link checks, and index generation.
- `gdskills`: bundled agent-facing skills plus generated project-skill creation, routing, verification, learning, export, and sync.
- `testing`: project testing context, related-test selection, changed-scope runs, and normalized reports.
- `code-health`: normalized code health reports from TypeScript, tests, audit, complexity, coverage, lint, and optional SonarQube.
- `memory`: long-term Markdown project memory with indexing, search, ingest, deduplication, and reflection.

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
- resolves imported assets such as CSS, SVG, JSON, handlebars/raw templates and image/font files as `asset` graph nodes instead of counting them as unresolved imports;
- summary reports source files, asset nodes, import resolution percent, skipped directories, top modules, and unresolved imports by type.

Run built-in queries:

```bash
gd-metapro gdgraph query cycles
gd-metapro gdgraph query orphans
gd-metapro gdgraph affected <file>
```

## gdgraph Refresh Policy

Agents should not rebuild the graph on every question. The graph is refreshed:

- when the user explicitly runs `gd-metapro gdgraph build`;
- by the optional Git `post-commit` hook installed during `gd-metapro init`.

When `gdgraph` is enabled, interactive init asks whether to install the hook. In `--yes` mode the hook is installed by default; disable it with:

```bash
gd-metapro init --yes --no-gdgraph-hook
```

The hook checks files changed in the last commit and runs `gd-metapro gdgraph build` only when graph-relevant files changed.

## Update

Refresh the managed runtime and local service layer:

```bash
gd-metapro update
```

`update` refreshes managed scripts, skills, module manifests, dashboard and hook definitions. It does not run module analyzers and does not write `.metaproject/data/**` artifacts by default.

Run executable project hooks explicitly when a module needs a post-update refresh:

```bash
gd-metapro update --hooks
```

Project hooks live in:

```text
.metaproject/hooks/post-update.d/
```

## Requirements

- `git`
- `bun`

## Local development

```bash
bun ./src/cli.ts init
bun ./src/cli.ts init --yes
bun ./src/cli.ts status
```

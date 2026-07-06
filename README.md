# meta-project

`meta-project` is a CLI-first Metaproject toolkit. It installs a local `.metaproject/` workspace into any codebase so AI agents and developers can share the same structured context, generated data, module manifests, and project-specific skills.

The public command is `gd-metapro`.

## Global Install

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

Ignored by default:

- `.metaproject/runtime/`
- `.metaproject/core/**/*.ts`
- `.metaproject/data/**/storage/`
- `.metaproject/data/**/queries/`
- `.metaproject/data/**/summaries/`
- `.metaproject/reports/`

## Commands

```bash
gd-metapro --version
gd-metapro init
gd-metapro init --yes
gd-metapro init --no-gdgraph
gd-metapro status
gd-metapro update
gd-metapro gdgraph build
gd-metapro gdgraph query cycles
gd-metapro gdgraph query orphans
gd-metapro gdgraph affected src/example.ts
```

## Current Modules

- `spec-orchestrator`: CLI, install, init, manifest, and `.metaproject` structure.
- `gdgraph`: code graph module for dependencies and affected context.

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

Run built-in queries:

```bash
gd-metapro gdgraph query cycles
gd-metapro gdgraph query orphans
gd-metapro gdgraph affected <file>
```

## Update

Update the managed runtime and run executable project hooks:

```bash
gd-metapro update
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

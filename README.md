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
  skills/
  modules/
  reports/
  templates/
```

If `gdgraph` is enabled, it also creates:

```text
.metaproject/
  core/gdgraph/
  data/gdgraph/
  modules/gdgraph.md
  skills/gdgraph/
```

## Commands

```bash
gd-metapro --version
gd-metapro init
gd-metapro init --yes
gd-metapro init --no-gdgraph
gd-metapro status
```

## Current Modules

- `spec-orchestrator`: CLI, install, init, manifest, and `.metaproject` structure.
- `gdgraph`: planned code graph module for dependencies, symbols, and affected context.

## Requirements

- `git`
- `bun`

## Local development

```bash
bun ./src/cli.ts init
bun ./src/cli.ts init --yes
bun ./src/cli.ts status
```

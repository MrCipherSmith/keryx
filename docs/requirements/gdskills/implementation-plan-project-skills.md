# gdskills Project Skills Implementation Plan

Version: 0.1.0

## Goal

Implement the first executable lifecycle slice for canonical `project-skills`.

This slice must let a user or agent create a project-local skill package from a target path, module, component, service, store, wiki page or domain entity.

## Scope

Commands:

```bash
gd-metapro skills create <target> --module <module> --name <skill-name>
gd-metapro skills generate <target> --module <module> --name <skill-name>
```

`generate` is an alias for `create` because the requirements currently use both terms.

Generated package:

```text
.metaproject/project-skills/<module>/<skill-name>/
  SKILL.md
  skill-changelog.md
  verification.md
  references/
    context.md
  templates/
    README.md
```

The generated package must include:

- `Version` in `SKILL.md`;
- target, module, status and last verified metadata;
- generated-section markers for machine-managed evidence;
- `skill-changelog.md` with versioned creation entry;
- `verification.md` with current verification state;
- `references/context.md` with collected lightweight evidence;
- registration in `.metaproject/skills/catalog.md`;
- registration in `.metaproject/metaproject.json`.

## Non-goals

- Deep semantic extraction from code internals.
- Full `skills verify` and `skills learn` implementation.
- Runtime export to Codex/Claude global folders.
- Automatic modification of production code.
- Embeddings or network-backed context lookup.

## Phase 1: Plan

Actions:

- save this plan;
- inspect current skill CLI and install helpers;
- avoid unrelated `.metaproject/data/gdgraph` changes.

Verification:

- confirm plan file exists and has `Version`.

## Phase 2: Generator

Actions:

- add project-skill types and path normalization;
- collect lightweight evidence from:
  - target existence;
  - related gdgraph artifacts if available;
  - related gdwiki index if available;
  - related gdctx artifacts if available;
- create idempotent package files.

Verification:

- create a project skill in a temporary initialized project;
- inspect generated files.

## Phase 3: CLI

Actions:

- add `skills create`;
- add `skills generate` alias;
- support `--module`, `--name`, `--format`, `--dry-run`;
- print generated paths and warnings.

Verification:

- `gd-metapro skills --help`;
- `gd-metapro skills create <target> --module <module> --name <name> --dry-run`;
- `gd-metapro skills create <target> --module <module> --name <name>`.

## Phase 4: Registration

Actions:

- append/update project-skill registry in `.metaproject/metaproject.json`;
- append/update a generated project-skills section in `.metaproject/skills/catalog.md`;
- keep generated sections idempotent.

Verification:

- run create twice and confirm the same package is updated without duplicate registry entries.

## Phase 5: Regression

Actions:

- run package check;
- run contract validation smoke commands from the previous slice;
- run init + create smoke in `/private/tmp`.

Verification:

- `bun run check`;
- `gd-metapro skills contracts list`;
- smoke project contains generated project-skill files and registry entries.

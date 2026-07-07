# Project Metaproject

This folder contains local Metaproject configuration, tools, generated data, and agent instructions.

## Installed Modules

- `gdgraph`: code graph and affected context.
- `gdctx`: compact command/search/read output and raw output archive.
- `gdwiki`: project wiki authoring, indexing, and link validation.
- `gdskills`: bundled and project skills catalog, routing, and verification.
- `memory`: long-term typed project memory with ranked search.
- `tasks`: agent-first flow lifecycle (driven by the `gd-metapro flow` command).
- `health`: code-health scoring, gates, and trend tracking.
- `testing`: test analysis, selection, and context.

See `.metaproject/index.md` for the authoritative module list and per-module manifests under `.metaproject/modules/`.

## Common Commands

```bash
gd-metapro status
gd-metapro gdgraph build
gd-metapro gdgraph query "module pipelines"
gd-metapro ctx status
gd-metapro ctx diff
```

## Editing Policy

- Edit module manifests and skills manually when needed.
- Do not manually edit generated files under `data/*/storage`.
- Regenerate artifacts with CLI commands.

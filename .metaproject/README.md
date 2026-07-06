# Project Metaproject

This folder contains local Metaproject configuration, tools, generated data, and agent instructions.

## Installed Modules

- `gdgraph`: code graph and affected context.

## Common Commands

```bash
gd-metapro status
gd-metapro gdgraph build
gd-metapro gdgraph query "module pipelines"
```

## Editing Policy

- Edit module manifests and skills manually when needed.
- Do not manually edit generated files under `data/*/storage`.
- Regenerate artifacts with CLI commands.

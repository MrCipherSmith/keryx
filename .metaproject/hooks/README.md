# Metaproject Hooks

Hooks are local project scripts executed by selected `gd-metapro` lifecycle commands.

## git post-commit gdgraph hook

When enabled during `gd-metapro init`, the Git `post-commit` hook refreshes gdgraph only after commits that touched files relevant to the graph.

Purpose:

- keep graph artifacts current without rebuilding on every agent question;
- avoid broad raw file search when graph context is stale;
- leave generated graph storage local while versioning curated artifacts.

## git post-commit gdskills hook

When enabled during `gd-metapro init`, the Git `post-commit` hook runs lightweight project-skill verification after relevant project or Metaproject context changes.

Purpose:

- keep generated project-skills from silently drifting after code/wiki/rule changes;
- write verification reports under `.metaproject/data/gdskills/reports`;
- keep the hook local, optional and non-blocking.

## post-update.d

Executable files in `post-update.d/` run after `gd-metapro update`.

Rules:

- keep hooks idempotent;
- keep hooks project-local;
- do not require network access unless the hook clearly documents it;
- use generated data under `.metaproject/data` for outputs.

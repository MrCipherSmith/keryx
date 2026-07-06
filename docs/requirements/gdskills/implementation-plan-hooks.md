# gdskills Hooks Implementation Plan

Version: 0.1.0

## Goal

Install optional project-local git hooks for project-skill verification.

The hook must be non-blocking, lightweight, idempotent and explicitly enabled during `gd-metapro init`.

## Scope

Init flags:

```bash
gd-metapro init --no-gdskills-hook
```

Installed hook:

```text
.git/hooks/post-commit
```

The first hook slice:

- asks during interactive init when `gdskills` is enabled;
- enables by default with `gd-metapro init --yes`;
- writes a managed block into `.git/hooks/post-commit`;
- preserves existing hook content and other managed blocks;
- runs only after relevant code/docs/wiki/rules/project-skill changes;
- calls `gd-metapro skills verify --all`;
- never blocks the commit on verification failure.

## Non-goals

- Precise ownership-map based candidate selection.
- Auto-applying learning proposals from hooks.
- Network access.
- Destructive target cleanup.

## Verification

- `bun run check`;
- `gd-metapro init --yes` in a git smoke project;
- inspect `.git/hooks/post-commit`;
- run `gd-metapro skills verify --all`.

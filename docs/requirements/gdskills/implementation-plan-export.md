# gdskills Export Implementation Plan

Version: 0.1.0

## Goal

Implement `gd-metapro skills export` for canonical project skills.

Export converts a canonical `.metaproject/project-skills/<module>/<skill>/` package into a runtime-compatible artifact for a target agent runtime without syncing it globally.

## Scope

Commands:

```bash
gd-metapro skills export <project-skill> --runtime codex
gd-metapro skills export <project-skill> --runtime claude
```

The first export slice:

- resolves project skill by path, `module/name`, manifest entry or target;
- writes output to `.metaproject/runtime/skills/<runtime>/<module>-<skill>/`;
- exports `SKILL.md`;
- copies safe `references/`, `templates/`, `assets/` and `scripts/` directories when present;
- excludes canonical management files:
  - `skill-changelog.md`;
  - `verification.md`;
  - proposal/audit/report files;
- writes `export-manifest.json`;
- supports `--dry-run` and `--json`.

## Non-goals

- Syncing exported skills into global Codex or Claude folders.
- Runtime-specific agent installation.
- Rewriting long skills into optimized runtime chunks.
- Exporting all project skills in batch.

## Verification

- `bun run check`;
- create a smoke project skill;
- run `gd-metapro skills export <module>/<skill> --runtime codex`;
- inspect output artifact and manifest.

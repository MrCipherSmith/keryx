# gdskills Sync Implementation Plan

Version: 0.1.0

## Goal

Implement opt-in runtime skill synchronization for exported project skills.

Sync must never automatically write to global Codex, Claude or other runtime folders. The first slice requires an explicit target directory.

## Scope

Commands:

```bash
gd-metapro skills sync --runtime codex --target <dir>
gd-metapro skills sync --runtime claude --target <dir>
```

The first sync slice:

- reads exported runtime artifacts from `.metaproject/runtime/skills/<runtime>/`;
- requires `--target <dir>`;
- copies every exported skill package into the target directory;
- writes `gd-metapro-sync-manifest.json` into the target directory;
- supports `--dry-run` and `--json`;
- does not delete target files that are not part of the sync.

## Non-goals

- Auto-detecting global runtime folders.
- Writing to `$HOME`, Codex, Claude or IDE folders without explicit target.
- Removing stale files from target directories.
- Installing runtime plugins or agents.

## Verification

- `bun run check`;
- export a smoke project skill;
- run `gd-metapro skills sync --runtime codex --target <tmp-dir> --dry-run --json`;
- run real sync and inspect target files plus sync manifest.

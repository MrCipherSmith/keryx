# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: With default (local) scopes, `keryx integrations install --runtime claude --surface rules` writes the `keryx:rules` block into `CLAUDE.local.md` and `--runtime codex --surface rules` writes it into `AGENTS.override.md`; `git status --porcelain` lists neither `CLAUDE.md` nor `AGENTS.md`, and uninstall removes the block from the same local files.
- AC2: With `scope: "shared"` for a runtime, that runtime's rules-export surface writes the tracked `CLAUDE.md` / `AGENTS.md` exactly as before this change.
- AC3: With Codex `mode: "skip"`, with no `AGENTS.md`, or with an `AGENTS.override.md` keryx did not generate, the Codex rules-export surface writes no file and reports why as a warning; the install does not fail.
- AC4: `keryx update` and `keryx rules sync` regenerating `AGENTS.override.md` keep an installed `keryx:rules` block in it, and a second `update` changes no file.
- AC5: One `keryx update` moves a `keryx:rules` block left as an uncommitted edit in a tracked `CLAUDE.md`/`AGENTS.md` (scope local) to the local target, restores the tracked file to its `HEAD` bytes (`git diff --quiet` passes), keeps unrelated uncommitted edits when present, and leaves a block committed in `HEAD` untouched without writing a local duplicate.
- AC6: Install, uninstall, `keryx integrations doctor`, inspect, `--dry-run` and install-state all use the same resolved target, and the block never exists in both the tracked and the local file after any command.
- AC7: `keryx doctor`'s `entrypoints` check warns, with `keryx update` as the fix, about an uncommitted `keryx:rules` block in a tracked file whose scope is local.
- AC8: The docs and the CHANGELOG no longer list `rules-export` as writing tracked files, and describe where the block goes; the version is bumped for the release.
- AC9: Tests cover AC1–AC7 in real temp git repositories; typecheck, lint and the CI suite on the PR pass (failures that also occur on main are named as such).

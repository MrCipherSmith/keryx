# Managed blocks go to per-developer gitignored files (CLAUDE.local.md, AGENTS.override.md, settings.local.json, .git/info/exclude) instead of tracked team files

Status: formalized
Source: user description (pasted request, 2026-09-30)

## Problem

`keryx init` and `keryx update` write keryx-managed content into files a consumer
repository tracks and shares with the whole team:

1. the `<!-- keryx:index --> … <!-- /keryx:index -->` block into `AGENTS.md` and `CLAUDE.md`;
2. the `# keryx:begin … # keryx:end` block into `.gitignore`;
3. `_keryxManaged` hooks into `.claude/settings.json`.

In a consumer repo (observed in a consumer project) these stay as uncommitted edits in
every clone. When upstream changes `AGENTS.md`/`CLAUDE.md`, `git merge --ff-only` and
`git pull` refuse ("local changes would be overwritten"), and the project forbids
`git stash`, so a developer has no clean way to update.

## Expected Outcome

Keryx writes its managed blocks into per-developer, gitignored files and leaves the
team's tracked files alone.

1. `agentEntrypoints.root` in `.metaproject/metaproject.json` holds one entry per
   target, `{ runtime, path, scope: "local" | "shared" }`. The old string-array form
   is still read and is migrated by `keryx update`.
2. Claude Code: the index block is written to `CLAUDE.local.md` (scope local), never to
   `CLAUDE.md`, on both `init` and `update`. The file is created when missing.
3. Codex: there is no additive local file — `AGENTS.override.md` replaces `AGENTS.md`
   in the same directory and `AGENTS.local.md` is not read (openai/codex#26957 is
   open). For scope local the config names one of two modes explicitly:
   `override` — generate `AGENTS.override.md` as the repository's `AGENTS.md` content
   plus the keryx block, regenerated on `keryx update` and when `AGENTS.md` changes —
   or `skip` — write nothing for Codex and say so. A bare block is never written into
   `AGENTS.override.md`, because it would hide the team's `AGENTS.md`.
4. Claude hooks carrying `_keryxManaged` are written to `.claude/settings.local.json`,
   not `.claude/settings.json`.
5. `.gitignore`: before writing the managed block, keryx asks git whether the paths
   are already ignored (`git check-ignore`). When `.metaproject/` is ignored as a
   whole, nothing is written. When a block is still needed, it goes to
   `.git/info/exclude`, not the tracked `.gitignore`.
6. Every local target (`CLAUDE.local.md`, `AGENTS.override.md`,
   `.claude/settings.local.json`) is verified ignored with `git check-ignore`; missing
   ones are added to `.git/info/exclude`.
7. Migration on `keryx update`: a managed block found in a tracked file whose target
   scope is local is moved — written to the local target and removed from the tracked
   file so that file is byte-identical to HEAD (`git diff --quiet -- <file>`). When the
   tracked file carries unrelated uncommitted edits, only the text between the markers
   is removed and the case is reported. The block (or the hooks) never stays in both
   places, since hooks would fire twice.
8. `keryx doctor` / health reports a managed block found in a tracked file as a
   warning carrying the fix command.
9. Every doc, skill, rule and template that names the entrypoints is updated
   (agent-entrypoint-manager, agent-entrypoint-distiller, the index block text itself,
   and anything saying "AGENTS.md/CLAUDE.md file").

## Reconstructed request text

The pasted request arrived with several lines cut off mid-sentence. The readings used
above, so a reviewer can check them against the intent:

- item 3(a): "…+ the keryx block, **regenerated on** `keryx update` and when AGENTS.md changes";
- item 3: "Never write a bare block into AGENTS.override.md — **it would hide/replace** the team's AGENTS.md";
- item 5: "…**check whether the paths are** already ignored", "When a block is still needed, **write** it to `.git/info/exclude`";
- item 6: "**verify with** `git check-ignore`";
- item 7: "write **the block to the local target and remove** the block from the tracked file", "If **the tracked file has unrelated** uncommitted edits…", "(hooks would **fire twice**)";
- item 8: "report a managed block **found in a tracked file as a** warning";
- acceptance: "in a repo **where `AGENTS.override.md` and** `CLAUDE.local.md` are gitignored … no changes to AGENTS.md, CLAUDE.md, .gitignore or **.claude/settings.json**"; "idempotently (**second run changes nothing**)"; "AGENTS.override.md never **written without the** AGENTS.md content".

## Decisions taken where the request left room

- Codex default mode is `override`. The acceptance text expects `AGENTS.override.md` to
  exist and to always carry the `AGENTS.md` content, which only the override mode
  produces; `skip` stays available in config. Keryx never infers the mode: the
  manifest entry states it.
- Default scope for entries created by `init` and by migrating the old string array is
  `local`. `shared` remains a supported, explicit opt-in that keeps today's behaviour
  for a team that wants the block committed.

## Outcome criteria

- After `keryx init` and `keryx update` in a consumer repo, `git status --porcelain`
  lists none of `AGENTS.md`, `CLAUDE.md`, `.gitignore`, `.claude/settings.json`, so
  `git pull` on upstream entrypoint changes no longer refuses.

## Out of Scope

- Local, additive instruction files for Codex beyond the two modes above (blocked
  upstream on openai/codex#26957).
- Moving hook/config files of non-Claude runtimes (Codex, opencode, Cursor, Grok, Zed)
  to local variants.
- Changing what the index block says beyond the wording that names its host file.
- Re-homing user-authored content that lives outside the managed markers.

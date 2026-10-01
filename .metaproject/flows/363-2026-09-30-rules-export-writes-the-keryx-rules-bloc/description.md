# rules-export writes the keryx:rules block to the per-developer targets (CLAUDE.local.md, AGENTS.override.md) instead of tracked CLAUDE.md/AGENTS.md

Status: formalized
Source: owner request 2026-10-01 — the follow-up flow 361 left open ("the opt-in `rules-export` block still writes tracked CLAUDE.md/AGENTS.md").

## Problem

Flow 361 (0.3.45) moved keryx's `keryx:index` block, its ignore block and its Claude hooks out of the files a team tracks. One writer was left behind: the opt-in `rules-export` surface (`keryx integrations install --surface rules`, and `keryx bundle import --render-for`) still writes its `<!-- keryx:rules --> … <!-- /keryx:rules -->` block into `CLAUDE.md` (Claude) and `AGENTS.md` (Codex) by hard-coded path (`src/integrations/surfaces-rules.ts:177-192`). A developer who opts in gets the same uncommitted edit in a tracked file that 0.3.45 removed everywhere else, with the same `git pull` refusal.

## Expected Outcome

- The Claude and Codex `rules-export` surfaces resolve their target from `agentEntrypoints` in `.metaproject/metaproject.json`, the way the index block does:
  - Claude local → `CLAUDE.local.md`; Claude shared → `CLAUDE.md`.
  - Codex local, mode `override` → `AGENTS.override.md`, and the block survives every regeneration of that file; Codex shared → `AGENTS.md`; Codex local, mode `skip`, or no `AGENTS.md` → nothing is written for Codex and the install says so (success with a warning, not a failure).
- `keryx update` migrates: a `keryx:rules` block left as an uncommitted edit in a tracked `CLAUDE.md`/`AGENTS.md` while that runtime's scope is local moves to the local target and the tracked file goes back to its `HEAD` bytes (other uncommitted edits: only the block is removed; committed in `HEAD`: left alone as the team's shared choice, and no duplicate is written locally).
- Install, uninstall, probe/doctor and inspect of the surface all read the same resolved target; install-state records it; the block never exists in both the tracked and the local file.
- `keryx doctor`'s `entrypoints` check warns about an uncommitted `keryx:rules` block in a tracked file whose scope is local.
- Docs and CHANGELOG no longer list `rules-export` as a known limit.

## Decisions (from flow 361, applied unchanged)

- Committed-in-`HEAD` content is the team's shared choice and is not moved (owner decision, flow 361).
- Codex local mode `skip`/no `AGENTS.md` writes nothing for Codex (owner decision, flow 361).

## Outcome criteria

- After `keryx integrations install --runtime claude --surface rules` and `--runtime codex --surface rules` in a repo with default (local) scopes, `git status --porcelain` lists neither `CLAUDE.md` nor `AGENTS.md`.

## Out of Scope

- The other harnesses' rules-export targets (`GEMINI.md`, `.github/copilot-instructions.md`, `.cursor/rules/keryx-rules.mdc`, `.kiro/steering/keryx-rules.md`, `.windsurf/rules/keryx-rules.md`): none has a per-developer counterpart that its tool reads, and the last three are keryx-owned whole files, not team files with an injected block.
- The `keryx:instructions` pointer blocks of other harnesses.

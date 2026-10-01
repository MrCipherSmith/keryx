# Flow 363 review, round 1 — PR #815 at eaac5a3b

Scope: origin/main...HEAD (merge-base 2e489d7f) excluding .metaproject/flows/, 24 files, ~1.4k lines; pre-filter via `keryx review scope`. One reviewer pass (review-logic, tier standard, inherit) plus Wave C (review-verifier). Refuted by the verifier: 0; retained 5 (4 major, 1 minor). External PR comments: 0.

- **F-001 (major, security) — the resolver returns manifest-named files, not only the standard ones.** src/integrations/rules-export-target.ts:88. Verifier: confirmed by execution.
- **F-002 (major) — switching a runtime local to shared drops or strands the installed block.** src/commands/update.ts:804. Verifier: confirmed by execution.
- **F-003 (major) — override regeneration resurrects a block the team removed from AGENTS.md.** src/rules/codex-override.ts:39. Verifier: confirmed by execution.
- **F-004 (major) — a tracked CLAUDE.local.md is written.** src/integrations/rules-export-target.ts:90. Verifier: confirmed by execution.
- **F-005 (minor) — doctor warns with a `keryx update` fix that update never applies.** src/rules/entrypoint-inspection.ts:132. Verifier: confirmed by execution.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/integrations/rules-export-target.ts",
    "quote": "  if (entry.scope === \"shared\" || legacy) return { kind: \"file\", path: teamFile, scope: \"shared\" };",
    "symbol": "resolveRulesExportTarget",
    "problem": "The resolver does not only return the standard files. Under scope shared it returns the manifest's stated `path` verbatim (and for a Codex local entry it returns the stated `source` whenever that file holds a block), constrained only by `safeRelativePath` — so a tracked, cloned `.metaproject/metaproject.json` can point the rules-export write at any file inside the project. Before 0.3.46 this surface wrote only the fixed CLAUDE.md / AGENTS.md.",
    "impact": "A repository whose manifest says `{runtime: \"claude\", scope: \"shared\", path: \".env\"}` makes `keryx integrations install --runtime claude --surface rules` (or `bundle import --render-for claude`) append a keryx:rules block to the developer's gitignored `.env`; `path: \".metaproject/metaproject.json\"` appends markdown to the manifest itself and breaks every later keryx command. `.git/` is refused by writeContained, but nothing else is.",
    "suggested_fix": "Have the resolver only ever return `CLAUDE.md`/`AGENTS.md` (case-insensitive) or the runtime's standard local path; treat any other stated shared path or Codex `source` as `kind: \"none\"` with a warning (or require the stated path to be a known team-file name). Apply the same allow-list where `rulesExportTeamFile` feeds `moveRulesBlocksOutOfTeamFiles` and the doctor inspection.",
    "evidence": "Executed scratchpad/r363/repro.ts (R1) against the PR code in a throwaway repo: manifest claude `{scope:\"shared\", path:\".env\"}` with `.env` gitignored holding `API_KEY=secret` -> installIntegration(root, \"claude\", {surfaces:[\"rules\"]}) returned errors=[] file=.env and `.env` now ends with the `<!-- keryx:rules -->` block; with `path: \".metaproject/metaproject.json\"` the install reported `installed` and the manifest contains the block. `.git/config` was refused (\"refuses to write through a .git directory\").",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/integrations/rules-export-target.ts:88 (shared entry.path / legacy team file returned)",
        "src/integrations/rules-export-target.ts:89 (teamFile = Codex entry.source returned when it holds a block)",
        "src/rules/entrypoint-writers.ts:630 (moveRulesBlocksOutOfTeamFiles writes/restores rulesExportTeamFile(entry))",
        "src/rules/entrypoint-inspection.ts:132 (doctor reads rulesExportTeamFile(entry))",
        "src/rules/entrypoint-writers.ts:176-179 (pre-existing sibling: the index block is written into any existing shared entry.path)"
      ],
      "enumeration_method": "keryx ctx rg \"rulesExportTeamFile\\(|resolveRulesExportTarget\\(|rulesExportRelativePath\\(\" src (non-test): every production caller of the team-file/target helpers, plus the shared-entry branch of writeEntrypointBlocks that consumes the same unconstrained entry.path"
    }
  },
  {
    "id": "F-002",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/commands/update.ts",
    "quote": "  await reinstallRulesExport(projectRoot, movedRulesBlocks, (line) => {",
    "symbol": "reinstallRulesExport",
    "problem": "Only the team-file -> local direction is migrated. Switching a runtime from local to shared (or Codex to mode `skip`) and running `keryx update` goes through `planLocalLeftovers`, which deletes the keryx-generated `AGENTS.override.md` together with the installed keryx:rules block, and strips only the index block from `CLAUDE.local.md`; nothing re-installs the rules-export surface at the new target.",
    "impact": "After a scope switch the Codex block is in neither file (Codex loses the rules index) while install-state still records `AGENTS.override.md`; the Claude block stays in `CLAUDE.local.md` while the resolver now points at `CLAUDE.md`. `keryx integrations doctor` reports the surface `invalid` for both runtimes until the developer re-runs install by hand.",
    "suggested_fix": "In update/init, also record which runtimes had an installed rules-export block in their local target before `writeEntrypointBlocks` runs (planLocalLeftovers' codex `remove` / claude `strip`), and pass them to `reinstallRulesExport` after the manifest is written — or have planLocalLeftovers carry the keryx:rules block to the shared file.",
    "evidence": "Executed scratchpad/r363/repro3.ts: local manifest, writeEntrypointBlocks + installIntegration(rules) for claude and codex -> blocks in CLAUDE.local.md and AGENTS.override.md. Manifest switched to shared, writeEntrypointBlocks again (the writer update runs) -> notices `AGENTS.override.md: removed the keryx-generated override` and `CLAUDE.local.md: removed the managed keryx block`; after: CLAUDE.md=false, CLAUDE.local.md=true, AGENTS.md=false, AGENTS.override.md gone; resolver claude->CLAUDE.md, codex->AGENTS.md; doctorIntegration codex rules-export `live: invalid` with recorded writtenPaths [\"AGENTS.override.md\"].",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/commands/update.ts:804 (reinstall only for movedRulesBlocks)",
        "src/commands/init.ts:804 (same)",
        "src/rules/entrypoint-writers.ts:446-455 (planLocalLeftovers codex: removes the override with the block)",
        "src/rules/entrypoint-writers.ts:459-473 (planLocalLeftovers claude: strips index only, rules block stranded)",
        "src/rules/distill.ts:125 (writeCodexLocalTargets -> same leftovers removal, no reinstall)"
      ],
      "enumeration_method": "keryx ctx rg \"reinstallRulesExport|writeCodexLocalTargets\\(|planLocalLeftovers\" src: every caller that removes local leftovers and every place that re-installs the surface"
    }
  },
  {
    "id": "F-003",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/rules/codex-override.ts",
    "quote": "  const rules = input.previous === undefined || hasManagedRulesBlock(body) ? undefined : extractManagedRulesBlock(input.previous, \"AGENTS.override.md\");",
    "symbol": "renderCodexOverride",
    "problem": "The block to carry is extracted from anywhere in the previous override, including the copied team text. When the team had the rules block committed in AGENTS.md (the shared choice the PR preserves), the override's copy of AGENTS.md contains it; once the team removes it from AGENTS.md, the next regeneration finds it in the old copied body and carries it forward as if it had been installed locally.",
    "impact": "A team-wide uninstall of rules-export (block removed from AGENTS.md and committed) is silently resurrected in every developer's AGENTS.override.md on their next `keryx update` / `rules sync` / `distill`, and persists across every later regeneration; the developer never installed it and install-state has no record of it.",
    "suggested_fix": "Carry only a block that sits in the override's own slot (between the index block end and the copied body), e.g. extract from `previous` minus the previous source body, or only when the previous override's copied body (the part after the index/rules slot) does not itself contain the block.",
    "evidence": "Executed scratchpad/r363/repro2.ts: renderCodexOverride with AGENTS.md content holding a committed rules block -> 1 block (in the copied body); renderCodexOverride again with AGENTS.md without the block and previous = that override -> output still has 1 keryx:rules block, now placed right after the index block.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/rules/codex-override.ts:39 (renderCodexOverride carry)",
        "src/rules/entrypoint-writers.ts:258-264 (the one production caller passing previous)"
      ],
      "enumeration_method": "keryx ctx rg \"renderCodexOverride\\(|writeCodexLocalTargets\\(\" src: one production caller of renderCodexOverride; update, rules sync and distill all reach it through writeCodexLocalTargets"
    }
  },
  {
    "id": "F-004",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/integrations/rules-export-target.ts",
    "quote": "  if (entry.runtime === \"claude\") return { kind: \"file\", path: entry.path, scope: \"local\" };",
    "symbol": "resolveRulesExportTarget",
    "problem": "For Claude with scope local the resolver returns CLAUDE.local.md even when git tracks it. The index-block writer refuses exactly this case (entrypoint-writers.ts:183, review F-011: a tracked local file is the team's) and the migration's `rulesBlockHasLocalTarget` also treats a tracked CLAUDE.local.md as having no local target, so the three disagree.",
    "impact": "In a repository that commits CLAUDE.local.md, `keryx integrations install --runtime claude --surface rules` writes the block into the tracked file, and `git status` shows ` M CLAUDE.local.md` — the uncommitted tracked-file edit this PR exists to remove (AC1).",
    "suggested_fix": "Return `kind: \"none\"` with a warning (mirroring the index writer's notice) when CLAUDE.local.md is tracked, or fall back to CLAUDE.md only under an explicit shared scope; keep resolver, migration and doctor on one predicate.",
    "evidence": "Executed scratchpad/r363/repro.ts (R2): committed CLAUDE.local.md, claude scope local -> resolver {kind:file, path:CLAUDE.local.md, scope:local}; install errors=[] status=installed; `git status --porcelain` -> [\"M CLAUDE.local.md\", ...].",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/integrations/rules-export-target.ts:90 (resolver ignores tracked state)",
        "src/rules/entrypoint-writers.ts:183 (index writer refuses a tracked CLAUDE.local.md)",
        "src/rules/entrypoint-writers.ts:670 (migration treats tracked CLAUDE.local.md as no local target)",
        "src/rules/entrypoint-inspection.ts:131-137 (doctor does not check it at all)"
      ],
      "enumeration_method": "keryx ctx rg \"trackedInGit\" src/rules plus every resolver/inspection branch for claude scope local"
    }
  },
  {
    "id": "F-005",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/rules/entrypoint-inspection.ts",
    "quote": "    if (entry.scope !== \"local\" || (entry.runtime === \"codex\" && entry.mode === \"skip\")) continue;",
    "symbol": "inspectEntrypoints",
    "problem": "`strayRulesBlocks` claims to be `moveRulesBlocksOutOfTeamFiles`'s set but only excludes Codex `skip`; it does not apply `rulesBlockHasLocalTarget`'s other conditions (a Codex override keryx did not generate, a tracked CLAUDE.local.md). doctor then prescribes `keryx update`, which leaves the block where it is, so the warning never clears. The warning also names `CLAUDE.local.md / AGENTS.override.md` for either runtime.",
    "impact": "The cost lands on the developer reading doctor: a warning whose stated fix is a no-op, repeated on every run, with a destination that may name the other runtime's file.",
    "suggested_fix": "Share one predicate (export `rulesBlockHasLocalTarget` or a sync equivalent) between inspection and migration, and name only the owning runtime's local target in the message.",
    "evidence": "Executed scratchpad/r363/repro.ts (R3/R3b): foreign AGENTS.override.md + uncommitted rules block in AGENTS.md -> moveRulesBlocksOutOfTeamFiles returned [] and AGENTS.md stays ` M`, checkEntrypoints warns `AGENTS.md carries the rules-export keryx:rules block ... belongs in CLAUDE.local.md / AGENTS.override.md` with fix `keryx update`; same with a tracked CLAUDE.local.md and a block in CLAUDE.md.",
    "confidence": "high"
  }
]
```

# Flow 363 review, round 2 — verification only, PR #815 at 2fcf094a

Scope: verification of round 1 (2026-10-01-ingest-main, F-001…F-005 at eaac5a3b) at the PR head 2fcf094a8555d2c5d0f749e513ec4cb9b8f73241, which contains the fix commit e85647b6. No new reviewer fan-out. F-006 is the defect the end-to-end check found after round 1 (Codex rules surface install/uninstall stripping the block from the team-file copy inside AGENTS.override.md), recorded here with its fix. Every finding was re-run by review-verifier (scratchpad r363/verify/v2.ts, round 1's v.ts adapted to the fix's renamed APIs, against the head's src/) and the fix commit's regression test files (149 pass, 0 fail).

- **F-001 (major, security) — the resolver returned manifest-named files, not only the standard ones.** Verifier: refuted by execution.
- **F-002 (major) — switching a runtime local to shared dropped or stranded the installed block.** Verifier: refuted by execution.
- **F-003 (major) — override regeneration resurrected a block the team removed from AGENTS.md.** Verifier: refuted by execution.
- **F-004 (major) — a tracked CLAUDE.local.md was written.** Verifier: refuted by execution.
- **F-005 (minor) — doctor warned with a `keryx update` fix that update never applies.** Verifier: refuted by execution.
- **F-006 (major) — installing/uninstalling the Codex rules surface into a team AGENTS.md that commits the block stripped the block from the override's copy of AGENTS.md.** Verifier: refuted by execution.

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "2026-10-01-ingest-main#F-001",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/integrations/rules-export-target.ts",
    "quote": "  if (entry.scope === \"shared\" || legacy) return { kind: \"file\", path: teamFile, scope: \"shared\" };",
    "symbol": "resolveRulesExportTarget",
    "problem": "The resolver did not only return the standard files. Under scope shared it returned the manifest's stated `path` verbatim (and for a Codex local entry the stated `source` whenever that file held a block), constrained only by `safeRelativePath` — so a tracked, cloned `.metaproject/metaproject.json` could point the rules-export write at any file inside the project.",
    "impact": "A manifest saying `{runtime: \"claude\", scope: \"shared\", path: \".env\"}` made `keryx integrations install --runtime claude --surface rules` append a keryx:rules block to the developer's gitignored `.env`; `path: \".metaproject/metaproject.json\"` broke every later keryx command.",
    "suggested_fix": "Have the resolver only ever return `CLAUDE.md`/`AGENTS.md` or the runtime's standard local path; treat any other stated path as `kind: \"none\"`. Apply the same allow-list to the team-file helpers and the index-block writer.",
    "evidence": "Round 1: scratchpad/r363/repro.ts (R1) and verify/v.ts (f1) wrote the block into a gitignored config/local.yaml and into package.json via a Codex source. Fixed in e85647b6 (normalizeEntrypointTargets turns non-standard paths into junk; resolveRulesExportTarget allow-lists isTeamFileOf/isLocalFileOf); re-run at PR head 2fcf094a refutes it.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/integrations/rules-export-target.ts resolveRulesExportTarget / resolveFromEntrypoints (shared entry.path, legacy team file, Codex source)",
        "src/rules/entrypoint-targets.ts normalizeEntrypointTargets (manifest paths normalised to standard files)",
        "src/rules/entrypoint-writers.ts moveRulesBlocksOutOfTeamFiles (rulesExportTeamFile)",
        "src/rules/entrypoint-inspection.ts inspectEntrypoints (rulesExportTeamFile)",
        "src/rules/entrypoint-writers.ts writeEntrypointBlocks shared-entry branch (index block into entry.path)"
      ],
      "enumeration_method": "keryx ctx rg \"rulesExportTeamFile\\(|resolveRulesExportTarget\\(|rulesExportRelativePath\\(\" src (non-test): every production caller of the team-file/target helpers, plus the shared-entry branch of writeEntrypointBlocks that consumes entry.path"
    }
  },
  {
    "id": "F-002",
    "global_id": "2026-10-01-ingest-main#F-002",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/commands/update.ts",
    "quote": "  await reinstallRulesExport(projectRoot, movedRulesBlocks, (line) => {",
    "symbol": "reinstallRulesExport",
    "problem": "Only the team-file -> local direction was migrated. Switching a runtime from local to shared and running `keryx update` deleted the keryx-generated `AGENTS.override.md` with the installed block and left the Claude block in `CLAUDE.local.md`; nothing re-installed the surface at the new target.",
    "impact": "After a scope switch Codex lost the rules index and the Claude block was stranded; `keryx integrations doctor` reported the surface `invalid` for both runtimes until a manual re-install.",
    "suggested_fix": "Record which runtimes had an installed block in their local target before the writers run, and pass them to `reinstallRulesExport` after the manifest is written.",
    "evidence": "Round 1: scratchpad/r363/repro3.ts and verify/v.ts (f2): moved=[], CLAUDE.md no block, CLAUDE.local.md kept it, AGENTS.override.md removed, doctor rules-export live invalid for both. Fixed in e85647b6 (rulesBlocksLeavingLocalTargets in update.ts and init.ts feeds reinstallRulesExport); re-run at PR head 2fcf094a refutes it.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/commands/update.ts refreshServiceFiles (movedRulesBlocks + rulesBlocksLeavingLocalTargets -> reinstallRulesExport)",
        "src/commands/init.ts initCommand (same)",
        "src/rules/entrypoint-writers.ts planLocalLeftovers codex (removes the override with the block)",
        "src/rules/entrypoint-writers.ts planLocalLeftovers claude (strips the local file)",
        "src/rules/distill.ts writeCodexLocalTargets (same leftovers removal)"
      ],
      "enumeration_method": "keryx ctx rg \"reinstallRulesExport|writeCodexLocalTargets\\(|planLocalLeftovers|rulesBlocksLeavingLocalTargets\" src: every caller that removes local leftovers and every place that re-installs the surface"
    }
  },
  {
    "id": "F-003",
    "global_id": "2026-10-01-ingest-main#F-003",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/rules/codex-override.ts",
    "quote": "  const rules = input.previous === undefined || hasManagedRulesBlock(body) ? undefined : extractManagedRulesBlock(input.previous, \"AGENTS.override.md\");",
    "symbol": "renderCodexOverride",
    "problem": "The block to carry was extracted from anywhere in the previous override, including the copied team text, so a block the team removed from AGENTS.md came back from the old copy on the next regeneration.",
    "impact": "A team-wide uninstall of rules-export was silently resurrected in every developer's AGENTS.override.md on their next `keryx update` / `rules sync` / `distill`, with no install-state record.",
    "suggested_fix": "Carry only a block that sits in the override's own slot (right after the index block, ahead of the copied body).",
    "evidence": "Round 1: scratchpad/r363/repro2.ts and verify/v.ts (f3): v1 blocks=1, v2 (team removed it) blocks=1 with 'rule from team', v3 blocks=1. Fixed in e85647b6 (overrideRulesSlot: only keryx's own slot is carried); re-run at PR head 2fcf094a refutes it.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/rules/codex-override.ts renderCodexOverride (carry) and overrideRulesSlot",
        "src/rules/entrypoint-writers.ts writeCodexLocalTargets (the one production caller passing previous)"
      ],
      "enumeration_method": "keryx ctx rg \"renderCodexOverride\\(|writeCodexLocalTargets\\(\" src: one production caller of renderCodexOverride; update, rules sync and distill all reach it through writeCodexLocalTargets"
    }
  },
  {
    "id": "F-004",
    "global_id": "2026-10-01-ingest-main#F-004",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/integrations/rules-export-target.ts",
    "quote": "  if (entry.runtime === \"claude\") return { kind: \"file\", path: entry.path, scope: \"local\" };",
    "symbol": "resolveRulesExportTarget",
    "problem": "For Claude with scope local the resolver returned CLAUDE.local.md even when git tracks it, while the index-block writer and the migration both refuse a tracked CLAUDE.local.md.",
    "impact": "In a repository that commits CLAUDE.local.md, installing the Claude rules surface left ` M CLAUDE.local.md` — the uncommitted tracked-file edit the PR exists to remove (AC1).",
    "suggested_fix": "Return `kind: \"none\"` with a warning when CLAUDE.local.md is tracked; keep resolver, migration and doctor on one predicate.",
    "evidence": "Round 1: scratchpad/r363/repro.ts (R2) and verify/v.ts (f4): resolver {kind:file,path:CLAUDE.local.md}, install status=installed, git status 'M CLAUDE.local.md'. Fixed in e85647b6 (trackedInGitSync check in resolveFromEntrypoints); re-run at PR head 2fcf094a refutes it.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/integrations/rules-export-target.ts resolveFromEntrypoints claude local branch",
        "src/rules/entrypoint-writers.ts writeEntrypointBlocks tracked CLAUDE.local.md refusal",
        "src/rules/entrypoint-writers.ts rulesBlockLocalTargetGap (migration)",
        "src/rules/entrypoint-inspection.ts inspectEntrypoints strayRulesBlocks"
      ],
      "enumeration_method": "keryx ctx rg \"trackedInGit\" src/rules src/integrations plus every resolver/inspection branch for claude scope local"
    }
  },
  {
    "id": "F-005",
    "global_id": "2026-10-01-ingest-main#F-005",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/rules/entrypoint-inspection.ts",
    "quote": "    if (entry.scope !== \"local\" || (entry.runtime === \"codex\" && entry.mode === \"skip\")) continue;",
    "symbol": "inspectEntrypoints",
    "problem": "`strayRulesBlocks` did not apply the migration's other conditions (a Codex override keryx did not generate, a tracked CLAUDE.local.md), so doctor prescribed `keryx update`, which leaves the block where it is, and named both runtimes' local files.",
    "impact": "A doctor warning whose stated fix is a no-op, repeated on every run.",
    "suggested_fix": "Share one predicate between inspection and migration, and name only the owning runtime's local target and the fix that actually clears the warning.",
    "evidence": "Round 1: scratchpad/r363/repro.ts (R3/R3b) and verify/v.ts (f5): foreign AGENTS.override.md + uncommitted block in AGENTS.md -> moved=[] and doctor fix 'keryx update'. Fixed in e85647b6 (rulesBlockLocalTargetGap shared with the migration; doctor names the kept reason and its real fix); re-run at PR head 2fcf094a refutes it."
    ,
    "confidence": "high"
  },
  {
    "id": "F-006",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/integrations/surfaces-rules.ts",
    "quote": "async function removeFromOtherCandidate(root: string, runtime: EntrypointRuntime, written: string): Promise<string[]> {",
    "symbol": "removeFromOtherCandidate",
    "problem": "When the team's AGENTS.md commits the keryx:rules block, the Codex rules surface resolves to AGENTS.md (shared). After installing or uninstalling there, removeFromOtherCandidate inspected the whole AGENTS.override.md with inspectRulesExport and, finding the block in the override's verbatim copy of AGENTS.md, removed it with uninstallMarkdownBlock — editing the team text inside the keryx-generated override.",
    "impact": "Codex reads AGENTS.override.md instead of AGENTS.md, so a developer who ran `keryx integrations install|uninstall --runtime codex --surface rules` lost the team's committed rules index from what Codex actually reads, while AGENTS.md still carried it; the override no longer matched its source copy.",
    "suggested_fix": "For Codex, treat only keryx's own slot in a keryx-generated override (right after the index block) as a stray local copy, and remove only that slot; never edit the copied team text.",
    "evidence": "End-to-end check after round 1 (scratchpad/t363 scenario s5c, state in t363/s5c-override-after-install.md): after installing the Codex rules surface into a team AGENTS.md committing the block, the override's copy of AGENTS.md no longer held the block. Fixed in e85647b6 (strayLocalCopy + uninstallFromOverride work on overrideRulesSlot only); re-run at PR head 2fcf094a refutes it.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/integrations/surfaces-rules.ts:272 installEntrypointRulesExport -> removeFromOtherCandidate",
        "src/integrations/surfaces-rules.ts:353 uninstallEntrypointRulesExport -> removeFromOtherCandidate",
        "src/integrations/surfaces-rules.ts:365 strayLocalCopy (Codex: inspectOverrideSlot only)",
        "src/integrations/surfaces-rules.ts:378 removeFromOtherCandidate (Codex: uninstallFromOverride)",
        "src/integrations/surfaces-rules.ts:233 dryRunWarnings and :241 dryRunUninstallExtras (same strayLocalCopy predicate)"
      ],
      "enumeration_method": "keryx ctx rg \"removeFromOtherCandidate|strayLocalCopy|withoutOverrideRulesSlot|overrideRulesSlot\" src: every caller that removes or reports a rules block in the runtime's local file"
    }
  }
]
```

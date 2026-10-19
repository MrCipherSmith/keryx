# Module src/gdskills/governance

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/gdskills/governance` is the set of quality gates for skills in the catalog: `scout` (dedupe before a skill is created), `eval` (trigger accuracy and behavior scenarios), `stocktake` (periodic keep/improve/update/retire/merge verdicts) and `authoring-lint`, all scored against one shared catalog loader. It groups 16 file(s), depends on `src/gdskills`, `src/lib` and `src/bundle`, and exposes 20 public symbol(s).

## Overview

`src/gdskills/governance` decides whether a skill in the catalog is fit to ship, reuse or keep. It holds the four gates that answer that question: `scout.ts` for pre-creation dedupe, `eval.ts` for trigger and behavior compliance, `stocktake.ts` for periodic health verdicts, and `authoring-lint.ts` for the authoring standard as a runnable check. Every gate loads its skills through the same `catalog-index.ts` loader, so they never disagree about what the catalog contains. Trigger scoring is deterministic and offline; behavior scenarios and judge-graded answers run only when a caller injects a runner or judge.

## How it works

The module has four layers. At the bottom, `catalog-index.ts` walks the bundled skill tree (`skills/**` and `stacks/*/skills/**`) and, for scope `"all"`, the project's installed mirror and project-skills. It returns `CatalogEntry` values carrying the body, a content `sha256` and `metadata.origin`, sorted by id with first-writer-wins dedupe; unreadable files are collected as diagnostics instead of aborting the walk.

The scoring core is `scout.ts`. `rankCatalog` scores query coverage, not set overlap: each stemmed query token that an entry contains adds its IDF weight, and the entry's own length does not dilute the score. `stripExclusionClauses` removes "NOT for X (use Y)" text from entries so a disclaimer does not count as positive evidence. `checkSkillSelected` and `checkSkillSelectedLeaveOneOut` are the shared trigger grader, and both `eval` and `stocktake` call them so the two gates cannot disagree about what "this prompt selects this skill" means.

The gates sit on that core. `eval.ts` (`evalSkill`) separates trigger accuracy, which is one deterministic scoring call per prompt, from behavior scenarios, which need a runner and are repeated per trial. Its evidence flag is `"authored"` only when `evals.json` supplies both sides of the trigger set, and a synthesized-only report can never carry verdict `"pass"`. `stocktake.ts` (`runStocktake`) applies a fixed verdict precedence (lint errors, then overlap, then stale verification, then retirement, then trigger accuracy) and caches each entry under a key that covers its own hash, the catalog fingerprint, its verification report and its `references/` files.

`judge.ts` is a leaf module with no provider code. It builds the judge prompt, wraps the untrusted task prompt and answer in content-hashed boundary tags, parses the judge's strict JSON reply, and grades one answer through `gradeScenarioAnswer`, which combines deterministic expectations with the injected `Judge`. `eval.ts` validates each `evals.json` once on load (`validateEvalSpec`) and throws `EvalSpecError` on a malformed grader, so a typo cannot silently pass every trial.

## Key concepts

- **Catalog entry (`CatalogEntry`)**: one `SKILL.md`, identified by `${category}/${name}`. Its `sha256` is the content identity used by caches and digests.
- **Selection**: a prompt selects a skill when the skill's coverage score clears `SCOUT_FORK_THRESHOLD` (0.3) and no entry from a different category strictly outscores it. A synthesized positive must also clear `DESCRIPTION_SUPPORT_THRESHOLD` (0.12) on the skill's own name and description.
- **Scout decision**: `use`, `fork` or `create`, from the top score against `SCOUT_USE_THRESHOLD` (0.55) and the fork threshold. A non-`create` record in `governance/scout.json` must carry a non-empty `justification`.
- **Evidence and verdict**: `EvalReport` is `authored` or `synthesized` and its verdict is `pass`, `fail` or `incomplete`. `incomplete` covers scenarios that were not run or were skipped.
- **Strictness**: `high` requires at least three trials, enforced as `EvalContractError`. Trigger scenarios always report one deterministic trial regardless of the requested count.
- **Judge expectation and calibration**: a scenario carries at most one `judge` expectation with a rubric and pass/fail criteria. Its `calibration` supplies `known_right`, `known_wrong`, `vague` and `subtle_wrong` answers, which the anti-gaming harness (`antiGamingAnswers`) uses to check that the judge rejects gaming.
- **Stocktake verdict**: `keep`, `improve`, `update`, `retire` or `merge`. Each reason starts with the skill's own id, and `tagDuplicateReasons` tags, rather than throws on, reasons that collide once ids are stripped.

## Main flows

1. **Scout a candidate skill.** `scoutSkill(query, catalog, { excludeIds })` ranks the catalog with the query's own exclusion clauses stripped, keeps the top five matches and returns a `use`, `fork` or `create` decision. `scoutImports` runs the same scorer over external imports, but only those that re-verify as `ok`. `auditSkillSnapshot` vets a candidate directory by reading its bytes once (`collectSkillDirectorySnapshot` refuses symlinks and special files), staging those exact bytes and running the security audit harness over them.

2. **Evaluate a skill.** `evalSkill(skillId, catalog, options)` reads and validates the skill's `evals.json` (`readEvalSpec`), then calls `scoreTriggerScenarios`. Authored prompts are scored with full scoring, and synthesized positives with leave-one-out. Each behavior scenario is `not-run` without a runner, `skipped` when it needs a judge or model grader that was not supplied, and otherwise runs `runBehaviorTrials`: one runner call per trial, graded by `gradeScenarioAnswer`. The verdict is derived from the results and checked by `validateEvalReport` before the report is returned.

3. **Run a stocktake.** `runStocktake(root, options)` loads the catalog with diagnostics and, for each entry, checks its cache record against the current key inputs. On a miss, `evaluateEntry` runs lint, scouts the entry against the other skills, checks for a stale verification report and a retired marker, and in a full (non-quick) run checks that the entry's own triggers route back to it. The report is sorted, has duplicate reasons tagged, and is written with the updated cache to a dated file under `.metaproject/data/skills/stocktake/`.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `Strictness`
- `Grader`
- `ExpectedBehavior`
- `EvalScenarioSpec`
- `EvalSpecFile`
- `RunnerOutput`
- `RUNNER_SYSTEM_NOTE`
- `RUNNER_PROMPT_VERSION`
- `Runner`
- `ModelGrader`
- `TrialRecord`
- `EvalScenarioResult`
- `EvalTriggerAccuracy`
- `EvalEvidence`
- `EvalReport`
- `EvalOptions`
- `EvalContractError`
- `EvalSpecError`
- `readSkillEvalSpec`
- `gradeDeterministic`

### Key files

- `src/gdskills/governance/eval.ts` - imported by 12, imports 5
- `src/gdskills/governance/catalog-index.ts` - imported by 14, imports 2
- `src/gdskills/governance/scout.ts` - imported by 8, imports 5
- `src/gdskills/governance/judge.ts` - imported by 12, imports 0
- `src/gdskills/governance/stocktake.ts` - imported by 2, imports 5
- `src/gdskills/governance/authoring-lint.ts` - imported by 4, imports 2

### Depends on

- `src/gdskills` - 6 import(s)
- `src/lib` - 4 import(s)
- `src/bundle` - 1 import(s)
- `src/security/audit-harness` - 1 import(s)

### Depended on by

- `src/commands` - 9 import(s)
- `src/gdskills/governance/__fixtures__` - 3 import(s)
- `src/bundle` - 2 import(s)
- `src/agents` - 1 import(s)

### Dependency basis

- Production imports only: 25 import(s) from test file(s) (e.g. `src/agents/verify.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 16
- Cross-module imports: 12

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/gdskills](src-gdskills.md)
- [Module src/lib](src-lib.md)
- [Module src/bundle](src-bundle.md)
- [Module src/security/audit-harness](src-security-audit-harness.md)
- [Module src/commands](src-commands.md)
- [Module src/agents](src-agents.md)
- `src/gdskills/governance/__fixtures__` (no wiki page)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.

# Flow Journal

- 2026-08-31T08:14:12.199Z - flow created
- 2026-08-31T08:14:39.858Z - frozen: 10 criteria; checksum recorded
- 2026-08-31T08:14:40.339Z - started

## Before / after against the measured baseline (AC8)

The measurement of 2026-08-31 recorded **`task-implementer`: 2 wired of 88**,
with no prior — a new baseline, not an improvement or a regression.

**Reproduced baseline: 7 wired of 109 (6.4%).** The full enumeration, with the
search that classified every row, is in `inventory.md`. Both deltas from the
measurement are stated there rather than smoothed:

- **109 rows, not 88.** `task-request.template.md` (4 rows) was not enumerated by
  the measurement, and three places are split at a finer grain here: the
  `automation` object as six settings, Phase 1.4's five `ASSERT` lines as five
  refusals, and the six `wave-executor` mentions as six claims. No verdict
  changes — every added row was `prose-only`, for the same reason the contracts
  were.
- **7 wired, not 2.** The measurement's two rows are the `STATUS:` contract,
  which this inventory also scores as two. It credits five more that the
  measurement did not: `name` (`src/gdskills/catalog.ts:90`), `model_tier`
  (`src/gdskills/model-tier.ts:768`, guarded by
  `src/gdskills/bundled-eval.ts:602`), §2.0b's `keryx skills route` and
  `keryx skills verify` (`src/gdskills/verify.ts:64`), and
  `subagent_type: "general-purpose"` in `orchestrator-prompt.md`. The correction
  makes the *before* number better and is recorded because that is what
  reproducing a measurement means.

**After: 55 wired of 109 (50%), 0 prose-only, 54 advisory.**

| | before | after |
|---|---:|---:|
| rows | 109 | 109 |
| wired | 7 | 55 |
| prose-only | 64 | **0** |
| advisory | 38 | 54 |

Stated as the measurement states its pairs: **(none) → 2/88** becomes
**7/109 → 55/109**.

The six-phase core — rows 13-66, RECEIVE through REPORT — scored **2 of 54**
before (§2.0b's two commands, and nothing else; the `STATUS:` rows sit outside
the phases) and scores **20 of 54** now.

**Resolution split for the 64 prose-only rows:** **48 wired**, **16 claims
deleted**. Nothing was resolved by softening a verb; the deletions are listed row
by row in `inventory.md` and each is proved by a mutation.

**Test baseline:** `bun test` was **6242 pass / 18 skip / 0 fail** before this
flow. After: **6261 pass / 18 skip / 0 fail** — +19, all of them the new
`src/gdskills/task-implementer-contract.test.ts`. `bun run typecheck` clean;
`bun run test:guards` 173 pass / 0 fail; `bun run check:doc-links` 1138 links
across 397 files, 0 broken.

## Mutations (AC6)

Each fix was broken, a named test was watched go red, and the fix was restored
and re-run green.

| # | mutation | test that went red |
|---|---|---|
| M1 | `task-implementer-input` renamed out of the `CONTRACTS` registry | `task-implementer-contract.test.ts` — "both are registered and resolve to the file that ships with the skill" |
| M2 | validator's `minItems` branch disabled | " — "each ASSERT the skill used to list by hand is now a refusal the schema makes" |
| M3 | validator's `maximum` branch disabled | " — "the repair bound is three in the contract too, not five" |
| M4 | `skill_drift` removed from the output contract | " — "the output contract accepts the result SKILL.md tells the worker to write" |
| M5 | `original_task_ids` reverted to singular | " — "a fix dispatch validates" |
| M6 | `wave-executor` described as real again in the data-flow diagram | " — "no file in the skill package describes `wave-executor` as real" |
| M7 | "Return the JSON result object as your final message" restored | " — "the contradiction about the final message is gone in both directions" |
| M8 | `claude` dropped from `compatible_harnesses` | " — "`compatible_harnesses` names claude, the harness that loads the primary build" |
| M9 | Phase 5 hard-codes `npm run lint` / `npm run type-check` again | " — "Phase 5 calls the commands that detect the toolchain instead of hard-coding npm" |
| M10 | the `keryx job document` call removed from Phase 6.1 | " — "the result file is recorded by the command that refuses when it is missing" |
| M11 | **AC4** — `## Reporting Results` removed from `SKILL.codex.md` | `status-contract.test.ts` — "task-implementer's reporting section is present in all five builds" |
| M12 | **AC7** — one build's title changed so it diverges from `SKILL.md` | `build-parity.test.ts` — "build-parity: every build of an enforced skill matches SKILL.md" |

M1's first run corrupted `src/gdskills/contracts.ts`: the restore step matched a
non-unique anchor and swapped two registry names. It was repaired and M1–M3 and
M5 were re-run with unique anchors, each recording green → RED → green. Recorded
because a mutation harness that can damage the tree it is proving is worth
knowing about.

## What was NOT fixed (AC9)

Eight items, each with its reason, in `inventory.md` § "What this flow did NOT
fix, and why". The two that touch the harness contract, named here so a later
measurement does not have to rediscover them:

1. **`parseChildResult` still binds only harness children.** `task-implementer`
   is dispatched as a host-agent Task, not a harness child, so nothing routes its
   output through the function that throws on a bad STATUS line. AC4's
   requirement — that the contract stays enforced and present in all five builds
   — is met and re-pinned; widening the function's reach is a harness change.
2. **`ROLLBACK POLICY: git reset --hard` is unchanged and is a real hazard.** It
   is an instruction to the model, so it classifies `advisory` and AC3 does not
   reach it — but it is unscoped and runs on a *shared* feature branch, putting a
   wave-mate's uncommitted work in its blast radius. The correct form is a
   path-scoped `git checkout -- <target_files>` or a `git stash`; that is a
   behaviour change and wants its own flow.
- 2026-08-31T10:16:47.859Z - task-done: T1: Collect remaining context
- 2026-08-31T10:16:48.129Z - task-done: T2: Implement per plan
- 2026-08-31T10:16:48.447Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-31T10:16:48.735Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-31T10:17:07.252Z - ac-confirmed: AC1: inventory.md enumerates 109 mechanisms with section, quoted claim and the search that classified each — the Phase 7 method applied to task-implementer.
- 2026-08-31T10:17:07.537Z - ac-confirmed: AC2: wired requires a production file:line and the entry point; a test-only call site counts as prose-only. That rule is why the before-number is 7 and it was not relaxed.
- 2026-08-31T10:17:07.814Z - ac-confirmed: AC3: 48 wired, 16 deleted, 0 prose-only remaining. No verb was softened.
- 2026-08-31T10:17:08.117Z - ac-confirmed: AC4: The STATUS: contract is untouched and re-pinned in all five builds and both trees; status-contract.test.ts still derives its scope from it.
- 2026-08-31T10:17:08.383Z - ac-confirmed: AC5: Eight restatements of existing code found. Five wired: assertions to skills contracts validate, mkdir results to keryx job document, the automation table to the contract object, lint/type-check to keryx health run, npm test to keryx test run. Three named and deliberately not wired with reasons.
- 2026-08-31T10:17:08.671Z - ac-confirmed: AC6: Twelve mutations from the audit plus one for the destructive-git guard, each observed red and restored. One mutation corrupted contracts.ts via a non-unique anchor; repaired and re-run with unique anchors, recorded in the journal.
- 2026-08-31T10:17:08.939Z - ac-confirmed: AC7: All five builds regenerated from SKILL.md and mirrored byte-identical; build-parity and round-bound both green. A stale rules mirror that CI caught was committed separately.
- 2026-08-31T10:17:09.239Z - ac-confirmed: AC8: Before 7 of 109, after 55 of 109; core 2 of 54 to 20 of 54. The measurement's 2-of-88 did not reproduce and the discrepancy is explained in inventory.md rather than smoothed — the correction improves the before-number.
- 2026-08-31T10:17:09.542Z - ac-confirmed: AC9: Named unfixed: agent_worthy/triggers/version have no consumer; the duplicate 4.1 heading; RESEARCH_SUMMARY and CHANGE_PLAN are not artifacts; no code-side stuck detector; task-implementer is still not dispatched by production code; parseChildResult binds only harness children, not host-agent subagents. The ROLLBACK POLICY hazard was named by the audit and fixed rather than carried.
- 2026-08-31T10:17:09.806Z - ac-confirmed: AC10: typecheck clean; bun test 6264 pass / 18 skip / 0 fail against a 6242/0 baseline; test:guards 173/0; check:doc-links 1138 links / 0 broken.
- 2026-08-31T10:17:45.033Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/418 (warning: PR is not a draft)
- 2026-08-31T10:17:45.462Z - completing
- 2026-08-31T10:17:49.258Z - done: all gates passed

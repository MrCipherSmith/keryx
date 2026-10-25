# Implementation Plan

Status: draft; waits for corrected source docpack and explicit freeze approval

## Approach

Chosen: docs-only contract hardening before runtime, then zone-separated core and client/adapter lanes. Rejected wording-only correction because it leaves identity and finalization crash gaps. Rejected transactional store redesign as unnecessary scope. Operator decisions are in operator-decisions.md, not flow-only overrides of the source requirements.

## Steps

1. T5 agent-1 corrects docs/requirements/keryx-learn-probe/ in place; no runtime or commits. Agent-2 independently checks schemas, transitions, examples and acceptance matrix after handoff.
2. Orchestrator folds findings into context, registers atomic runtime tasks/dependencies, writes concrete verification criteria and seeks explicit freeze approval. Do not freeze an unresolved or still-editing contract.
3. Lane A (agent-1): pure scoring, learning evidence schemas/config, core plan/checkpoint/recovery/evidence API and retention. Sole owner of shared src/learning/{types,schema,config,store,paths,prune}.ts and learned-pattern schema updates. Keep apply mapping unchanged.
4. Lane B (agent-2): harness/probe runner and commands/learn-probe adapter consuming A's agreed API. Own worktree/gold checks, turn loop, usage/checkpoints, signals, TTY/budget/JSON/dry-run. No shared learning file edits.
5. A adds learn.ts router dispatch only after B's export exists. Retain no-edge guard for decision modules. Core never imports client or adapter.
6. Each task uses TDD and local failure scenarios; workers return schema-valid results with project_context_applied and RED/GREEN evidence. No live provider requirement in tests.
7. Orchestrator runs independent integration/type/lint/import/schema checks and current impact analysis; accepts only verified results, records failed attempts and redispatches bounded fixes. Never confirm ACs from self-report alone.
8. Ask operator for desired verified handoff/open/PR/completion target. Do not push, publish, merge or complete implicitly.

## Baseline verification

- 2026-10-20: `bun test src/learning/ src/metrics/benchmark.test.ts src/metrics/leakage.test.ts src/harness/child/git-worktree-port.test.ts` exited 0: 461 pass, 0 fail, 1081 expects, 29 files. Existing-behavior baseline, NOT probe verification. The named worktree-port test does not exist and was not exercised; add runner tests rather than claiming existing coverage.
- Retained session log: tool-output/1792526465867-b8441c8e-call_287a4f2c7c0c457b99dce9e232a9360d.txt.
- Runtime commands will use working-tree `bun ./src/cli.ts`, not the potentially stale installed binary.

## Risks

- Unrelated dirty checkout: no stash/reset or broad staging. Respect shared-file ownership.
- Graph reports moved checkout/new paths; refresh authoritative impact checks. Old health snapshot is not a current gate.
- Pattern mutations and crashes require the publication cut-off, immutable comparison and separate durable evidence outcome.
- Resume must not lose spend, duplicate evidence or rerun completed seeds. Unknown usage/pricing must not silently become zero.
- Keep historical review dispositions explicit, not automatic adoption of all recommendations.

## State × event matrix (draft, reconcile with corrected docpack)

| Durable state | Retry / resume | Pattern text/status drift | Failure / interruption | Observable result / AC |
|---|---|---|---|---|
| No artifacts, invalid input | Fix input before execution | Ineligible record refuses | No writes | reason + exit 2; AC2–4 |
| Immutable plan + partial checkpoint | Match identity/environment; reuse completed seeds and spend | Before publication: unmeasurable/environment-drift, no evidence | Preserve real completed runs and usage; clean worktrees | comparison null aggregates for failures; AC11–13,17–18 |
| All seeds durable, no comparison | Score without rerunning seeds | Recheck before publication | Retry publication from checkpoint | one immutable comparison; AC10,14 |
| Comparison published, evidence undecided | Locked dedup/recheck, no model rerun or rewrite | Skip evidence; persist skipped/environment-drift outcome | Retry finalization only | comparison unchanged; outcome separate, exit 3 on recorded skip; AC14–15 |
| Evidence committed, checkpoint not finalized | sourceRef dedup recognizes prior update | Already committed evidence is not applied twice or undone | Recover marker only | confidence updated exactly once; AC6,14 |
| Fully finalized | Refuse already-completed; no writes | No change | No change | exit 2; AC16 |
| Completed and retention-eligible | Measurements/evidence remain auditable | No change | Delete only eligible old runs/ | plan/comparison/checkpoint retained; AC19 |

This matrix covers durable probe state, not UI. No runtime behavior may be added by a worker merely because a cell was omitted; surface unresolved tradeoffs before acceptance.

# Implementation Plan

Status: draft; corrected docpack inherited; migrated-package review and explicit freeze pending

## Approach

Chosen: docs-only contract hardening before runtime, then zone-separated core and client/adapter lanes. Rejected wording-only correction because it leaves identity and finalization crash gaps. Rejected transactional store redesign as unnecessary scope. Operator decisions are in operator-decisions.md, not flow-only overrides of the source requirements.

## Steps

1. T5/T6 correction and review evidence are inherited from flow 469, not re-executed. T1 includes fresh independent review of the migrated flow 470 package before freeze.
2. Orchestrator folds findings into context, registers atomic runtime tasks/dependencies, writes concrete verification criteria and seeks explicit freeze approval. Do not freeze an unresolved or still-editing contract.
3. Lane A (agent-1): pure scoring, learning evidence schemas/config, core plan/checkpoint/recovery/evidence API and retention. Sole owner of shared src/learning/{types,schema,config,store,paths,prune}.ts and learned-pattern schema updates. Keep apply mapping unchanged.
4. Lane B (agent-2): harness/probe runner and commands/learn-probe adapter consuming A's agreed API. Own worktree/gold checks, turn loop, usage/checkpoints, signals, TTY/budget/JSON/dry-run. No shared learning file edits.
5. A adds learn.ts router dispatch only after B's export exists. Retain no-edge guard for decision modules. Core never imports client or adapter.
6. Each task uses TDD and local failure scenarios; workers return schema-valid results with project_context_applied and RED/GREEN evidence. No live provider requirement in tests.
7. Orchestrator runs independent integration/type/lint/import/schema checks and current impact analysis; accepts only verified results, records failed attempts and redispatches bounded fixes. Never confirm ACs from self-report alone.
8. Delivery target selected by operator: draft PR to main → review → merge → release → operator manual testing. Publish, merge and release require separate approvals. Do not complete implicitly.

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
| Immutable plan + partial checkpoint | Match identity/environment; reuse completed seeds and spend | Before publication: unmeasurable/environment-drift, no evidence | Preserve real completed runs, available failed/interrupted audit and usage; clean worktrees | comparison null aggregates for failures; AC11–13,17–18 |
| All seeds durable, no comparison | Score without rerunning seeds | Recheck before publication | Retry publication from checkpoint | one immutable comparison; AC10,14 |
| Comparison published, evidence undecided | Locked dedup/recheck, no model rerun or rewrite | Skip evidence; persist skipped/environment-drift outcome | Retry finalization only | comparison unchanged; outcome separate, exit 3 on recorded skip; AC14–15 |
| Evidence committed, checkpoint not finalized | sourceRef dedup recognizes prior update | Already committed evidence is not applied twice or undone | Recover marker only | confidence updated exactly once; AC6,14 |
| Fully finalized | Refuse already-completed; no writes | No change | No change | exit 2; AC16 |
| Completed and retention-eligible | Measurements/evidence remain auditable | No change | Delete only eligible old runs/ | plan/comparison/checkpoint retained; AC19 |

This matrix covers durable probe state, not UI. No runtime behavior may be added by a worker merely because a cell was omitted; surface unresolved tradeoffs before acceptance.

## Registered execution order

T1 migration/review → explicit freeze/start → T7 scoring and T8 schemas/config (agent-1) → T9 core/recovery (agent-1) → T10 runner and T11 CLI (agent-2) → T12 integration (agent-1) → T13 independent quality/AC gate → T14 verified documentation → T4 independent managed review/draft PR. Task dependencies are authoritative in flow.json. No runtime task starts merely because inherited T6 is closed.

## Prefreeze review dispositions

- AC19/T12 require the probes-root managed-ignore entry and guard using git-common-dir/info/exclude, preserving the existing no-tracked-.gitignore-write init/update contract selected by the operator.
- AC14/T9 require crash injection at every plan/checkpoint/comparison/record/marker write boundary and concurrent invocations, proving one evidence/confidence application and preservation of unrelated writes.
- AC18/T10 require reconciliation of stale owned worktrees after uncatchable death before creating new ones; unrelated worktrees must survive.
- T7/T8 require both T1 and inherited T6; CLI repair is completed and independently verified. T13 independently verifies these obligations, not worker self-report.
- State matrix refinement: at every partial durable state, injected write failure preserves recoverable prior artifacts; concurrent invocations serialize through probe then scope locks. A matching resume reconciles only owned stale worktrees before new work (AC14, AC18).

# Review Scope

target: pr
ref: 421
mode: attach-review
flow: 202 (explicit-flow-id)
created_at: 2026-08-31T11:55:57.469Z
context_mode: light

## Stage counts

Stated as counts, never as a precision figure: no precision baseline
exists to improve on (see the flow's baseline.md — 53/53 = 100% by
construction, refused as a baseline).

### Dropped by the pre-filter

not recorded — no pre-filter scope was supplied to this package.
This is NOT `dropped 0`: nothing ran, so nothing is known.

### Refuted by the verifier

verification_mode: annotate
claims_received: 0
claims_applied: 0
claims_rejected: 0
verdicts_capped_to_unverifiable: 0
confirmed: 0
refuted: 0
unverifiable: 0
unverified: 0

### Retained

findings_in: 0
findings_removed_by_verifier: 0
findings_retained: 0

### Verification claims discarded

_none_


## Caps

Each cap says what it removed, deferred or stopped, with a count. An
absent cap prints `not recorded`, never `0`: a cap that never ran and a
cap that dropped nothing are different facts.

### Findings cap

limit_per_reviewer: 10
findings_seen: 0
findings_retained: 0
findings_truncated: 0
blockers_exempt: 0
reviewers_truncated: 0

_the findings cap ran and truncated nothing_

### Spend ceiling

not recorded — no spend ceiling was evaluated for this package.

### Concurrency cap

not recorded — no dispatch plan was supplied for this package.

## Scope B rejections

not recorded — no blast-radius record reached this ingest, so the scope-B screen
did not run. No finding in this package was raised under scope B; had one been,
the ingest would have been refused rather than recorded unscreened.

## filter_stats

The machine-readable copy is `filter_stats` in `manifest.json`; this block is
rendered from the same record, never re-parsed out of the prose above.
`null` means the stage did not run. It never means `0`.

total: 0
dropped_prefilter: null — no `--scope` was supplied to this ingest. Nothing ran, so nothing is known — this is NOT `dropped 0`.
dropped_low_confidence: null — this pipeline has no confidence threshold: `confidence` is recorded on every finding and no stage filters on it. The field is declared because the roadmap names it, and reports `null` so that a threshold added later cannot be mistaken for one that had always dropped nothing.
dropped_refuted: 0
dropped_scope_b: null — no blast-radius record reached this ingest, so the scope-B screen did not run. `rejected: 0` after a screen that ran is a different fact, and the record keeps them apart.
dropped_findings_cap: 0
dismissed_by_round: null — the round recorded no dismissals channel (`--refuted` was not supplied). This is NOT `dismissed 0`: what survives to findings.json is then the survivors of an unlogged triage, which is why measuring such a corpus returns 100% precision by construction.
retained: 0

### by_reason

_no drop was attributed to a reason; every stage that ran removed nothing_

`dropped_prefilter` counts diff material — whole files and change blocks removed
before any reviewer read them. Every other count is findings, and only those are
summed against `retained`.

## Pre-filter scope

mode: diff
context_lines: 20
files_seen: 100
files_retained: 100
files_dropped: 0
blocks_seen: 288
blocks_retained: 288
blocks_dropped: 0
changed_lines_retained: 4210
changed_lines_dropped: 0

### Retained

| file | lines | changed | context |
|---|---|---|---|
| .metaproject/data/gdgraph/.provenance.json | 1-5 | 6 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/data/gdgraph/artifacts/module-map.json | 26-66 | 1 | 20 |
| .metaproject/data/gdgraph/artifacts/module-map.json | 100-204 | 12 | 20 |
| .metaproject/data/gdgraph/artifacts/module-map.json | 208-347 | 25 | 20 |
| .metaproject/data/gdgraph/artifacts/module-map.json | 403-502 | 6 | 20 |
| .metaproject/data/gdgraph/artifacts/module-map.json | 522-573 | 2 | 20 |
| .metaproject/data/gdgraph/artifacts/module-map.json | 591-699 | 13 | 20 |
| .metaproject/data/gdgraph/artifacts/module-map.json | 809-979 | 36 | 20 |
| .metaproject/data/gdgraph/artifacts/module-map.json | 1003-1090 | 27 | 20 |
| .metaproject/data/gdgraph/artifacts/summary.md | 1-73 | 45 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/data/testing/context.json | 1-38 | 4 | 20 |
| .metaproject/data/testing/context.json | 44-193 | 30 | 20 |
| .metaproject/data/testing/context.json | 199-360 | 11 | 20 |
| .metaproject/data/testing/context.json | 385-523 | 25 | 20 |
| .metaproject/data/testing/context.md | 1-33 | 4 | 20 |
| .metaproject/data/testing/context.md | 40-124 | 24 | 20 |
| .metaproject/data/testing/recommendations.md | 1-5 | 2 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/acceptance-criteria.md | 1-26 | 26 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/artifacts/code-verification.md | 1-20 | 20 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/artifacts/draft-pr.md | 1-30 | 30 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/artifacts/full-suite-baseline-comparison.md | 1-38 | 38 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/artifacts/review-architecture.md | 1-10 | 10 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/artifacts/review-security.md | 1-13 | 13 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/context.md | 1-45 | 45 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/description.md | 1-20 | 20 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/dispatches/202-ARCH-B.json | 1-34 | 34 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/dispatches/202-ARCH-TESTS.json | 1-32 | 32 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/dispatches/202-ARCH.json | 1-38 | 38 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/dispatches/202-CATCH-A.json | 1-34 | 34 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/dispatches/202-CATCH-B.json | 1-34 | 34 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/dispatches/202-CATCH-GREEN.json | 1-30 | 30 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/dispatches/202-DOCS.json | 1-31 | 31 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/dispatches/202-FIX-FLEET-TEST.json | 1-29 | 29 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/dispatches/202-HEALTH-FIX.json | 1-31 | 31 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/dispatches/202-REVIEW-ARCH.json | 1-36 | 36 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/dispatches/202-REVIEW-SECURITY.json | 1-36 | 36 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/dispatches/202-SECURITY.json | 1-36 | 36 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/dispatches/202-VERIFY-FINAL.json | 1-38 | 38 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/flow.json | 1-515 | 515 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/journal.md | 1-44 | 44 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/metrics/run-2026-08-26T06-06-15Z.md | 1-93 | 93 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/plan.md | 1-23 | 23 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/reviews/2026-08-26-branch-fix-full-project-review-remediation-2026/coverage.md | 1-10 | 10 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/reviews/2026-08-26-branch-fix-full-project-review-remediation-2026/decisions.md | 1-6 | 6 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/reviews/2026-08-26-branch-fix-full-project-review-remediation-2026/findings.json | 1-1 | 1 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/reviews/2026-08-26-branch-fix-full-project-review-remediation-2026/learning.md | 1-9 | 9 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/reviews/2026-08-26-branch-fix-full-project-review-remediation-2026/manifest.json | 1-31 | 31 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/reviews/2026-08-26-branch-fix-full-project-review-remediation-2026/report.md | 1-42 | 42 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/reviews/2026-08-26-branch-fix-full-project-review-remediation-2026/scope.md | 1-8 | 8 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/reviews/2026-08-26-ingest-fix-full-project-review-remediation-2026/coverage.md | 1-5 | 5 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/reviews/2026-08-26-ingest-fix-full-project-review-remediation-2026/decisions.md | 1-3 | 3 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/reviews/2026-08-26-ingest-fix-full-project-review-remediation-2026/findings.json | 1-1 | 1 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/reviews/2026-08-26-ingest-fix-full-project-review-remediation-2026/learning.md | 1-5 | 5 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/reviews/2026-08-26-ingest-fix-full-project-review-remediation-2026/manifest.json | 1-31 | 31 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/reviews/2026-08-26-ingest-fix-full-project-review-remediation-2026/report.md | 1-42 | 42 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/reviews/2026-08-26-ingest-fix-full-project-review-remediation-2026/scope.md | 1-8 | 8 | <= 20 (diff carried no more; file end or smaller -U) |
| .metaproject/flows/202-2026-08-26-keryx-full-review-remediation/tasks.md | 1-11 | 11 | <= 20 (diff carried no more; file end or smaller -U) |
| docs/requirements/keryx-full-review-remediation/README.md | 1-37 | 37 | <= 20 (diff carried no more; file end or smaller -U) |
| docs/requirements/keryx-full-review-remediation/catch-dispositions.md | 1-46 | 46 | <= 20 (diff carried no more; file end or smaller -U) |
| docs/requirements/keryx-full-review-remediation/change-report.md | 1-52 | 52 | <= 20 (diff carried no more; file end or smaller -U) |
| docs/requirements/keryx-full-review-remediation/implementation-plan.md | 1-47 | 47 | <= 20 (diff carried no more; file end or smaller -U) |
| docs/requirements/keryx-full-review-remediation/prd.md | 1-47 | 47 | <= 20 (diff carried no more; file end or smaller -U) |
| docs/requirements/keryx-full-review-remediation/specification.md | 1-94 | 94 | <= 20 (diff carried no more; file end or smaller -U) |
| docs/reviews/keryx-full-project-review-validation-2026-08-26.md | 1-73 | 73 | <= 20 (diff carried no more; file end or smaller -U) |
| src/commands/agent.ts | 24-69 | 6 | 20 |
| src/commands/agent.ts | 1445-1485 | 2 | 20 |
| src/commands/health-status.test.ts | 1-86 | 86 | <= 20 (diff carried no more; file end or smaller -U) |
| src/commands/health.ts | 78-119 | 3 | 20 |
| src/commands/shell.ts | 22-62 | 1 | 20 |
| src/commands/shell.ts | 1816-1856 | 1 | 20 |
| src/commands/workspace.ts | 1-34 | 1 | 20 |
| src/commands/workspace.ts | 91-163 | 18 | 20 |
| src/gdskills/project-skills.ts | 1-25 | 2 | 20 |
| src/gdskills/project-skills.ts | 126-174 | 7 | 20 |
| src/harness/external/supervise-mcp.test.ts | 22-86 | 3 | 20 |
| src/harness/external/supervise-mcp.test.ts | 487-540 | 14 | 20 |
| src/harness/process/sandbox/proxy.test.ts | 1-39 | 14 | 20 |
| src/harness/process/sandbox/proxy.test.ts | 141-214 | 54 | <= 20 (diff carried no more; file end or smaller -U) |
| src/harness/process/sandbox/worker-resolution.test.ts | 1-33 | 9 | <= 20 (diff carried no more; file end or smaller -U) |
| src/harness/process/shell-spawn.ts | 1-172 | 172 | <= 20 (diff carried no more; file end or smaller -U) |
| src/harness/provider/anthropic/anthropic-provider.test.ts | 769-800 | 12 | <= 20 (diff carried no more; file end or smaller -U) |
| src/harness/provider/compat/openai-compat-provider.test.ts | 1-45 | 45 | <= 20 (diff carried no more; file end or smaller -U) |
| src/harness/provider/openai/openai-provider.test.ts | 309-340 | 12 | <= 20 (diff carried no more; file end or smaller -U) |
| src/harness/provider/single-turn.test.ts | 112-156 | 5 | 20 |
| src/harness/tool/builtin/background-job-registry.test.ts | 589-644 | 36 | <= 20 (diff carried no more; file end or smaller -U) |
| src/harness/tool/builtin/background-job-registry.ts | 1-39 | 2 | 20 |
| src/harness/tool/builtin/background-job-registry.ts | 154-196 | 4 | 20 |
| src/harness/tool/builtin/review-remediation-architecture.test.ts | 1-136 | 136 | <= 20 (diff carried no more; file end or smaller -U) |
| src/harness/tool/builtin/shell-exec-tool.test.ts | 52-109 | 18 | 20 |
| src/harness/tool/builtin/shell-exec-tool.ts | 1-112 | 255 | 20 |
| src/harness/tool/builtin/spawn-subagent-external-seam.test.ts | 1-75 | 13 | 20 |
| src/harness/tool/builtin/spawn-subagent-external-seam.test.ts | 226-292 | 70 | <= 20 (diff carried no more; file end or smaller -U) |
| src/harness/tool/builtin/spawn-subagent-model-tier.test.ts | 1-37 | 2 | 20 |
| src/harness/tool/builtin/spawn-subagent-model-tier.test.ts | 42-125 | 10 | 20 |
| src/harness/tool/builtin/spawn-subagent-tool.test.ts | 1-28 | 7 | <= 20 (diff carried no more; file end or smaller -U) |
| src/harness/tool/builtin/spawn-subagent-tool.test.ts | 133-198 | 41 | 20 |
| src/harness/tool/builtin/spawn-subagent-tool.ts | 16-85 | 20 | 20 |
| src/harness/tool/builtin/spawn-subagent-tool.ts | 256-297 | 2 | 20 |
| src/harness/tool/builtin/spawn-subagent-tool.ts | 332-378 | 7 | 20 |
| src/harness/tool/builtin/spawn-subagent-tool.ts | 542-582 | 2 | 20 |
| src/harness/tool/builtin/spawn-subagent-tool.ts | 593-669 | 8 | 20 |
| src/harness/tool/builtin/spawn-subagent-tool.ts | 821-899 | 12 | 20 |
| src/harness/tool/builtin/spawn-subagent-tool.ts | 1022-1099 | 8 | 20 |
| src/harness/tool/builtin/spawn-subagent-tool.ts | 1121-1161 | 2 | 20 |
| src/harness/tool/builtin/spawn-subagent-tool.ts | 1162-1221 | 4 | <= 20 (diff carried no more; file end or smaller -U) |
| src/harness/tool/builtin/workspace-context-tool.ts | 1-40 | 2 | 20 |
| src/harness/tool/builtin/workspace-lifecycle-tool.test.ts | 1-22 | 2 | 20 |
| src/harness/tool/builtin/workspace-lifecycle-tool.test.ts | 35-83 | 9 | 20 |
| src/harness/tool/builtin/workspace-lifecycle-tool.ts | 16-60 | 6 | 20 |
| src/harness/tool/builtin/workspace-lifecycle-tool.ts | 68-129 | 11 | 20 |
| src/harness/tool/builtin/workspace-lifecycle-tool.ts | 198-255 | 18 | <= 20 (diff carried no more; file end or smaller -U) |
| src/health/scoring.test.ts | 26-57 | 7 | <= 20 (diff carried no more; file end or smaller -U) |
| src/health/service-status.test.ts | 1-76 | 76 | <= 20 (diff carried no more; file end or smaller -U) |
| src/health/service.ts | 92-148 | 9 | 20 |
| src/health/types.ts | 199-242 | 3 | 20 |
| src/memory/write.ts | 1-23 | 2 | 20 |
| src/memory/write.ts | 81-123 | 5 | 20 |
| src/metrics/lifecycle.ts | 1-24 | 2 | 20 |
| src/metrics/lifecycle.ts | 35-78 | 6 | 20 |
| src/sac/harness-facade.ts | 1-6 | 6 | <= 20 (diff carried no more; file end or smaller -U) |
| src/sac/machine-wrap-up.ts | 29-150 | 54 | <= 20 (diff carried no more; file end or smaller -U) |
| src/sac/proposal-lifecycle.ts | 12-52 | 2 | 20 |
| src/sac/proposal-lifecycle.ts | 175-230 | 13 | 20 |
| src/sac/review-confirm-token.ts | 6-53 | 3 | 20 |
| src/sac/review-confirm-token.ts | 57-135 | 8 | <= 20 (diff carried no more; file end or smaller -U) |
| src/sac/session-wrap-up.ts | 11-61 | 5 | 20 |
| src/sac/session-wrap-up.ts | 85-177 | 33 | <= 20 (diff carried no more; file end or smaller -U) |
| src/sac/wiki-owner-writer.ts | 4-44 | 2 | 20 |
| src/sac/wiki-owner-writer.ts | 109-146 | 5 | <= 20 (diff carried no more; file end or smaller -U) |
| src/sac/wrap-up-evidence.ts | 1-44 | 44 | <= 20 (diff carried no more; file end or smaller -U) |
| src/security/guard.ts | 21-75 | 15 | 20 |
| src/security/persistence-sinks.test.ts | 1-47 | 47 | <= 20 (diff carried no more; file end or smaller -U) |
| src/security/web-taint-durable-boundary.test.ts | 1-406 | 406 | <= 20 (diff carried no more; file end or smaller -U) |
| src/session/store.ts | 14-54 | 1 | 20 |
| src/session/store.ts | 271-317 | 7 | 20 |
| src/session/store.ts | 545-609 | 17 | 20 |
| src/testing/coverage-map.ts | 1-38 | 2 | 20 |
| src/testing/coverage-map.ts | 219-267 | 7 | 20 |
| src/testing/service.ts | 1-27 | 2 | 20 |
| src/testing/service.ts | 142-191 | 7 | 20 |
| src/wiki/enrich.ts | 12-52 | 1 | 20 |
| src/wiki/enrich.ts | 814-870 | 13 | 20 |
| src/wiki/enrich.ts | 1077-1144 | 19 | 20 |
| src/wiki/service.ts | 1-25 | 2 | 20 |
| src/wiki/service.ts | 795-847 | 7 | 20 |

### Dropped by the pre-filter

_nothing was dropped_

Counts by reason: lockfile=0, generated=0, vendored=0, snapshot=0, minified=0, binary=0, whitespace-only=0, comment-only=0

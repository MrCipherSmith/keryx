# Testing Context

generatedAt: 2026-11-12T12:33:51.380Z
status: complete

## Frameworks

- bun
- vitest

## Scripts

- `check`: `bun run lint && bun run typecheck && bun run typecheck:scripts && bun test`
- `check:core`: `bun run lint && bun run typecheck && bun run typecheck:scripts && bun run test:core`
- `check:hub-web`: `bun run --cwd apps/hub-web typecheck && bun run --cwd apps/hub-web lint && bun run --cwd apps/hub-web test && bun scripts/build-hub-web.ts --check`
- `docs:check`: `bun run check:doc-links && bun run check:retired-spellings && bun test src/cli-reference-coverage.test.ts src/standard/commands-by-task.test.ts src/standard/help-groups.test.ts`
- `test`: `bun test`
- `test:client`: `bun run test:client:terminal && bun run test:client:streaming && bun run test:client:cancel-resume && bun run test:client:runtime`
- `test:client:cancel-resume`: `bun test src/harness/run/ src/harness/resume/ src/harness/session/ src/session/ src/bus/ src/rewind/ src/remote/ src/docs/ src/commands/sessions`
- `test:client:runtime`: `bun test src/harness/ src/mcp-client/ src/mcp-servers/ src/agents/ src/commands/agent src/commands/harness src/commands/providers src/scheduler/ src/intake/`
- `test:client:streaming`: `bun test src/harness/provider/`
- `test:client:terminal`: `bun test src/tui/ src/commands/shell`
- `test:core`: `bun test src/cli src/core src/impact-evidence/ src/shell-source-audits.test.ts src/acp/ src/assets/ src/bundle/ src/capability/ src/commands/ src/contracts/ src/ctx/ src/decisions/ src/eval/ src/flow/ src/forgetting/ src/gdgraph/ src/gdskills/ src/governance/ src/product/ src/health/ src/hub/ src/integrations/ src/job/ src/learning/ src/lib/ src/mcp/ src/memory/ src/metrics/ src/remote-control/ src/retention/ src/review/ src/rules/ src/sac/ src/security/ src/stack/ src/standard/ src/sync/ src/testing/ src/trigger/ src/wiki/ scripts/`
- `test:guards`: `bun test src/lib/config-dir.ast.test.ts src/lib/config-dir.readers.test.ts src/lib/production-graph.test.ts src/harness/policy/profiles.test.ts src/lib/serve-server.test.ts src/gdskills/agent-catalogue-xref.test.ts src/gdskills/enforcement-claims.test.ts`

## Configs

- apps/hub-web/tsconfig.json
- apps/hub-web/vitest.config.ts
- bunfig.toml
- tsconfig.json
- tsconfig.scripts.json
- vscode-extension/tsconfig.json

## Test Files

- apps/hub-web/tests/acceptance-support.case.ts
- apps/hub-web/tests/accessibility.case.tsx
- apps/hub-web/tests/auth.case.tsx
- apps/hub-web/tests/breadcrumb.case.tsx
- apps/hub-web/tests/browser-journeys.e2e.mjs
- apps/hub-web/tests/client.case.ts
- apps/hub-web/tests/context-model.case.ts
- apps/hub-web/tests/context.case.tsx
- apps/hub-web/tests/css-rules.ts
- apps/hub-web/tests/demo-receipt.case.ts
- apps/hub-web/tests/drafts.case.tsx
- apps/hub-web/tests/flow-acceptance.case.tsx
- apps/hub-web/tests/flow-acceptance.fixture.tsx
- apps/hub-web/tests/flow-term.case.ts
- apps/hub-web/tests/global-flows.case.tsx
- apps/hub-web/tests/hub-render.tsx
- apps/hub-web/tests/legacy-decision.case.tsx
- apps/hub-web/tests/legacy-review-history.case.tsx
- apps/hub-web/tests/live-shells.case.tsx
- apps/hub-web/tests/localization.case.ts
- apps/hub-web/tests/machine-cards.case.tsx
- apps/hub-web/tests/managed-native-message.case.tsx
- apps/hub-web/tests/managed-work-advanced.case.tsx
- apps/hub-web/tests/managed-work.case.tsx
- apps/hub-web/tests/navigation.case.tsx
- apps/hub-web/tests/pending-recovery.case.tsx
- apps/hub-web/tests/project-overview.case.tsx
- apps/hub-web/tests/remote-client.case.ts
- apps/hub-web/tests/remote-controller.case.tsx
- apps/hub-web/tests/remote-draft-renewal.case.tsx
- apps/hub-web/tests/remote-events.case.tsx
- apps/hub-web/tests/remote-fixtures.ts
- apps/hub-web/tests/remote-owned-controls.case.tsx
- apps/hub-web/tests/remote-recovery.case.tsx
- apps/hub-web/tests/remote-renewal.case.ts
- apps/hub-web/tests/remote-runs.case.tsx
- apps/hub-web/tests/remote-settings.case.tsx
- apps/hub-web/tests/remote-timeline.case.ts
- apps/hub-web/tests/remote.case.tsx
- apps/hub-web/tests/review-aggregate-evidence.case.tsx
- apps/hub-web/tests/review-draft-recovery.case.tsx
- apps/hub-web/tests/review-flow-reject.case.tsx
- apps/hub-web/tests/review-knowledge-followup.case.tsx
- apps/hub-web/tests/review-legacy-evidence.case.tsx
- apps/hub-web/tests/revision-pagination.case.tsx
- apps/hub-web/tests/session-command-outcomes.case.tsx
- apps/hub-web/tests/session-message-delivery.case.tsx
- apps/hub-web/tests/session-run-context.case.tsx
- apps/hub-web/tests/session-timeline.case.ts
- apps/hub-web/tests/session-workspace.case.tsx
- apps/hub-web/tests/setup.ts
- apps/hub-web/tests/theme.case.tsx
- apps/hub-web/tests/work-incremental.case.tsx
- apps/hub-web/tests/work-live-amendments.case.tsx
- apps/hub-web/tests/work-live-attention.case.tsx
- apps/hub-web/tests/work-live-choices.case.tsx
- apps/hub-web/tests/work-live-updates.case.tsx
- apps/hub-web/tests/work-model-guards.case.ts
- apps/hub-web/tests/work-revision-members.case.tsx
- apps/hub-web/tests/work-sequences.case.tsx
- apps/hub-web/tests/work-server-contract.case.ts
- apps/hub-web/tests/workflow-pagination.case.tsx
- apps/hub-web/tests/workflow.case.tsx
- bench/jev-review/adapters/ci-triage.test.ts
- bench/jev-review/adapters/registry.test.ts
- bench/jev-review/adapters/review-conform.test.ts
- bench/jev-review/build-dataset.test.ts
- bench/jev-review/cost-cap.test.ts
- bench/jev-review/metrics.test.ts
- bench/jev-review/report.test.ts
- bench/jev-review/run.test.ts
- fixtures/change-impacted-test/src/alpha.extra.test.ts
- fixtures/change-impacted-test/src/alpha.test.ts
- fixtures/change-impacted-test/src/beta.test.ts
- fixtures/change-impacted-test/src/gamma.test.ts
- scripts/benchmark/ablation-emission-gating.test.ts
- scripts/benchmark/build-comparative-report.test.ts
- scripts/benchmark/long-metrics.test.ts
- scripts/benchmark/long-runner-turn.test.ts
- scripts/benchmark/long-tasks.test.ts

- ... 2043 more

## CI

- .github/workflows/ci.yml
- .github/workflows/docs.yml
- .github/workflows/full-check-diagnostic.yml
- .github/workflows/release.yml
- .github/workflows/wiki-freshness.yml

## Conventions

- AGENTS.md: For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.
- AGENTS.md: For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.
- CLAUDE.md: For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.
- CLAUDE.md: For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.
- docs/README.md: [Implementation spec](report/release-readiness-2026-07-10/implementation-spec.md)
- docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: failing_candidate_output_test
- docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: budget_33_of_32_test
- docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: stable_id_reorder_test
- docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: changed_unpinned_source_test
- docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: note_mutation_test
- docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: self_review_test
- docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: cross_proposal_idempotency_test
- docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: accepted_target_link_back_test
- docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: mixed_activity_ledger_test
- docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: sibling_worktree_contract_test
- docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: revoke_and_cross_workspace_tests_green
- docs/analysis/keryx-improvements-1/2026-08-14/plans/ru/implementation-plan.md: Привязать текущие test claims к commit/date.
- docs/analysis/keryx-improvements-1/2026-08-14/plans/ru/implementation-plan.md: Добавить executable docs smoke tests.
- docs/analysis/keryx-improvements-1/2026-08-14/plans/ru/implementation-plan.md: Exit: output-changing e2e corpus, budget/property tests, replay-safe IDs.
- docs/analysis/keryx-improvements-1/2026-08-14/plans/ru/implementation-plan.md: Exit: zero raw secret/PII persistence corpus; expiry/deletion/recovery tests.
- docs/analysis/keryx-improvements-1/2026-08-14/plans/ru/implementation-plan.md: Exit: revoke/cross-workspace/replay/confused-deputy tests.
- docs/analysis/keryx-improvements-1/2026-08-14/report/ai/report.md: | ID | Severity | Finding | Primary evidence | Falsifier/acceptance test |
- docs/analysis/keryx-improvements-1/2026-08-14/report/ai/report.md: | F-021 | P0 | Collaboration and proposal lifecycle share incompatible `activity.jsonl` | both services | handoff→proposal→review→collaboration mixed test |
- docs/analysis/keryx-improvements-1/2026-08-14/report/ai/report.md: | F-022 | P1 | Collaboration nested payload is not schema-closed | `collaboration-service.ts` | property tests reject nested extras/content |
- docs/analysis/keryx-improvements-1/2026-08-14/report/ai/report.md: | F-026 | P1 | Sibling worktrees cannot share checkout-rooted SAC state | containment/storage | explicit clone/worktree model test |
- docs/analysis/keryx-improvements-1/2026-08-14/report/ai/report.md: | F-027 | P1 | Every read performs a durable locked append; no surfaced retention | FWK ledger | 10k-read SLO, prune/repair tests |
- docs/analysis/keryx-improvements-1/2026-08-14/report/ai/report.md: | F-034 | P1 | Historical test totals are presented as current evidence | SAC docs | evidence pinned to commit/tag/date |
- docs/analysis/keryx-improvements-1/2026-08-14/report/ai/report.md: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- docs/analysis/keryx-improvements-1/2026-08-14/report/ai/report.md: https://github.com/a2aproject/A2A/blob/main/docs/specification.md
- docs/analysis/keryx-improvements-1/2026-08-14/report/ai/report.md: owner_contract_tests

## Recommendations

- none

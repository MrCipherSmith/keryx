# Testing Context

generatedAt: 2026-10-01T08:51:09.149Z
status: complete

## Frameworks

- bun

## Scripts

- `check`: `bun run lint && bun run typecheck && bun run typecheck:scripts && bun test`
- `check:core`: `bun run lint && bun run typecheck && bun run typecheck:scripts && bun run test:core`
- `test`: `bun test`
- `test:client`: `bun run test:client:terminal && bun run test:client:streaming && bun run test:client:cancel-resume && bun run test:client:runtime`
- `test:client:cancel-resume`: `bun test src/harness/run/ src/harness/resume/ src/harness/session/ src/session/ src/bus/ src/rewind/ src/remote/ src/commands/sessions`
- `test:client:runtime`: `bun test src/harness/ src/mcp-client/ src/mcp-servers/ src/agents/ src/commands/agent src/commands/harness src/commands/providers`
- `test:client:streaming`: `bun test src/harness/provider/`
- `test:client:terminal`: `bun test src/tui/ src/commands/shell`
- `test:core`: `bun test src/cli src/core src/impact-evidence/ src/shell-source-audits.test.ts src/acp/ src/assets/ src/bundle/ src/capability/ src/commands/ src/contracts/ src/ctx/ src/eval/ src/flow/ src/forgetting/ src/gdgraph/ src/gdskills/ src/governance/ src/product/ src/health/ src/integrations/ src/job/ src/learning/ src/lib/ src/mcp/ src/memory/ src/metrics/ src/retention/ src/review/ src/rules/ src/sac/ src/security/ src/stack/ src/standard/ src/sync/ src/testing/ src/trigger/ src/wiki/ scripts/`
- `test:guards`: `bun test src/lib/config-dir.ast.test.ts src/lib/config-dir.readers.test.ts src/lib/production-graph.test.ts src/harness/policy/profiles.test.ts src/lib/serve-server.test.ts src/gdskills/agent-catalogue-xref.test.ts src/gdskills/enforcement-claims.test.ts`

## Configs

- bunfig.toml
- tsconfig.json
- tsconfig.scripts.json
- vscode-extension/tsconfig.json

## Test Files

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
- scripts/benchmark/oracle-emission-gating.test.ts
- scripts/benchmark/run-ablation-raw.test.ts
- scripts/benchmark/run-containment.test.ts
- scripts/benchmark/run-express-oracle.test.ts
- scripts/benchmark/run-safety.test.ts
- scripts/benchmark/run-wiki-freshness-scale.test.ts
- scripts/benchmark/wiki-freshness-scale-fixture.test.ts
- scripts/check-doc-links.test.ts
- scripts/check-retired-cli-spellings.test.ts
- scripts/install-global.test.ts
- scripts/sandbox-deep-probe-redaction.test.ts
- scripts/stress/keryx-shell-stress.test.ts
- scripts/typecheck.test.ts
- src/acp/agent-io.test.ts
- src/acp/cancel-list-load.process.test.ts
- src/acp/capability-matrix.process.test.ts
- src/acp/client-requests.test.ts
- src/acp/commands.test.ts
- src/acp/concurrent-turns.process.test.ts
- src/acp/conformance.process.test.ts
- src/acp/dispatch.test.ts
- src/acp/framing.test.ts
- src/acp/hook-notices.test.ts
- src/acp/mcp-servers.process.test.ts
- src/acp/models.test.ts
- src/acp/permission.process.test.ts
- src/acp/permission.test.ts
- src/acp/project-tools.process.test.ts
- src/acp/prompt-content.test.ts
- src/acp/protocol.test.ts
- src/acp/roster.test.ts
- src/acp/server-mcp.test.ts
- src/acp/server-models.test.ts
- src/acp/session-mcp.test.ts
- src/acp/session.test.ts
- src/agents/baseline.test.ts
- src/agents/bootstrap.test.ts
- src/agents/bundled-agent-files.test.ts
- src/agents/catalog.test.ts
- src/agents/compile.content-hash.test.ts
- src/agents/compile.format-safety.test.ts
- src/agents/compile.model-tier.test.ts
- src/agents/compile.spawn-subagent.test.ts
- src/agents/export.test.ts
- src/agents/frontmatter.test.ts
- src/agents/generate.test.ts
- src/agents/schema.test.ts
- src/agents/tools.test.ts
- src/agents/verify.test.ts
- src/assets/command.test.ts
- src/assets/resolver.test.ts
- src/assets/seed.test.ts
- src/bundle/applied-state.test.ts
- src/bundle/apply.test.ts
- src/bundle/archive.test.ts
- src/bundle/audit.test.ts
- src/bundle/export.test.ts
- src/bundle/external.test.ts
- src/bundle/hook-audit.e2e.test.ts
- src/bundle/inspect.test.ts
- src/bundle/manifest.test.ts
- src/bundle/own-repo-roundtrip.test.ts
- src/bundle/paths.test.ts
- src/bundle/plan.test.ts
- src/bundle/roundtrip.e2e.test.ts
- src/bundle/uninstall.test.ts

- ... 1276 more

## CI

- .github/workflows/ci.yml
- .github/workflows/docs.yml
- .github/workflows/release.yml
- .github/workflows/wiki-freshness.yml

## Conventions

- AGENTS.md: For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.
- AGENTS.md: For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.
- CLAUDE.md: For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.
- CLAUDE.md: For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.
- docs/README.md: [Implementation spec](report/release-readiness-2026-07-10/implementation-spec.md)
- docs/analysis/keryx-harness-comparison/2026-08-20/report/en/report.md: | Testing intelligence | **2** | 1 | – | – | **2** | – | 1 | – |
- docs/analysis/keryx-harness-comparison/2026-08-20/report/en/report.md: 5. **Quality gates** — single weighted risk score (lint/type/test/complexity/coverage/hotspots) checked in CI against a main baseline. Gemini CLI's `preflight` chains checks but doesn't roll into one score.
- docs/analysis/keryx-harness-comparison/2026-08-20/report/en/report.md: Testing intelligence ceiling
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

## Recommendations

- none

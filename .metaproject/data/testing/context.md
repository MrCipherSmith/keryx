# Testing Context

generatedAt: 2026-08-31T11:45:54.148Z

## Frameworks

- bun

## Scripts

- `check`: `tsc --noEmit && bun test`
- `test`: `bun test`
- `test:guards`: `bun test src/lib/config-dir.ast.test.ts src/lib/config-dir.readers.test.ts src/lib/production-graph.test.ts src/harness/policy/profiles.test.ts src/lib/serve-server.test.ts src/gdskills/agent-catalogue-xref.test.ts src/gdskills/enforcement-claims.test.ts`

## Configs

- bunfig.toml
- tsconfig.json
- vscode-extension/tsconfig.json

## Test Files

- fixtures/change-impacted-test/src/alpha.extra.test.ts
- fixtures/change-impacted-test/src/alpha.test.ts
- fixtures/change-impacted-test/src/beta.test.ts
- fixtures/change-impacted-test/src/gamma.test.ts
- scripts/install-global.test.ts
- scripts/sandbox-deep-probe-redaction.test.ts
- src/agents/bootstrap.test.ts
- src/assets/command.test.ts
- src/assets/resolver.test.ts
- src/assets/seed.test.ts
- src/capability/external-agents.test.ts
- src/capability/golden-rule.test.ts
- src/capability/no-optional-imports.test.ts
- src/capability/reference.test.ts
- src/capability/seam.test.ts
- src/capability/tui-layout.test.ts
- src/capability/wiring.test.ts
- src/cli.test.ts
- src/commands/agent-approval-binding.test.ts
- src/commands/agent-approval-context-p0.test.ts
- src/commands/agent-approval-context.test.ts
- src/commands/agent-commands.test.ts
- src/commands/agent-destructive-gate.test.ts
- src/commands/agent-permission-mode.test.ts
- src/commands/agent.test.ts
- src/commands/agents-external.test.ts
- src/commands/agents.monitor.test.ts
- src/commands/ctx.rg-argv.test.ts
- src/commands/ctx.test.ts
- src/commands/dashboard.test.ts
- src/commands/goal-command.test.ts
- src/commands/harness-exec-extension-wave.test.ts
- src/commands/harness-exec-restricted.smoke.test.ts
- src/commands/harness-exec.smoke.test.ts
- src/commands/harness-network-posture.test.ts
- src/commands/harness.replay.test.ts
- src/commands/harness.test.ts
- src/commands/health-status.test.ts
- src/commands/init-mcp-offer.test.ts
- src/commands/init-mcp-runtimes.test.ts
- src/commands/init.escape.test.ts
- src/commands/init.no-git.test.ts
- src/commands/init.test.ts
- src/commands/interactive-agent-tools.test.ts
- src/commands/mcp-install.test.ts
- src/commands/memory-p0.test.ts
- src/commands/memory-report.test.ts
- src/commands/metrics.test.ts
- src/commands/module-commands.test.ts
- src/commands/modules.test.ts
- src/commands/orient.dry-run.test.ts
- src/commands/permission-mode.test.ts
- src/commands/projects.escape.test.ts
- src/commands/providers.balance.test.ts
- src/commands/providers.cross-family.test.ts
- src/commands/providers.custom.test.ts
- src/commands/providers.test.ts
- src/commands/review-comments-cli.test.ts
- src/commands/review-learn-cli.test.ts
- src/commands/review.test.ts
- src/commands/rules.test.ts
- src/commands/sandbox.test.ts
- src/commands/security-hooks-init.test.ts
- src/commands/security.check-input.test.ts
- src/commands/select.test.ts
- src/commands/serve.cli.test.ts
- src/commands/serve.escape.test.ts
- src/commands/serve.process.test.ts
- src/commands/serve.recovery.test.ts
- src/commands/sessions.fork.test.ts
- src/commands/shell-approval.test.ts
- src/commands/shell-headless-sigint.test.ts
- src/commands/shell-launch.test.ts
- src/commands/shell-pty-launch.smoke.test.ts
- src/commands/shell-slash-registry.test.ts
- src/commands/shell.test.ts
- src/commands/skills-route.test.ts
- src/commands/skills.bundled-verify.installed.test.ts
- src/commands/skills.bundled-verify.test.ts
- src/commands/status.help.test.ts

- ... 438 more

## CI

- .github/workflows/ci.yml
- .github/workflows/docs.yml
- .github/workflows/release.yml

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

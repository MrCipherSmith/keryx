# Testing Context

generatedAt: 2026-09-02T16:55:05.533Z

## Frameworks

- bun

## Scripts

- `check`: `tsc --noEmit && bun test`
- `test`: `bun test`
- `test:guards`: `bun test src/lib/config-dir.ast.test.ts src/lib/config-dir.readers.test.ts src/lib/production-graph.test.ts src/harness/policy/profiles.test.ts src/lib/serve-server.test.ts src/gdskills/agent-catalogue-xref.test.ts src/gdskills/enforcement-claims.test.ts`

## Configs

- .worktrees/full-review-remediation/bunfig.toml
- .worktrees/full-review-remediation/tsconfig.json
- .worktrees/full-review-remediation/vscode-extension/tsconfig.json
- .worktrees/project-skill-reviewers/bunfig.toml
- .worktrees/project-skill-reviewers/tsconfig.json
- .worktrees/project-skill-reviewers/vscode-extension/tsconfig.json
- bunfig.toml
- tsconfig.json
- vscode-extension/tsconfig.json

## Test Files

- .worktrees/full-review-remediation/fixtures/change-impacted-test/src/alpha.extra.test.ts
- .worktrees/full-review-remediation/fixtures/change-impacted-test/src/alpha.test.ts
- .worktrees/full-review-remediation/fixtures/change-impacted-test/src/beta.test.ts
- .worktrees/full-review-remediation/fixtures/change-impacted-test/src/gamma.test.ts
- .worktrees/full-review-remediation/scripts/install-global.test.ts
- .worktrees/full-review-remediation/scripts/sandbox-deep-probe-redaction.test.ts
- .worktrees/full-review-remediation/src/agents/bootstrap.test.ts
- .worktrees/full-review-remediation/src/assets/command.test.ts
- .worktrees/full-review-remediation/src/assets/resolver.test.ts
- .worktrees/full-review-remediation/src/assets/seed.test.ts
- .worktrees/full-review-remediation/src/capability/external-agents.test.ts
- .worktrees/full-review-remediation/src/capability/golden-rule.test.ts
- .worktrees/full-review-remediation/src/capability/no-optional-imports.test.ts
- .worktrees/full-review-remediation/src/capability/reference.test.ts
- .worktrees/full-review-remediation/src/capability/seam.test.ts
- .worktrees/full-review-remediation/src/capability/tui-layout.test.ts
- .worktrees/full-review-remediation/src/capability/wiring.test.ts
- .worktrees/full-review-remediation/src/cli.test.ts
- .worktrees/full-review-remediation/src/commands/agent-approval-binding.test.ts
- .worktrees/full-review-remediation/src/commands/agent-approval-context-p0.test.ts
- .worktrees/full-review-remediation/src/commands/agent-approval-context.test.ts
- .worktrees/full-review-remediation/src/commands/agent-commands.test.ts
- .worktrees/full-review-remediation/src/commands/agent-destructive-gate.test.ts
- .worktrees/full-review-remediation/src/commands/agent-permission-mode.test.ts
- .worktrees/full-review-remediation/src/commands/agent.test.ts
- .worktrees/full-review-remediation/src/commands/agents-external.test.ts
- .worktrees/full-review-remediation/src/commands/agents.monitor.test.ts
- .worktrees/full-review-remediation/src/commands/ctx.rg-argv.test.ts
- .worktrees/full-review-remediation/src/commands/ctx.test.ts
- .worktrees/full-review-remediation/src/commands/dashboard.test.ts
- .worktrees/full-review-remediation/src/commands/goal-command.test.ts
- .worktrees/full-review-remediation/src/commands/harness-exec-extension-wave.test.ts
- .worktrees/full-review-remediation/src/commands/harness-exec-restricted.smoke.test.ts
- .worktrees/full-review-remediation/src/commands/harness-exec.smoke.test.ts
- .worktrees/full-review-remediation/src/commands/harness-network-posture.test.ts
- .worktrees/full-review-remediation/src/commands/harness.replay.test.ts
- .worktrees/full-review-remediation/src/commands/harness.test.ts
- .worktrees/full-review-remediation/src/commands/health-status.test.ts
- .worktrees/full-review-remediation/src/commands/init-mcp-offer.test.ts
- .worktrees/full-review-remediation/src/commands/init-mcp-runtimes.test.ts
- .worktrees/full-review-remediation/src/commands/init.escape.test.ts
- .worktrees/full-review-remediation/src/commands/init.no-git.test.ts
- .worktrees/full-review-remediation/src/commands/init.test.ts
- .worktrees/full-review-remediation/src/commands/interactive-agent-tools.test.ts
- .worktrees/full-review-remediation/src/commands/mcp-install.test.ts
- .worktrees/full-review-remediation/src/commands/memory-p0.test.ts
- .worktrees/full-review-remediation/src/commands/memory-report.test.ts
- .worktrees/full-review-remediation/src/commands/metrics.test.ts
- .worktrees/full-review-remediation/src/commands/module-commands.test.ts
- .worktrees/full-review-remediation/src/commands/modules.test.ts
- .worktrees/full-review-remediation/src/commands/orient.dry-run.test.ts
- .worktrees/full-review-remediation/src/commands/permission-mode.test.ts
- .worktrees/full-review-remediation/src/commands/projects.escape.test.ts
- .worktrees/full-review-remediation/src/commands/providers.balance.test.ts
- .worktrees/full-review-remediation/src/commands/providers.cross-family.test.ts
- .worktrees/full-review-remediation/src/commands/providers.custom.test.ts
- .worktrees/full-review-remediation/src/commands/providers.test.ts
- .worktrees/full-review-remediation/src/commands/review-comments-cli.test.ts
- .worktrees/full-review-remediation/src/commands/review-learn-cli.test.ts
- .worktrees/full-review-remediation/src/commands/review.test.ts
- .worktrees/full-review-remediation/src/commands/rules.test.ts
- .worktrees/full-review-remediation/src/commands/sandbox.test.ts
- .worktrees/full-review-remediation/src/commands/security-hooks-init.test.ts
- .worktrees/full-review-remediation/src/commands/security.check-input.test.ts
- .worktrees/full-review-remediation/src/commands/select.test.ts
- .worktrees/full-review-remediation/src/commands/serve.cli.test.ts
- .worktrees/full-review-remediation/src/commands/serve.escape.test.ts
- .worktrees/full-review-remediation/src/commands/serve.process.test.ts
- .worktrees/full-review-remediation/src/commands/serve.recovery.test.ts
- .worktrees/full-review-remediation/src/commands/sessions.fork.test.ts
- .worktrees/full-review-remediation/src/commands/shell-approval.test.ts
- .worktrees/full-review-remediation/src/commands/shell-headless-sigint.test.ts
- .worktrees/full-review-remediation/src/commands/shell-launch.test.ts
- .worktrees/full-review-remediation/src/commands/shell-pty-launch.smoke.test.ts
- .worktrees/full-review-remediation/src/commands/shell-slash-registry.test.ts
- .worktrees/full-review-remediation/src/commands/shell.test.ts
- .worktrees/full-review-remediation/src/commands/skills-route.test.ts
- .worktrees/full-review-remediation/src/commands/skills.bundled-verify.installed.test.ts
- .worktrees/full-review-remediation/src/commands/skills.bundled-verify.test.ts
- .worktrees/full-review-remediation/src/commands/status.help.test.ts

- ... 1490 more

## CI

- .github/workflows/ci.yml
- .github/workflows/docs.yml
- .github/workflows/release.yml
- .worktrees/full-review-remediation/.github/workflows/ci.yml
- .worktrees/full-review-remediation/.github/workflows/docs.yml
- .worktrees/full-review-remediation/.github/workflows/release.yml
- .worktrees/project-skill-reviewers/.github/workflows/ci.yml
- .worktrees/project-skill-reviewers/.github/workflows/docs.yml
- .worktrees/project-skill-reviewers/.github/workflows/release.yml

## Conventions

- .worktrees/full-review-remediation/AGENTS.md: For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.
- .worktrees/full-review-remediation/AGENTS.md: For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.
- .worktrees/full-review-remediation/CLAUDE.md: For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.
- .worktrees/full-review-remediation/CLAUDE.md: For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.
- .worktrees/full-review-remediation/docs/README.md: [Implementation spec](report/release-readiness-2026-07-10/implementation-spec.md)
- .worktrees/full-review-remediation/docs/analysis/keryx-harness-comparison/2026-08-20/report/en/report.md: | Testing intelligence | **2** | 1 | – | – | **2** | – | 1 | – |
- .worktrees/full-review-remediation/docs/analysis/keryx-harness-comparison/2026-08-20/report/en/report.md: 5. **Quality gates** — single weighted risk score (lint/type/test/complexity/coverage/hotspots) checked in CI against a main baseline. Gemini CLI's `preflight` chains checks but doesn't roll into one score.
- .worktrees/full-review-remediation/docs/analysis/keryx-harness-comparison/2026-08-20/report/en/report.md: Testing intelligence ceiling
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: failing_candidate_output_test
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: budget_33_of_32_test
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: stable_id_reorder_test
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: changed_unpinned_source_test
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: note_mutation_test
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: self_review_test
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: cross_proposal_idempotency_test
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: accepted_target_link_back_test
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: mixed_activity_ledger_test
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: sibling_worktree_contract_test
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/plans/ai/implementation-plan.md: revoke_and_cross_workspace_tests_green
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/plans/ru/implementation-plan.md: Привязать текущие test claims к commit/date.
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/plans/ru/implementation-plan.md: Добавить executable docs smoke tests.
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/plans/ru/implementation-plan.md: Exit: output-changing e2e corpus, budget/property tests, replay-safe IDs.
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/plans/ru/implementation-plan.md: Exit: zero raw secret/PII persistence corpus; expiry/deletion/recovery tests.
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/plans/ru/implementation-plan.md: Exit: revoke/cross-workspace/replay/confused-deputy tests.
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/report/ai/report.md: | ID | Severity | Finding | Primary evidence | Falsifier/acceptance test |
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/report/ai/report.md: | F-021 | P0 | Collaboration and proposal lifecycle share incompatible `activity.jsonl` | both services | handoff→proposal→review→collaboration mixed test |
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/report/ai/report.md: | F-022 | P1 | Collaboration nested payload is not schema-closed | `collaboration-service.ts` | property tests reject nested extras/content |
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/report/ai/report.md: | F-026 | P1 | Sibling worktrees cannot share checkout-rooted SAC state | containment/storage | explicit clone/worktree model test |
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/report/ai/report.md: | F-027 | P1 | Every read performs a durable locked append; no surfaced retention | FWK ledger | 10k-read SLO, prune/repair tests |
- .worktrees/full-review-remediation/docs/analysis/keryx-improvements-1/2026-08-14/report/ai/report.md: | F-034 | P1 | Historical test totals are presented as current evidence | SAC docs | evidence pinned to commit/tag/date |

## Recommendations

- none

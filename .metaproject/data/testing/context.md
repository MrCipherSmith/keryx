# Testing Context

generatedAt: 2026-08-13T11:45:26.026Z

## Frameworks

- bun

## Scripts

- `check`: `tsc --noEmit && bun test`
- `test`: `bun test`
- `test:guards`: `bun test src/lib/config-dir.ast.test.ts src/lib/config-dir.readers.test.ts src/lib/production-graph.test.ts src/harness/policy/profiles.test.ts src/lib/serve-server.test.ts`

## Configs

- bunfig.toml
- tsconfig.json

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
- src/commands/agent.test.ts
- src/commands/agents.monitor.test.ts
- src/commands/ctx.rg-argv.test.ts
- src/commands/ctx.test.ts
- src/commands/dashboard.test.ts
- src/commands/harness-exec-extension-wave.test.ts
- src/commands/harness-exec-restricted.smoke.test.ts
- src/commands/harness-exec.smoke.test.ts
- src/commands/harness-network-posture.test.ts
- src/commands/harness.replay.test.ts
- src/commands/harness.test.ts
- src/commands/init-mcp-offer.test.ts
- src/commands/init.escape.test.ts
- src/commands/init.no-git.test.ts
- src/commands/init.test.ts
- src/commands/mcp-install.test.ts
- src/commands/memory-p0.test.ts
- src/commands/memory-report.test.ts
- src/commands/metrics.test.ts
- src/commands/module-commands.test.ts
- src/commands/modules.test.ts
- src/commands/orient.dry-run.test.ts
- src/commands/projects.escape.test.ts
- src/commands/providers.test.ts
- src/commands/rules.test.ts
- src/commands/security-hooks-init.test.ts
- src/commands/security.check-input.test.ts
- src/commands/select.test.ts
- src/commands/serve.cli.test.ts
- src/commands/serve.escape.test.ts
- src/commands/serve.process.test.ts
- src/commands/serve.recovery.test.ts
- src/commands/sessions.fork.test.ts
- src/commands/shell-launch.test.ts
- src/commands/shell-pty-launch.smoke.test.ts
- src/commands/shell-slash-registry.test.ts
- src/commands/shell.test.ts
- src/commands/skills-route.test.ts
- src/commands/status.help.test.ts
- src/commands/update.test.ts
- src/commands/version.test.ts
- src/commands/workspace.test.ts
- src/contracts/fixtures.test.ts
- src/ctx/hook-install.test.ts
- src/ctx/hook.test.ts
- src/ctx/orient-runtimes.test.ts
- src/ctx/orient.test.ts
- src/ctx/runtimes.test.ts
- src/eval/block-d-corpora.test.ts
- src/eval/corpus.test.ts
- src/flow/allocation.test.ts
- src/flow/context-inject.test.ts
- src/flow/context-p0.test.ts
- src/flow/disposition.test.ts
- src/flow/duplicate-ids.test.ts
- src/flow/machine.test.ts
- src/flow/migration.test.ts
- src/flow/schema.test.ts

- ... 265 more

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
- docs/decisions/keryx-harness/ADR-0001-d01-release0-boundary.md: 5. **Context manifest** — a bounded, hash-addressed project context scope (code graph, wiki, memory, rules, skills, testing, health, security references) with metadata, freshness indicators, and provenance.
- docs/decisions/keryx-harness/ADR-0001-d01-release0-boundary.md: [specification.md](../../requirements/keryx-project-agent-harness/specification.md) — architecture, runtime lifecycle, storage model, manifest and config schemas, CLI, tool/policy boundary, durable orchestration.
- docs/decisions/keryx-harness/ADR-0001-d01-release0-boundary.md: ✓ Traceability to implementation-plan.md, acceptance.feature, README, PRD, specification, brainstorm, and schemas
- docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: structured claims contain **no contradiction** with the frozen specification
- docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: This is the exact position of the frozen specification:
- docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: > — specification.md §Orchestration Model
- docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: > — specification.md §Canonical Ownership and Import Direction
- docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: orchestrator" (specification.md §Planned Module Map).
- docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: The frozen specification (§Canonical Ownership and Import Direction) names the
- docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: | `ContextProvider` | harness context service | graph, ctx, wiki, memory, testing, health adapters | adapter → port | Project brain stays owned by existing modules; harness consumes read-only. |
- docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: provider SDK, terminal UI, MCP SDK, or a specific subprocess implementation.
- docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: ports." (specification.md §Architectural Position)
- docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: section. S-06 is realized in the frozen package by specification.md
- docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: transitions") is the test gate for the single-coordinator invariant:
- docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: flow/harness completion parity and failure-disposition tests.
- docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: TM-01** specifies additive task/run-link fields (dependencies, attempts,
- docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: [specification.md](../../requirements/keryx-project-agent-harness/specification.md)
- docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: S-06** (single coordinator) → specification.md §Orchestration Model +
- docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: > frozen spec.
- docs/decisions/keryx-harness/ADR-0003-d03-security-profiles-containment.md: resolution is deterministic, testable, and independent of the CLI/TUI) and D4
- docs/decisions/keryx-harness/ADR-0003-d03-security-profiles-containment.md: `specification.md` §Security Boundary confirms: "Three profiles exist:
- docs/decisions/keryx-harness/ADR-0003-d03-security-profiles-containment.md: S-04** (implementation-plan.md §W1 D-03 traceability id; `specification.md`
- docs/decisions/keryx-harness/ADR-0003-d03-security-profiles-containment.md: time (`specification.md` §Error and Recovery Contracts:
- docs/decisions/keryx-harness/ADR-0003-d03-security-profiles-containment.md: (`specification.md` §Security Boundary). Network enforcement is the broker, not
- docs/decisions/keryx-harness/ADR-0003-d03-security-profiles-containment.md: (`specification.md` §Policy Decision; acceptance `@SC_R05_HARD_DENY`), and

## Recommendations

- none

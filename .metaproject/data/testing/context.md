# Testing Context

generatedAt: 2026-09-06T11:10:27.821Z

## Frameworks

- bun

## Scripts

- `check`: `bun run typecheck && bun run typecheck:scripts && bun test`
- `test`: `bun test`
- `test:guards`: `bun test src/lib/config-dir.ast.test.ts src/lib/config-dir.readers.test.ts src/lib/production-graph.test.ts src/harness/policy/profiles.test.ts src/lib/serve-server.test.ts src/gdskills/agent-catalogue-xref.test.ts src/gdskills/enforcement-claims.test.ts`

## Configs

- .claude/worktrees/jolly-vaughan-4bdf70/tsconfig.json
- .claude/worktrees/keryx-harness-phase-1-109f34/tsconfig.json
- .claude/worktrees/wizardly-chatelet-a166c6/tsconfig.json
- bunfig.toml
- tsconfig.json
- tsconfig.scripts.json
- vscode-extension/tsconfig.json

## Test Files

- .claude/worktrees/jolly-vaughan-4bdf70/fixtures/change-impacted-test/src/alpha.extra.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/fixtures/change-impacted-test/src/alpha.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/fixtures/change-impacted-test/src/beta.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/fixtures/change-impacted-test/src/gamma.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/scripts/install-global.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/scripts/sandbox-deep-probe-redaction.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/agents/bootstrap.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/assets/command.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/assets/resolver.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/assets/seed.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/capability/golden-rule.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/capability/no-optional-imports.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/capability/reference.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/capability/seam.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/capability/tui-layout.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/capability/wiring.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/cli.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/agent-approval-binding.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/agent-approval-context.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/agent-commands.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/agent-destructive-gate.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/agent.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/agents.monitor.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/ctx.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/dashboard.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/harness-exec-extension-wave.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/harness-exec-restricted.smoke.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/harness-exec.smoke.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/harness.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/init-mcp-offer.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/init.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/mcp-install.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/metrics.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/module-commands.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/providers.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/rules.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/security-hooks-init.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/select.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/shell-launch.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/shell-pty-launch.smoke.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/shell-slash-registry.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/shell.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/skills-route.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/commands/update.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/contracts/fixtures.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/ctx/hook-install.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/ctx/hook.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/ctx/orient-runtimes.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/ctx/orient.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/ctx/runtimes.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/eval/block-d-corpora.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/eval/corpus.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/flow/allocation.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/flow/context-inject.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/flow/disposition.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/flow/duplicate-ids.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/flow/machine.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/flow/migration.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/flow/schema.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/flow/security-gate.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/flow/service.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/flow/tracker/github.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/gdgraph/affected.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/gdgraph/build-lang.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/gdgraph/build.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/gdgraph/config.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/gdgraph/fallback.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/gdgraph/find.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/gdgraph/path.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/gdgraph/repomap.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/gdgraph/service.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/gdgraph/symbol.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/gdgraph/symbols-capability.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/gdgraph/treesitter/adapter.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/gdgraph/treesitter/extract.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/gdgraph/treesitter/no-treesitter-import.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/gdgraph/treesitter/resolve-calls.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/gdskills/export-plugin.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/gdskills/install.test.ts
- .claude/worktrees/jolly-vaughan-4bdf70/src/gdskills/learn.test.ts

- ... 1210 more

## CI

- .claude/worktrees/jolly-vaughan-4bdf70/.github/workflows/ci.yml
- .claude/worktrees/keryx-harness-phase-1-109f34/.github/workflows/ci.yml
- .claude/worktrees/wizardly-chatelet-a166c6/.github/workflows/ci.yml
- .github/workflows/ci.yml
- .github/workflows/docs.yml
- .github/workflows/release.yml
- .github/workflows/wiki-freshness.yml

## Conventions

- .claude/worktrees/jolly-vaughan-4bdf70/AGENTS.md: For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.
- .claude/worktrees/jolly-vaughan-4bdf70/AGENTS.md: For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.
- .claude/worktrees/jolly-vaughan-4bdf70/CLAUDE.md: For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.
- .claude/worktrees/jolly-vaughan-4bdf70/CLAUDE.md: For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.
- .claude/worktrees/jolly-vaughan-4bdf70/docs/README.md: [Implementation spec](report/release-readiness-2026-07-10/implementation-spec.md)
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0001-d01-release0-boundary.md: 5. **Context manifest** — a bounded, hash-addressed project context scope (code graph, wiki, memory, rules, skills, testing, health, security references) with metadata, freshness indicators, and provenance.
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0001-d01-release0-boundary.md: [specification.md](../../../requirements/keryx-project-agent-harness/specification.md) — architecture, runtime lifecycle, storage model, manifest and config schemas, CLI, tool/policy boundary, durable orchestration.
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0001-d01-release0-boundary.md: ✓ Traceability to implementation-plan.md, acceptance.feature, README, PRD, specification, brainstorm, and schemas
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: structured claims contain **no contradiction** with the frozen specification
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: This is the exact position of the frozen specification:
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: > — specification.md §Orchestration Model
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: > — specification.md §Canonical Ownership and Import Direction
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: orchestrator" (specification.md §Planned Module Map).
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: The frozen specification (§Canonical Ownership and Import Direction) names the
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: | `ContextProvider` | harness context service | graph, ctx, wiki, memory, testing, health adapters | adapter → port | Project brain stays owned by existing modules; harness consumes read-only. |
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: provider SDK, terminal UI, MCP SDK, or a specific subprocess implementation.
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: ports." (specification.md §Architectural Position)
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: section. S-06 is realized in the frozen package by specification.md
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: transitions") is the test gate for the single-coordinator invariant:
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: flow/harness completion parity and failure-disposition tests.
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: TM-01** specifies additive task/run-link fields (dependencies, attempts,
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: [specification.md](../../../requirements/keryx-project-agent-harness/specification.md)
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: S-06** (single coordinator) → specification.md §Orchestration Model +
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md: > frozen spec.
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0003-d03-security-profiles-containment.md: resolution is deterministic, testable, and independent of the CLI/TUI) and D4
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0003-d03-security-profiles-containment.md: `specification.md` §Security Boundary confirms: "Three profiles exist:
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0003-d03-security-profiles-containment.md: S-04** (implementation-plan.md §W1 D-03 traceability id; `specification.md`
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0003-d03-security-profiles-containment.md: time (`specification.md` §Error and Recovery Contracts:
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0003-d03-security-profiles-containment.md: (`specification.md` §Security Boundary). Network enforcement is the broker, not
- .claude/worktrees/jolly-vaughan-4bdf70/docs/decisions/keryx-harness/ADR-0003-d03-security-profiles-containment.md: (`specification.md` §Policy Decision; acceptance `@SC_R05_HARD_DENY`), and

## Recommendations

- none

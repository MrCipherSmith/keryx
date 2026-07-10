# Testing Context

generatedAt: 2026-07-09T21:29:25.307Z

## Frameworks

- bun

## Scripts

- `check`: `tsc --noEmit && bun test`
- `test`: `bun test`

## Configs

- tsconfig.json

## Test Files

- fixtures/change-impacted-test/src/alpha.extra.test.ts
- fixtures/change-impacted-test/src/alpha.test.ts
- fixtures/change-impacted-test/src/beta.test.ts
- fixtures/change-impacted-test/src/gamma.test.ts
- src/agents/bootstrap.test.ts
- src/assets/command.test.ts
- src/assets/resolver.test.ts
- src/assets/seed.test.ts
- src/capability/golden-rule.test.ts
- src/capability/no-optional-imports.test.ts
- src/capability/reference.test.ts
- src/capability/seam.test.ts
- src/capability/wiring.test.ts
- src/cli.test.ts
- src/commands/ctx.test.ts
- src/commands/dashboard.test.ts
- src/commands/init-mcp-offer.test.ts
- src/commands/init.test.ts
- src/commands/mcp-install.test.ts
- src/commands/module-commands.test.ts
- src/commands/rules.test.ts
- src/commands/security-hooks-init.test.ts
- src/commands/skills-route.test.ts
- src/commands/update.test.ts
- src/ctx/hook-install.test.ts
- src/ctx/hook.test.ts
- src/ctx/orient-runtimes.test.ts
- src/ctx/orient.test.ts
- src/ctx/runtimes.test.ts
- src/flow/context-inject.test.ts
- src/flow/machine.test.ts
- src/flow/security-gate.test.ts
- src/flow/service.test.ts
- src/flow/tracker/github.test.ts
- src/gdgraph/affected.test.ts
- src/gdgraph/build.test.ts
- src/gdgraph/config.test.ts
- src/gdgraph/fallback.test.ts
- src/gdgraph/find.test.ts
- src/gdgraph/path.test.ts
- src/gdgraph/repomap.test.ts
- src/gdgraph/service.test.ts
- src/gdgraph/symbol.test.ts
- src/gdgraph/symbols-capability.test.ts
- src/gdgraph/treesitter/adapter.test.ts
- src/gdgraph/treesitter/extract.test.ts
- src/gdgraph/treesitter/no-treesitter-import.test.ts
- src/gdgraph/treesitter/resolve-calls.test.ts
- src/gdskills/export-plugin.test.ts
- src/gdskills/install.test.ts
- src/gdskills/learn.test.ts
- src/gdskills/verify.test.ts
- src/harness/block-d-corpora.test.ts
- src/harness/corpus.test.ts
- src/health/gate.test.ts
- src/health/history.test.ts
- src/health/metrics/complexity-findings.test.ts
- src/health/metrics/complexity.test.ts
- src/health/metrics/hotspot.test.ts
- src/health/parsers.test.ts
- src/health/scopes-component.test.ts
- src/health/scopes.test.ts
- src/health/scoring.test.ts
- src/health/skill-loop.test.ts
- src/health/skills.test.ts
- src/health/sources/sonarqube.test.ts
- src/lib/args.test.ts
- src/lib/security-pre-push.test.ts
- src/lib/ui.test.ts
- src/mcp/boundary.test.ts
- src/mcp/client-config.test.ts
- src/mcp/mcp.test.ts
- src/mcp/no-network.test.ts
- src/mcp/wiki-ask.test.ts
- src/memory/dedup.test.ts
- src/memory/embedding/embedding.test.ts
- src/memory/ingest.test.ts
- src/memory/no-network.test.ts
- src/memory/reflect.test.ts
- src/memory/relevant.test.ts

- ... 30 more

## CI

- .github/workflows/ci.yml

## Conventions

- AGENTS.md: For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.
- AGENTS.md: For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.
- CLAUDE.md: For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.
- CLAUDE.md: For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.
- docs/README.md: [Release readiness — 2026-07-10](report/release-readiness-2026-07-10/implementation-spec.md)
- docs/docs/README.md: | testing | `keryx test` | Detect the test stack, run the project's existing runner (optionally changed-scoped), normalize results into a report. |
- docs/docs/architecture.md: | **gdwiki** | `src/wiki/` | `wiki` | File-based project knowledge base with hierarchical full-coverage collection, link validation, code/wiki backlinks, bounded context, and grounded retrieval. |
- docs/docs/architecture.md: | **testing** | `src/testing/` | `test` | Detect the test stack, run the project's existing runner (optionally changed-scoped), normalize results into a report. |
- docs/docs/architecture.md: | **harness** | `src/harness/` | — (test-time) | Fixture-corpus acceptance harness: `runCorpus`/`gateCorpus` produce deterministic precision/recall/FN-rate reports used as CI gates by multiple opt-in blocks. |
- docs/docs/architecture.md: > With **zero opt-in flags and no assets present**, every command and the full test suite behave **byte-identically** to the deterministic core — no optional dependency is loaded, and no socket is opened.
- docs/docs/architecture.md: `resolveCapability(cwd, spec: CapabilitySpec) → CapabilityAdapter | null` is the sanctioned way to reach any opt-in behavior. It gates, in order, on:
- docs/docs/architecture.md: 2. **Optional dependency importable** — loaded lazily via `await import(spec.optionalDependency)` inside the seam only (the sole place an optional dep is loaded).
- docs/docs/architecture.md: boundary tests keep optional packages out of the deterministic startup path.
- docs/docs/architecture.md: A **pure, SDK-free dispatch core** (`dispatch.ts`) drivable directly in-process by unit tests (the parity gate) and by the real server.
- docs/docs/architecture.md: testing** — a coverage-map capability (`src/testing/coverage-map.ts`, `src/testing/capability.ts`) over the default heuristic report.
- docs/docs/architecture.md: ├── *.config.json             # per-module config, seed-once (gdctx/health/testing/memory)
- docs/docs/architecture.md: ├── testing/{artifacts,history,context.md,logs}/
- docs/docs/architecture.md: testing[testing run]
- docs/docs/architecture.md: health  -. latest.json .-> gdwiki
- docs/docs/architecture.md: testing -. context.md .-> gdwiki
- docs/docs/architecture.md: testing -. latest.json .-> gdskills
- docs/docs/architecture.md: health  -. latest.json .-> gdskills
- docs/docs/architecture.md: testing  -. snapshot .-> dashboard
- docs/docs/architecture.md: testing == loadCompatibleTestingReport ==> health
- docs/docs/architecture.md: testing == guardOutput ==> security
- docs/docs/architecture.md: 1. **testing → health** — the health `tests` source adapter reuses testing's `loadCompatibleTestingReport` and `TestingReport` type instead of re-running tests.
- docs/docs/architecture.md: testing run → security** (`guardOutput`, target report) before persisting the raw log;
- docs/docs/architecture.md: Two external dependencies also cross module boundaries: the **gh CLI** feeds flow's tracker (issue body, PR draft/checks, completion comment) and, via git, testing's changed-file detection.
- docs/docs/architecture.md: 2. Scaffold base dirs plus per-enabled-module dirs (`core/`, `data/`, `skills/`, and module-specific folders derived from `WIKI_PAGE_TYPES`/`MEMORY_TYPES`).
- docs/docs/architecture.md: 4. gdgraph copies vendored core scripts and renders a local `cli.ts`; gdskills runs `installGdskills(profile)`; testing runs `analyzeTestingProject` once.

## Recommendations

- none

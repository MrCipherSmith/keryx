# Testing Context

generatedAt: 2026-07-07T00:34:35.520Z

## Frameworks

- bun

## Scripts

- `check`: `tsc --noEmit && bun test`
- `test`: `bun test`

## Configs

- tsconfig.json

## Test Files

- src/health/gate.test.ts
- src/health/history.test.ts
- src/health/metrics/complexity-findings.test.ts
- src/health/metrics/complexity.test.ts
- src/health/parsers.test.ts
- src/health/scopes-component.test.ts
- src/health/scopes.test.ts
- src/health/scoring.test.ts
- src/health/skill-loop.test.ts
- src/health/skills.test.ts
- src/health/sources/sonarqube.test.ts
- src/memory/dedup.test.ts
- src/memory/ingest.test.ts
- src/memory/reflect.test.ts
- src/memory/relevant.test.ts
- src/memory/search.test.ts
- src/memory/store.test.ts
- src/testing/service.test.ts


## CI

- none

## Conventions

- AGENTS.md: For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.
- AGENTS.md: For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.
- docs/requirements/code-health/README.md: Complexity — token-based приближение (не полный AST). Phase 3 (future): семантический entity/store detection, мульти-язык, richer analytics/dashboards. См. [specification.md](specification.md) sections 2 и 21.
- docs/requirements/code-health/README.md: [specification.md](specification.md) - техническая спецификация CLI, storage, sources, scoring и интеграции с `gdskills`.
- docs/requirements/code-health/README.md: `testing` - владеет test context/execution/reporting; Code Health читает `.metaproject/data/testing/artifacts/latest.json` как источник test findings.
- docs/requirements/code-health/README.md: `spec-orchestrator` - включает Code Health при `gd-metapro init` и предлагает optional lightweight hook.
- docs/requirements/code-health/brainstorm.md: test coverage;
- docs/requirements/code-health/brainstorm.md: | A. Report Aggregator | Собирает ESLint, TS, coverage, audit, Sonar и делает единый summary. | Быстрый MVP, понятный агенту. | Без gate и истории мало управленческой ценности. |
- docs/requirements/code-health/brainstorm.md: [specification.md](specification.md) section 2 (D1-D12).
- docs/requirements/code-health/brainstorm.md: | D1 | Источники v1 first-class | Core-5 (eslint, typescript, tests, coverage, dependency audit); Sonar/complexity-tools — адаптеры | нет |
- docs/requirements/code-health/brainstorm.md: | D6 | Связь с gdskills | decoupled: health — producer, gdskills читает `latest.json` через `skills learn --from-health` | нет |
- docs/requirements/code-health/brainstorm.md: | D10 | Scope-метрики v1 | finding counts, coverage, churn (git), cyclomatic complexity (AST) | **да** — complexity включён в v1 (рекомендация была отложить в adapter) |
- docs/requirements/code-health/prd.md: Status: production-ready scope frozen (see [specification.md](specification.md) section 2 and [brainstorm.md](brainstorm.md) section 5)
- docs/requirements/code-health/prd.md: ESLint, TypeScript, tests, coverage, SonarQube, complexity tools и dependency audit дают разные форматы вывода. Агенту нельзя каждый раз читать сырые логи: это дорого по токенам, шумно и плохо приоритизировано.
- docs/requirements/code-health/prd.md: As `skill-verify-skill`, I want to consume health findings, so that skills can learn from repeated lint/type/test/coverage/complexity problems in skill-owned code.
- docs/requirements/code-health/prd.md: `gdskills` learning requires source/provenance/confidence and respects protected manual sections.
- docs/requirements/code-health/specification.md: Code Health: technical specification
- docs/requirements/code-health/specification.md: | D6 | gdskills coupling | Decoupled: Code Health is a producer; gdskills consumes `latest.json` via `skills learn --from-health`. |
- docs/requirements/code-health/specification.md: | D10 | Scope metrics in v1 | finding counts, coverage, churn (git), cyclomatic complexity (token-based). |
- docs/requirements/code-health/specification.md: "tests":           { "mode": "auto",     "required": false },
- docs/requirements/code-health/specification.md: "coverage":        { "mode": "import",   "required": false },
- docs/requirements/code-health/specification.md: "coverageTarget": 80,
- docs/requirements/code-health/specification.md: "coverageSoftFloor": 60,
- docs/requirements/code-health/specification.md: "coverageWeight": 1,
- docs/requirements/code-health/specification.md: Core-5 first-class sources: `eslint`, `typescript`, `tests`, `coverage`,
- docs/requirements/code-health/specification.md: default). The `tests` source imports Testing Module reports first and only uses
- docs/requirements/code-health/specification.md: legacy direct runner fallback when no normalized test report exists. The built-in complexity metric is also emitted as P2 findings.
- docs/requirements/code-health/specification.md: "message": "Unexpected any. Specify a different type.",
- docs/requirements/code-health/specification.md: | P0 | TypeScript errors; failing tests; dependency audit `critical`/`high`. |
- docs/requirements/code-health/specification.md: | P1 | ESLint `error`; dependency audit `moderate`; coverage below `coverageSoftFloor`. |

## Recommendations

- No CI test workflow detected. Add CI gate separately from local Metaproject hooks.

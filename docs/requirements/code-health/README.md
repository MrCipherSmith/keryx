# Code Health requirements

Version: 0.8.1
Status: Phase 1 + Phase 2 complete (module implemented). Sonar adapter, complexity findings, skill/component scopes, gdskills learn-loop, and history trends shipped. Testing Module is now the planned owner of test execution/reporting, with Code Health consuming normalized testing reports. Phase 3 (advanced) is future.

`Code Health` - модуль Metaproject для агрегации качества кода. Он собирает технические источники качества, нормализует findings, считает health/risk metrics на разных уровнях гранулярности и превращает сырые логи в agent-readable Markdown/JSON reports. Post-commit hook is non-mutating: it reports possible staleness and points to explicit `gd-metapro health run ...` commands.

## Статус

Phase 1 реализована: модуль `src/health/` (адаптеры Core-5, scoring, gate, baseline, метрики churn/complexity), CLI `gd-metapro health run|status|gate|sources|explain|baseline update|trend`, интеграция в `gd-metapro init` (`--no-health`, `health.config.json`, manifest, skill). Decoupled-контракт findings (`data/health/artifacts/latest.json`) для `gd-metapro skills learn --from-health`.

Phase 2 (завершена): skill-owned scope (`scope.skill` + `skills learn --from-health` loop), directory-level component scopes, SonarQube-адаптер (import), complexity → P2 findings, multi-run тренды (`gd-metapro health trend` по `data/health/history`), generated/static ignore paths, и безопасная интеграция с Testing Module без неявного полного test-suite запуска.

Complexity — token-based приближение (не полный AST). Phase 3 (future): семантический entity/store detection, мульти-язык, richer analytics/dashboards. См. [specification.md](specification.md) sections 2 и 21.

## Документы

- [prd.md](prd.md) - продуктовые требования, сценарии и метрики успеха.
- [specification.md](specification.md) - техническая спецификация CLI, storage, sources, scoring и интеграции с `gdskills`.
- [brainstorm.md](brainstorm.md) - результаты brainstorm/interviewer и принятые решения.

## Связанные модули

- `gdctx` - сохраняет raw outputs и compact summaries для команд health checks.
- `gdgraph` - связывает findings с файлами, модулями, сущностями и affected scopes.
- `gdskills` - использует health findings как signal для `skill-verify-skill` и `gd-metapro skills learn --from-health`.
- `testing` - владеет test context/execution/reporting; Code Health читает `.metaproject/data/testing/artifacts/latest.json` как источник test findings.
- `spec-orchestrator` - включает Code Health при `gd-metapro init` и предлагает optional lightweight hook.

## Рабочее имя CLI

Namespace CLI: `gd-metapro health`.

Причина: `health` короче и удобнее как пользовательская команда, а документационный модуль остается `Code Health`.

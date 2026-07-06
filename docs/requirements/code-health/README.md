# Code Health requirements

Version: 0.5.0
Status: Phase 1 + skill-owned scope loop + history trends implemented. CLI `gd-metapro health` (incl. `trend`), init scaffold, and the gdskills `learn --from-health` loop shipped.

`Code Health` - модуль Metaproject для агрегации качества кода. Он собирает технические источники качества, нормализует findings, считает health/risk metrics на разных уровнях гранулярности и превращает сырые логи в agent-readable Markdown/JSON reports.

## Статус

Phase 1 реализована: модуль `src/health/` (адаптеры Core-5, scoring, gate, baseline, метрики churn/complexity), CLI `gd-metapro health run|status|gate|sources|explain|baseline update`, интеграция в `gd-metapro init` (`--no-health`, `health.config.json`, manifest, skill). Decoupled-контракт findings (`data/health/artifacts/latest.json`) для `gd-metapro skills learn --from-health`.

Phase 2 (частично): skill-owned scope — Code Health читает реестр project-skills gdskills, проставляет `scope.skill` на findings и считает `skill:<module>/<name>` метрики; `skills learn --from-health` авто-резолвит владеющий skill и скоупит уроки по нему.

Complexity — token-based приближение (не полный AST). `gd-metapro health trend` даёт multi-run тренды по `data/health/history`. Остаток Phase 2: Sonar/complexity-tools адаптеры, entity/component scopes. См. [specification.md](specification.md) sections 2 и 21.

## Документы

- [prd.md](prd.md) - продуктовые требования, сценарии и метрики успеха.
- [specification.md](specification.md) - техническая спецификация CLI, storage, sources, scoring и интеграции с `gdskills`.
- [brainstorm.md](brainstorm.md) - результаты brainstorm/interviewer и принятые решения.

## Связанные модули

- `gdctx` - сохраняет raw outputs и compact summaries для команд health checks.
- `gdgraph` - связывает findings с файлами, модулями, сущностями и affected scopes.
- `gdskills` - использует health findings как signal для `skill-verify-skill` и `gd-metapro skills learn --from-health`.
- `spec-orchestrator` - включает Code Health при `gd-metapro init` и предлагает optional lightweight hook.

## Рабочее имя CLI

Namespace CLI: `gd-metapro health`.

Причина: `health` короче и удобнее как пользовательская команда, а документационный модуль остается `Code Health`.

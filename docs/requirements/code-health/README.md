# Code Health requirements

Version: 0.2.0
Status: production-ready specification (v1 scope frozen, not yet implemented)

`Code Health` - модуль Metaproject для агрегации качества кода. Он собирает технические источники качества, нормализует findings, считает health/risk metrics на разных уровнях гранулярности и превращает сырые логи в agent-readable Markdown/JSON reports.

## Статус

Пакет требований доведён до production-ready: решения зафиксированы через brainstorm + interview (D1-D12), заданы контракты (`SourceAdapter`, `CodeHealthService`), дефолтные формулы scoring, политика gate, схема findings с версионированием и фазовый план. Готов к имплементации Phase 1. См. [specification.md](specification.md) sections 2 и 21.

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

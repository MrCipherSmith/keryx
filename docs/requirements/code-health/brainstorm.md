# Code Health: brainstorm and interview decisions

Version: 0.2.0
Status: production-ready decisions frozen (see section 5)

## 1. Исходная задача

Нужен модуль, который агрегирует качество кода и превращает технические отчеты в понятный агенту health report.

Исходные источники:

- SonarQube;
- ESLint;
- TypeScript diagnostics;
- test coverage;
- complexity metrics;
- dependency audit.

Ожидаемая реализация:

- основа: TS/Bun;
- результат: нормализованный Markdown/JSON report;
- агент читает не сырые логи, а агрегированную выжимку с приоритетами.

Дополнительное решение: Code Health должен использоваться как signal для `skill-verify-skill`.

## 2. Brainstorm options

| Option | Description | Strengths | Risks |
|---|---|---|---|
| A. Report Aggregator | Собирает ESLint, TS, coverage, audit, Sonar и делает единый summary. | Быстрый MVP, понятный агенту. | Без gate и истории мало управленческой ценности. |
| B. Aggregator + Quality Gate | Делает report и статус `pass/warn/fail`. | Хорошо для orchestrators, hooks и CI. | Нужны thresholds и severity mapping. |
| C. Historical Health Tracker | Хранит историю, тренды, recurring issues. | Полезно для legacy и release notes. | Требует storage и baseline lifecycle. |
| D. Health + Skill Feedback Loop | Health findings связываются с generated entity skills. | Прямо улучшает `skill-verify-skill`. | Нужен общий finding schema и scope mapping. |

## 3. Selected direction

Выбран подход:

- **D по архитектуре**: Code Health включает aggregator, quality gate, history/trends и skill feedback loop.
- MVP может идти итеративно: сначала aggregator + gate, затем baseline/history и deeper `gdskills` learning.

## 4. Interview decisions

### 4.1 MVP mode

Решение: **D**.

Code Health должен поддерживать:

- normalized health report;
- quality gate;
- history/trends;
- integration with `gdskills`.

### 4.2 Sources

Решение: **D, auto-detected sources**.

Модуль сам определяет доступные источники. Каждый source получает статус:

- `available`;
- `missing`;
- `configured-but-failed`;
- `skipped`.

Проект может настроить обязательные источники через `.metaproject/metaproject.json`.

### 4.3 Source execution mode

Решение: **D, configurable per source**.

Каждый source поддерживает режим:

- `auto`;
- `run`;
- `import`;
- `disabled`.

### 4.4 Integration with skill-verify-skill

Решение: **D**.

Code Health должен:

- писать findings в shared schema;
- предоставлять direct integration через `gd-metapro skills learn --from-health`;
- использоваться `skill-verify-skill` как verification signal.

### 4.5 Report detail

Решение: **D, layered report**.

Outputs:

- Markdown summary для агента;
- full normalized JSON для инструментов;
- raw logs отдельно.

### 4.6 Granularity

Code Health должен вести показатели здоровья на уровнях:

- project;
- module;
- entity/component;
- file;
- skill-owned scope.

### 4.7 Scoring

Решение: **D, hybrid rule-based + trend-based**.

Модуль считает:

- `health_score`;
- `risk_score`;
- `trend`;
- `regression_score`.

### 4.8 Baseline/history storage

Решение: **C, hybrid**.

- baseline версионируется;
- runtime history хранится как generated data.

### 4.9 Automatic run triggers

Решение: **D**.

Code Health запускается:

- вручную через CLI;
- в orchestrator/review pipeline;
- через optional lightweight hook, если пользователь включил его при `gd-metapro init`.

## 5. Production-ready interview decisions

Second interview pass (questions with options and a recommendation) to move the
package from MVP to production-ready. All decisions are frozen for v1 and drive
[specification.md](specification.md) section 2 (D1-D12).

| # | Вопрос | Решение | Отклонение от рекомендации |
|---|---|---|---|
| D1 | Источники v1 first-class | Core-5 (eslint, typescript, tests, coverage, dependency audit); Sonar/complexity-tools — адаптеры | нет |
| D2 | Скоринг | Документированные дефолтные формулы/веса + override в конфиге | нет |
| D3 | Quality gate | fail на P0/критичном или регрессии к baseline; warn по порогам; иначе pass | нет |
| D4 | Baseline | accept-current на enable; далее только явный `baseline update` | нет |
| D5 | Конфиг | отдельный `.metaproject/health.config.json` (как `gdctx.config.json`) | нет |
| D6 | Связь с gdskills | decoupled: health — producer, gdskills читает `latest.json` через `skills learn --from-health` | нет |
| D7 | Расширяемость источников | типизированный `SourceAdapter { detect, run, import, parse }` | нет |
| D8 | Детерминизм/CI | `auto` = import-if-present иначе safe-local-run; `--strict` запрещает fallback и падает на missing required; provenance | нет |
| D9 | Scopes v1 | project + module + file (через gdgraph); entity/skill — позже | нет |
| D10 | Scope-метрики v1 | finding counts, coverage, churn (git), cyclomatic complexity (AST) | **да** — complexity включён в v1 (рекомендация была отложить в adapter) |
| D11 | Семантика отказов источника | required/optional; missing/failed required → fail(--strict)/warn; optional → skipped | нет |
| D12 | Finding schema | versioned (`schemaVersion`) стабильный контракт, semver, валидация у consumer | нет |

### 5.1 Обоснование отклонения (D10)

Complexity перенесён в v1 как встроенная AST-метрика (не внешний инструмент),
потому что цель — production-ready, а cyclomatic complexity на TS/JS дёшева и
детерминирована и нужна для приоритизации hot-spots. Внешние complexity-tools
(например Sonar-правила) остаются pluggable-адаптерами.

### 5.2 Итоговое направление

Production v1 = ядро варианта C (aggregator + gate + baseline/trends + decoupled
skills-контур) с узким детерминированным набором источников (Core-5) и стабильным
adapter/schema-контрактом. Sonar, внешние complexity-tools, entity/skill scopes и
сквозной gdskills learning — Phase 2.

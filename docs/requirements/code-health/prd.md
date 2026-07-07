# Code Health: PRD

Version: 0.2.2
Status: production-ready scope frozen (see [specification.md](specification.md) section 2 and [brainstorm.md](brainstorm.md) section 5)

## 1. Purpose

Code Health агрегирует технические сигналы качества кода и превращает их в agent-readable health reports. Модуль должен помогать агенту и разработчику понимать, где качество ухудшается, какие проблемы приоритетны и какие scopes требуют внимания.

## 2. Users

- AI-агент, которому нужен короткий prioritized report вместо длинных логов.
- Разработчик, который хочет быстро понять состояние проекта, модуля, компонента или файла.
- Orchestrator, который должен запускать quality gate после implementation/review fixes.
- `gdskills` verifier, которому нужны health signals для обновления entity skills.

## 3. Problem

ESLint, TypeScript, tests, coverage, SonarQube, complexity tools и dependency audit дают разные форматы вывода. Агенту нельзя каждый раз читать сырые логи: это дорого по токенам, шумно и плохо приоритизировано.

Нужен единый слой, который нормализует findings, связывает их с files/modules/entities/skills и выдает короткий отчет с приоритетами.

## 4. Goals

- Auto-detect health sources.
- Поддержать per-source режимы `auto`, `run`, `import`, `disabled`.
- Генерировать layered output: Markdown summary, JSON full report, raw logs.
- Считать `health_score`, `risk_score`, `trend`, `regression_score`.
- Вести health metrics на уровнях project/module/entity/file/skill-owned scope.
- Поддержать quality gate со статусами `pass`, `warn`, `fail`.
- Хранить versioned baseline и runtime history.
- Интегрироваться с `gdskills` и `skill-verify-skill`.
- Запускаться вручную, из orchestrator/review pipeline и optional hook.

## 5. Non-goals for production v1

- Полная замена SonarQube (Sonar подключается как адаптер).
- Complexity сверх встроенной cyclomatic-метрики на TS/JS; продвинутые/внешние complexity-алгоритмы — через адаптеры.
- Поддержка всех языков (v1 TS/JS-first; прочие — через адаптеры, иначе `skipped`).
- semantic entity/store scopes (component directory and skill-owned scopes are shipped in Phase 2).
- Сквозной gdskills learning в рантайме health (health лишь пишет findings; gdskills читает их сам).
- Full analytics UI beyond the current dashboard diagnostics.
- Блокирующий pre-commit hook по умолчанию (hook опционален и lightweight).

## 6. User Stories

### 6.1 Run project health

As a developer, I want to run:

```bash
gd-metapro health run
```

So that I get a prioritized Markdown/JSON report without reading raw tool logs.

Acceptance criteria:

- Report includes source statuses.
- Report includes `pass/warn/fail`.
- Report includes P0/P1/P2 findings.
- Raw logs are stored separately.

### 6.2 Check changed scopes in orchestrator

As an orchestrator, I want to run Code Health after implementation and review fixes, so that final output contains quality gate status and regressions.

Acceptance criteria:

- Health can run against changed/affected files.
- Findings include affected files and scopes.
- Gate status is included in orchestrator final report.

### 6.3 Track health by granularity

As a developer, I want health metrics for project, module, entity and file, so that I can understand where quality is degrading.

Acceptance criteria:

- JSON report contains scope metrics.
- Each scope has scores and trend.
- Scope metrics can be mapped to `gdgraph` nodes and `gdskills` ownership.

### 6.4 Feed skill verification

As `skill-verify-skill`, I want to consume health findings, so that skills can learn from repeated lint/type/test/coverage/complexity problems in skill-owned code.

Acceptance criteria:

- Code Health writes normalized findings.
- `gd-metapro skills learn --from-health <report>` is supported.
- Health findings can update skill lessons/checklists/templates based on autonomy policy.

## 7. Success Metrics

- Agents read Markdown summary instead of raw logs.
- Health gate catches regressions before final job report.
- Health findings are mapped to files/modules/entities.
- Repeated health issues can produce `gdskills` learning proposals.
- Baseline makes legacy projects actionable without requiring perfect health immediately.

## 8. Risks

- Hooks can slow down local workflow.
- Auto-detected sources can produce inconsistent reports across machines.
- Scores can hide important critical findings if weighted poorly.
- Health learning can overfit skills to incidental one-off findings.

Mitigations:

- Optional lightweight hooks only.
- Source status and command provenance in every report.
- Critical findings always visible independent of aggregate score.
- Dashboard explains score/risk/gate separately, documents P0/P1/P2/P3 meanings and score formula, recommends what to fix first, and warns when reports contain generated/static scopes, missing coverage, failed sources, or findings without file paths.
- `gdskills` learning requires source/provenance/confidence and respects protected manual sections.

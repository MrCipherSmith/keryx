# gdskills: PRD

Version: 0.7.0

## 1. Purpose

`gdskills` управляет lifecycle skills в Metaproject: рабочими skills/orchestrators самого Metaproject и `project-skills`, которые завязаны на конкретные сущности целевого проекта.

Модуль должен создавать, проверять, обучать, экспортировать и синхронизировать versioned project skills, которые можно использовать при создании, изменении, рефакторинге и ревью кода.

## 2. Users

- Разработчик, который хочет быстро создать новый feature component по существующему паттерну.
- AI-агент, который должен понять, как правильно работать с конкретной сущностью.
- Reviewer/subagent, который проверяет, не устарел ли skill после изменения архитектуры.
- Orchestrator, который запускает implementation/review pipeline и должен передавать subagents точный entity context.
- Metaproject maintainer, который развивает native working skills и orchestrators внутри `gd-metapro`.

## 3. Problem

В больших проектах знания о модуле часто распределены между кодом, wiki, review comments, тестами и устными договоренностями. Агент без entity-specific skill вынужден читать слишком много файлов или действует по общим правилам, пропуская локальные паттерны.

Пример: `pipelines/step` может иметь общий каркас component + store + config + tests, но каждая step-сущность добавляет свою бизнес-логику. Skill должен объяснить общий каркас и заставить агента спросить о специфике перед генерацией или изменением step.

## 4. Goals

- Разделить рабочие `gdskills` и контентно-зависимые `project-skills`.
- Поставлять reusable working skills внутри `gd-metapro`, без runtime-зависимости от `goodai-base` или внешних глобальных skill-наборов.
- Определить максимальный bundled package: orchestration, review, quality, workflow, planning/docs, routing и platform/config skills.
- Поддержать профили установки `minimal`, `recommended`, `full`, `custom`; default - `recommended`.
- Генерировать project skill по path, symbol или wiki reference.
- Использовать `gdgraph`, `gdctx` и `gdwiki` как источники evidence.
- Хранить canonical generated project skills в `.metaproject/project-skills/<module>/<entity>/`.
- Поддерживать простой `SKILL.md` и пакетный формат для сложных сущностей.
- Поддерживать рабочие skills: `entity-skill-router`, `entity-skill-creator`, `entity-skill-verifier`, `entity-skill-learner`.
- Экспортировать runtime skills для Codex/Claude по best practices.
- Вести версию каждого skill и `skill-changelog.md`.
- Проверять актуальность skills через CLI, optional hook и orchestrator/review pipeline.
- Обновлять skills на основе code changes, wiki decisions, test failures, review lessons, Code Health findings и accepted Documentation Memory entries.
- Защищать manual sections и обновлять только machine-managed sections без явного разрешения.

## 5. Non-goals for MVP

- Полностью универсальная генерация для всех языков.
- Remote marketplace skills.
- UI для просмотра и редактирования skills.
- Нечитаемые binary/vector-only skills.
- Автоматическое изменение production code внутри `skills verify`; verifier меняет только skill artifacts или создает proposed patch.

## 6. User Stories

### 6.1 Generate skill for module entity

As a developer, I want to run:

```bash
gd-metapro skills generate src/pipelines/steps/http-step
```

So that Metaproject creates an entity skill that explains structure, patterns, templates, tests and review rules for this step type.

Acceptance criteria:

- Skill is created under `.metaproject/project-skills/pipelines/http-step/`.
- Skill contains `Version: 0.1.0`.
- Skill references source files, wiki pages and graph evidence.
- Skill includes a create/refactor workflow and questions for variable business logic.
- `skill-changelog.md` is created.

### 6.2 Use skill in implementation

As an AI-agent, I want to read the relevant entity skill before editing a component, so that generated code follows project-local patterns.

Acceptance criteria:

- `.metaproject/index.md` points agents to generated project skills.
- Skill includes files to read and constraints.
- Skill tells the agent when to use `gdgraph`, `gdctx` and `gdwiki`.

### 6.3 Verify stale skill

As a reviewer, I want to run:

```bash
gd-metapro skills verify .metaproject/project-skills/pipelines/http-step
```

So that I can see whether the skill still matches code, graph, wiki and review lessons.

Acceptance criteria:

- Verifier reports fresh/stale status.
- Verifier lists changed evidence and affected sections.
- Verifier creates proposed update or applies allowed machine-managed updates based on config.

### 6.4 Learn from review

As an orchestrator, I want to call skill learning after review findings, so that future generated code avoids the same mistakes.

Acceptance criteria:

- Review finding is classified as lesson, anti-pattern, checklist update, template update or workflow update.
- Skill version is incremented when changed.
- `skill-changelog.md` records version, date, source, reason, changed sections and confidence.

### 6.5 Learn from Code Health

As `skill-verify-skill`, I want to consume Code Health findings, so that repeated lint/type/test/coverage/complexity/audit issues in skill-owned code can improve the skill.

Acceptance criteria:

- Health findings are mapped to affected skills.
- P0/P1 findings can mark a skill as `needs-review`.
- Repeated findings can create lessons, anti-patterns, checklist updates or template updates.
- Health-derived changes are recorded in `skill-changelog.md`.

### 6.6 Learn from Documentation Memory

As `skill-verify-skill`, I want to consume accepted memory entries, so that skills reflect known lessons, decisions, constraints and mistakes.

Acceptance criteria:

- Memory entries are mapped to affected skills by related scopes.
- Accepted decisions/constraints can mark a skill as stale/conflicting.
- Accepted lessons/patterns can update workflow/checklists/templates.
- Draft memory entries are advisory only.
- Memory-derived changes are recorded in `skill-changelog.md`.

## 7. Success Metrics

- Generated skill reduces raw file reads for repeated entity tasks.
- Agents use entity skills without user explicitly requesting them.
- Verifier detects stale skills after relevant code/wiki changes.
- Verifier uses Code Health findings as a verification and learning signal.
- Verifier uses accepted Documentation Memory entries as a verification and learning signal.
- Review findings caused by missing local patterns decrease over time.
- Skill changelog allows tracing why every rule was added.
- Runtime/exported skills remain compact and compatible with Codex/Claude skill conventions.

## 8. Risks

- Autonomous learning can encode wrong review conclusions.
- Generated skills can become too large and expensive to read.
- Manual edits can be overwritten without protected sections.
- Hook can slow down commits if semantic verification is too broad.

Mitigations:

- Configurable autonomy.
- Evidence/provenance per generated section.
- Machine-managed markers.
- Cheap candidate detection before semantic verification.
- `skill-changelog.md` for auditability.

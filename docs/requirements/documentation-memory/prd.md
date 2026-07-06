# Documentation Memory: PRD

Version: 0.1.0

## 1. Purpose

Documentation Memory хранит долговременный проектный опыт в структурированном виде и возвращает агенту короткий релевантный контекст. Модуль помогает не повторять прошлые ошибки, учитывать принятые решения, ограничения и паттерны при реализации, ревью и генерации skills.

## 2. Users

- AI-агент, которому нужен компактный исторический и проектный контекст.
- Разработчик, который хочет зафиксировать lesson, decision, constraint или known mistake.
- Orchestrator, который после задачи предлагает сохранить важные decisions/lessons.
- `skill-verify-skill`, который проверяет, не противоречит ли skill accepted memory entries.

## 3. Problem

Проектные знания часто остаются в чатах, PR comments, job reports и памяти людей. Агент без долговременной памяти повторяет старые ошибки, игнорирует исторические решения и читает слишком много нерелевантных документов.

Нужен слой, который хранит память в Markdown, индексирует ее и возвращает короткие snippets с provenance и статусом.

## 4. Goals

- Хранить memory entries в Markdown как source of truth.
- Поддержать typed memory registry.
- Реализовать MVP templates для `lesson`, `decision`, `constraint`, `known-mistake`.
- Индексировать entries и chunks через TS/Bun.
- Возвращать layered search output: Markdown summary, JSON results, raw entry links.
- Поддержать dedup suggestions и conflict workflow.
- Пополнять memory вручную, из orchestrators/job reports, review/health findings и skill verifier.
- Интегрироваться с `gdskills` и `skill-verify-skill`.
- Проектировать schema так, чтобы позже добавить embeddings.

## 5. Non-goals for MVP

- Обязательные embeddings.
- Облачная синхронизация.
- UI для memory management.
- Автоматическое принятие всех memory suggestions.
- Хранение секретов, приватных токенов или персональных данных.

## 6. User Stories

### 6.1 Create memory entry

As a developer, I want to run:

```bash
gd-metapro memory new lesson
```

So that I can save a structured lesson with provenance and related files/modules/entities.

Acceptance criteria:

- Entry is created as Markdown.
- Entry includes `Version`, `Type`, `Status`, `Provenance`, tags and related scopes.
- New entry starts as `draft` unless created with explicit accepted mode.

### 6.2 Search memory

As an AI-agent, I want to run:

```bash
gd-metapro memory search "pipeline step store pattern"
```

So that I get a short relevant context instead of reading all memory files.

Acceptance criteria:

- Search returns 3-10 curated snippets.
- Output includes type, status, confidence, provenance and links.
- Full JSON results are saved for tools.

### 6.3 Use memory in skill verification

As `skill-verify-skill`, I want to compare a skill against accepted memory entries, so that outdated or conflicting skill instructions are detected.

Acceptance criteria:

- Verifier can search memory by skill target, files, module and entity.
- Accepted constraints/decisions can mark a skill as stale/conflicting.
- Accepted lessons/patterns can update skill sections based on autonomy policy.
- Draft entries are advisory only.

### 6.4 Populate memory from workflow artifacts

As an orchestrator, I want to propose memory entries from job reports, review findings and health findings, so that project knowledge survives after the task.

Acceptance criteria:

- Proposed entries include provenance.
- Similar entries trigger dedup suggestions.
- Conflicting entries get `conflict` status or require resolution.

## 7. Success Metrics

- Agents use memory search before broad historical/context questions.
- Search output stays compact and relevant.
- Accepted memory entries influence skill verification.
- Repeated mistakes become visible as accepted known mistakes or lessons.
- Duplicate/conflicting memory does not silently degrade verifier quality.

## 8. Risks

- Memory can become noisy if draft suggestions are auto-accepted.
- Conflicting decisions can confuse agents.
- Semantic search without provenance can hallucinate policy.
- Too much context can defeat the purpose of compact memory.

Mitigations:

- Status workflow with `draft`, `accepted`, `deprecated`, `conflict`, `superseded`.
- Provenance required for every entry.
- Layered output with short Markdown summary.
- Only accepted entries can automatically affect skills.

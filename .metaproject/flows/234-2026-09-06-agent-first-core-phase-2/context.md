# Контекст этапа 2
Version: 0.2.0

Project: /Users/Goodea/goodea/keryx. Integration branch: codex/agent-first-core; recorded base main@0bc6418fa1a038f8ec909cf949fecba077acf9a4.

Specs: docs/requirements/keryx-agent-first-core/README.md, specification.md, policies.md, artifact-lifecycle.md, decision-traceability.md.

Зависимости: этап 1 (flow 233). Root проверяет delivery evidence prerequisite до dependent implementation: CLI зависит только от задач одного flow, межflow DAG обеспечивается оркестратором явно. Независимый контекст и тест-дизайн собираются заранее — это разрешено и уже начато.

Перед стартом: перечитать index, relevant graph/wiki/memory, current source и testing/health. Historical PASS и старый `.worktrees` inventory не доказательство текущего состояния. Stats disabled. Workers никогда не меняют flow.json/frozen AC/git; код по непересекающимся ownership.

## Нормативы и владельцы кода (инвентаризация 2026-09-06, root)

Инвентаризация выполнена read-only через `keryx ctx rg`/`ls` на текущем дереве. gdgraph-снимок устарел (последняя сборка 12:32 UTC, десятки некоммиченных файлов), поэтому источником считается текущий checkout, а не граф.

| Норматив | Вероятные владельцы | Заметки для декомпозиции |
|---|---|---|
| AC-06 lifecycle retrieval | `src/memory/lifecycle.ts`, `src/memory/search.ts`, `src/memory/relevant.ts`, `src/wiki/*` retrieval | Единый допуск для wiki и memory: границы дат UTC, future/deprecated/conflict/superseded/malformed, явная метка historical. Существующий memory lifecycle (пакет Memory Reliability) сохраняем, расширяем согласованность с wiki. |
| AC-09 testing snapshot | `src/testing/*`, `.metaproject/data/testing/context.json` | Текущий testing context загрязнён `.claude/worktrees/*` — это подтверждённый дефект и первая regression. Refresh-невозможность должна давать `incomplete`, а не `no-tests`. |
| AC-10 graph snapshot | `src/gdgraph/staleness.ts`, `src/gdgraph/service.ts`, `src/gdgraph/build.ts` | Инвалидация по новому commit/untracked/delete/rename/config; unknown target отличается от indexed-without-edges; git-ошибка не превращается в fresh. |
| AC-11 типы связей | `src/gdgraph/build.ts`, `src/gdgraph/query.ts`, `src/gdgraph/types.ts`, тесты `import-kind.test.ts`, `build-lang.test.ts`, `build-integrity.test.ts`, `core-sources.test.ts` | Часть механики уже существует (`importKind`). Требуется: type-only цикл вне runtime-списка, mixed import с runtime-частью внутри, consumer типа виден в impact, цикл сам по себе не блокирует gate. Исследование зафиксировало ложные runtime-циклы из type-only импортов. |
| AC-13 symbols capability | `src/gdgraph/symbols-capability.ts` (+ `.test.ts`), `src/gdgraph/treesitter/adapter.ts`, `grammars.ts`, `src/gdgraph/fallback.test.ts` | file-level без runtime/grammar; `requireSymbols` даёт типизированную ошибку; incompatible grammar отличима от missing; fixture даёт реальные symbols после явной установки. Установку грамматик не выполнять автоматически. |
| AC-25 тип и полномочия знания | `src/memory/*` (ingest/search/report), SAC handoff surface | Search→compression→handoff сохраняет exact source fragment/version, author, confirming participant и оговорку об отсрочке; `source unknown` виден явно; высокая confidence не превращает hypothesis в decision/permission. |

## Ограничения этапа

- Ни один норматив не закрывается наличием схемы или старым PASS; каждая задача — RED → GREEN → независимое ревью (Stage1 спецификация, затем Stage2 качество), исполнитель не принимает собственный фикс.
- Параллельность: graph-лейн (AC-10/11/13) и testing/memory-лейн (AC-06/09/25) работают по независимым данным и могут идти одновременно; общий `src/gdgraph/types.ts` сериализуется root'ом.
- Никаких сетевых и модельных вызовов, установки зависимостей, git-операций и публикаций. Реальная установка tree-sitter грамматик — только по отдельному запросу; тесты должны корректно работать и без них.

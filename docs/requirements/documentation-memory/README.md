# Documentation Memory requirements

Version: 0.6.0
Status: Phase 1 + Phase 2 complete (module implemented). reflect, ingest reconciliation, skills learn --from-memory, and skill-verify-skill memory usage shipped; embeddings/semantic overlay are Phase 3.

`Documentation Memory` - модуль Metaproject для долговременной проектной памяти: lessons learned, decisions, constraints, known mistakes, historical context и повторно используемые patterns.

Markdown остается source of truth, а TS/Bun используется для индексации, chunking, поиска, dedup/conflict checks и будущих embeddings.

## Статус

Пакет доведён до production-ready: решения зафиксированы через best-practices research (Generative Agents scoring, Mem0 extract→update, Zep, MemGuard) + два раунда интервью (D1-D12). Заданы: retrieval + ranking-формула (embedding-free, детерминированный), ingest propose-as-draft, детерминированный dedup/conflict, decay-in-ranking, `memory.config.json`, `MemoryService`-контракт, versioned search-JSON и фазовый план. Phase 1 и Phase 2 реализованы (модуль shipped); embeddings/semantic overlay — Phase 3. См. [specification.md](specification.md) sections 2 и 21.

## Документы

- [prd.md](prd.md) - продуктовые требования, сценарии и критерии успеха.
- [specification.md](specification.md) - техническая спецификация CLI, storage, schema, indexing и интеграции с `gdskills`.
- [brainstorm.md](brainstorm.md) - результаты brainstorm/interviewer и принятые решения.

## Связанные модули

- `gdctx` - возвращает компактный output поиска и сохраняет raw/search artifacts.
- `gdgraph` - помогает связать memory entries с файлами, модулями и сущностями.
- `gdwiki` - хранит доменные и архитектурные знания; memory хранит опыт, решения и lessons.
- `gdskills` - использует accepted memory entries как signal для `skill-verify-skill`.
- `Code Health` - может создавать memory suggestions из повторяющихся findings.
- `spec-orchestrator` - включает memory при `gd-metapro init`.

## Рабочее имя CLI

Namespace CLI: `gd-metapro memory`.

Причина: `memory` отражает пользовательский сценарий, а документационный модуль называется `Documentation Memory`.

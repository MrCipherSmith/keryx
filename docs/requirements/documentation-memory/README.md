# Documentation Memory requirements

Version: 0.1.0

`Documentation Memory` - модуль Metaproject для долговременной проектной памяти: lessons learned, decisions, constraints, known mistakes, historical context и повторно используемые patterns.

Markdown остается source of truth, а TS/Bun используется для индексации, chunking, поиска, dedup/conflict checks и будущих embeddings.

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

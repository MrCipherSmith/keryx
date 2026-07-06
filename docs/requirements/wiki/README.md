# gdwiki requirements

Version: 0.2.0
Status: MVP implemented (Phase 1 and Phase 2 complete, Phase 3 in progress)

`gdwiki` - модуль Metaproject для проектной базы знаний: от бизнес-логики и пользовательских сценариев до архитектуры, сервисов, компонентов, интеграций и known decisions.

## Документы

- [prd.md](prd.md) - продуктовые требования к модулю.
- [specification.md](specification.md) - техническая спецификация реализации.
- [brainstorm.md](brainstorm.md) - варианты подхода, сравнение и рекомендация.

## Связанные модули

- `spec-orchestrator` - включает `gdwiki` при `gd-metapro init`, создает структуру `.metaproject/wiki`, manifest и skill.
- `gdgraph` - помогает связать wiki-страницы с файлами, модулями и affected context.
- `gdctx` - помогает агенту получать компактный context при генерации, проверке и индексации wiki.

## Рабочее имя

Рабочее имя CLI-модуля: `gdwiki`.

Причина: название `wiki` слишком общее для namespace, а `gdwiki` сохраняет единый стиль с `gdgraph` и `gdctx`.

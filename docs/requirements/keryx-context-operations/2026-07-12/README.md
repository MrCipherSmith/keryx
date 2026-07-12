# Keryx Context Operations
Version: 1.0.0

## Назначение

Этот пакет фиксирует будущую реализацию **Context Operations**: управляемого
слоя, который собирает для coding-agent минимальный, проверяемый и безопасный
контекст из кода, wiki, memory, skills и quality-артефактов. Он развивает
текущий `.metaproject/`, но не заменяет его детерминированное local-first ядро.

## Статус

`specification ready — future implementation`. Ни один новый runtime, CLI или
провайдер базы данных этим пакетом не объявляется реализованным.

## Проблема и результат

Агенту сейчас доступны хорошие отдельные источники: `gdgraph`, `gdwiki`,
`memory`, `gdskills`, `health`, `testing` и `security`. Однако выбор контекста
распределён по командам и правилам: нельзя единообразно ответить, *какие именно
факты были переданы агенту, почему они были выбраны, какой источник победил и
помог ли он*. Context Operations превращает этот выбор в версионируемый,
наблюдаемый и измеримый продуктовый контракт.

## Состав пакета

- [PRD](prd.md) — пользователи, требования, риски и критерии успеха.
- [Specification](specification.md) — архитектура, контракты, CLI и интеграции.
- [Implementation plan](implementation-plan.md) — последовательность поставки.
- [Agent protocol](agent-protocol.md) — правила поведения агентов при чтении,
  записи и применении контекста.
- [Artifact lifecycle](artifact-lifecycle.md) — источник истины, retention и
  supersession артефактов.
- [Metrics and validation](metrics-and-validation.md) — evals, SLO и gates.
- [Research and positioning](research-and-positioning.md) — конкурентный ландшафт
  и архитектурные решения.
- [Schemas](schemas/) — machine-readable contracts:
  [manifest](schemas/context-assembly-manifest.schema.json),
  [candidate](schemas/context-candidate.schema.json),
  [trace](schemas/retrieval-trace.schema.json),
  [error](schemas/context-error.schema.json) and
  [external adapter](schemas/external-adapter.schema.json).

## Языковые варианты

Каноническая подробная версия — этот русскоязычный набор. Синхронизированные
варианты требований для международной команды и агентов:

- [English](en/README.md)
- [English PRD](en/prd.md)
- [English specification](en/specification.md)
- [AI contract view](ai/README.md)
- [AI PRD](ai/prd.md)
- [AI specification](ai/specification.md)

Каждое функциональное требование имеет стабильный идентификатор `CO-*`; это
позволяет проверять синхронизацию между версиями и acceptance criteria.

## Scope

- Сборка bounded context пакета с доказуемым происхождением каждого элемента.
- Единый hybrid retrieval: lexical, optional semantic и code-graph proximity.
- Retrieval trace, feedback и lifecycle памяти без потери исходных Markdown
  источников.
- Security/policy gate до записи нового знания и перед передачей контекста.
- Локальная CLI/MCP surface; внешние memory systems — только opt-in adapters.

## Non-goals

- Не строить обязательную облачную или multi-tenant memory database.
- Не заменять Graphiti, Cognee, Mem0, Letta или OpenViking их собственным
  runtime-ядром.
- Не внедрять новый LLM agent runtime: это зона пакета
  [Keryx Project Agent Harness](../../keryx-project-agent-harness/README.md).
- Не записывать автоматически недоверенный web/tool output как accepted memory.

## Связанные модули

`src/memory`, `src/wiki`, `src/gdgraph`, `src/ctx`, `src/gdskills`,
`src/security`, `src/health`, `src/testing`, `src/mcp`, `src/flow` и
`src/capability`.

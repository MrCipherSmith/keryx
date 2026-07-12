# Keryx Context Operations — PRD
Version: 1.0.0

## Problem

Долгоживущий coding-agent теряет эффективность не только из-за короткого
контекстного окна. Он получает слишком много несвязанной информации, повторно
исследует репозиторий, применяет устаревшие решения или не может обосновать,
почему использовал конкретное правило. Простая vector memory устраняет часть
поиска, но не связывает память с кодом, задачей, quality evidence, сроком
актуальности и безопасностью записи.

## Goal

Сделать Keryx проектным control plane для context engineering: любой агент и
человек может собрать небольшой контекстный пакет для конкретной задачи,
увидеть его источники и ограничения, воспроизвести выбор и улучшить систему по
результату работы.

## Users

- Разработчик, который быстро входит в незнакомый модуль и хочет доказуемые
  рекомендации, а не полный dump репозитория.
- Команда с несколькими агентами и общими решениями, правилами и уроками.
- Maintainer/reviewer, которому важны происхождение контекста, quality gates и
  отсутствие несанкционированной памяти.
- Orchestrator будущего Project Agent Harness, которому нужен bounded input и
  формальный receipt для resume/replay.

## Product requirements

### Context assembly

- **CO-1.** Система должна строить `ContextAssemblyManifest` для вопроса или
  work item, используя явный budget по байтам, estimated tokens и числу items.
- **CO-2.** Каждый `ContextCandidate` обязан содержать source kind, stable
  source reference, content hash, score components, typed freshness/validity и
  trust level.
- **CO-3.** Сборка должна поддерживать progressive disclosure: orientation →
  high-confidence sources → on-demand evidence; превышение budget возвращает
  typed `context_overflow`, а не тихо отбрасывает критичный policy item.
- **CO-4.** Результат обязан ссылаться на code graph, wiki, memory, skills,
  rules и quality/testing artifacts только когда источник существует и прошёл
  соответствующий validation status.

### Retrieval and memory lifecycle

- **CO-5.** Базовый retrieval остаётся детерминированным и offline. Optional
  semantic/graph providers подключаются исключительно через Capability Seam и
  никогда не меняют output disabled floor.
- **CO-6.** Query planner должен объединять lexical relevance, scope match,
  temporal validity, accepted status, graph distance и optional semantic score;
  каждый применённый компонент объясняется в trace.
- **CO-7.** Memory capture проходит стадии `candidate → draft → accepted |
  rejected | superseded`; accepted запись хранит source, reviewer и validity.
- **CO-8.** Система должна предоставлять feedback: агент/человек отмечает
  кандидаты как useful, stale, misleading или unsafe; feedback не меняет
  source-of-truth автоматически без policy разрешения.

### Governance and interoperability

- **CO-9.** Перед выдачей пакета агенту и перед записью новых знаний применяются
  security/redaction/policy gates; untrusted content не может стать procedural
  memory или skill без явного review.
- **CO-10.** CLI и MCP read surface должны возвращать одинаковую нормализованную
  assembly/trace семантику; write операции остаются отдельными guarded actions.
- **CO-11.** External adapters (например Graphiti/Cognee/OpenViking) являются
  необязательными read-only или explicitly-approved write backends с отдельным
  config, retention и provenance contract.

### Product operability

- **CO-12.** `keryx` должен быть запускаемым как из установленного binary, так
  и из development checkout через документированную команду; правила агента не
  могут требовать недоступный executable без fallback.
- **CO-13.** Каждый релиз Context Operations должен иметь fixture-based evals,
  воспроизводимый report и отсутствие неподтверждённых performance claims.

## Success criteria

- Не менее 95% context items в acceptance corpus имеют resolvable provenance.
- 100% accepted memory, rules и security findings в выбранном пакете проходят
  policy checks; 0 quiet drops обязательных policy items.
- На code-navigation corpus retrieval получает релевантный source в top-5 не
  хуже детерминированного baseline; улучшение semantic ceiling публикуется
  только с методологией и raw fixtures.
- Context manifest и trace воспроизводимы из одного commit, configuration и
  input query.
- Агент может объяснить каждую рекомендацию ссылкой на source item.

## Risks

- Retrieval noise и over-extraction ухудшат качество и стоимость контекста.
- Автоматическое обучение из tool/web output создаст prompt-injection и
  knowledge-poisoning канал.
- Интеграция graph/vector databases преждевременно увеличит setup и нарушит
  local-first позиционирование.
- Новый контекстный слой может дублировать будущий Agent Harness.

## Recommendation

Первый vertical slice должен быть локальным: manifest + deterministic query
planner + trace + feedback ledger + CLI/MCP parity. Graph/vector adapters и
фоновые consolidation jobs следует добавить только после corpus-based evals.

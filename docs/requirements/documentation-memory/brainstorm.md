# Documentation Memory: brainstorm and interview decisions

Version: 0.1.0

## 1. Исходная задача

Нужен модуль долговременной памяти проекта.

Содержит:

- lessons learned;
- решения, принятые в ходе задач;
- частые ошибки;
- проектные ограничения;
- исторический контекст;
- паттерны, которые уже использовались.

Ожидаемая реализация:

- Markdown как source of truth;
- TS/Bun для индексации, поиска, chunking и возможных embeddings;
- результат поиска возвращает короткий релевантный контекст, а не всю память целиком.

Дополнительное решение: Documentation Memory участвует в `skill-verify-skill`.

## 2. Brainstorm options

| Option | Description | Strengths | Risks |
|---|---|---|---|
| A. Markdown Memory Library | Только структурированные Markdown-файлы. | Быстрый MVP, легко версионировать. | Слабый поиск без индекса. |
| B. Indexed Memory | Markdown + TS/Bun индекс, chunks, metadata search. | Хороший баланс для агентов. | Нужна schema и freshness model. |
| C. Semantic Memory | Embeddings/vector search поверх Markdown chunks. | Лучше для смыслового поиска. | Сложнее infra, privacy, cost. |
| D. Memory + Skill Feedback Loop | Memory используется для generation/verification/learning skills. | Максимальная ценность для Metaproject. | Нужны provenance, dedup и conflict workflow. |

## 3. Selected direction

Выбран подход:

- **D по архитектуре**;
- MVP: Markdown + local index + metadata/chunk search;
- schema сразу проектируется под optional embeddings later;
- Memory является signal для `skill-verify-skill`.

## 4. Interview decisions

### 4.1 MVP status

Решение: **D**.

Markdown остается source of truth, MVP делает local index, schema не блокирует будущие embeddings.

### 4.2 Entry types

Решение: **D**.

Typed memory registry поддерживает все типы, но MVP-шаблоны обязательны для:

- `lesson`;
- `decision`;
- `constraint`;
- `known-mistake`.

Расширяемые типы:

- `historical-context`;
- `pattern`;
- `task-note`;
- `review-note`;
- `incident`;
- `migration-note`;
- `integration-note`.

### 4.3 Population model

Решение: **D**.

Memory пополняется через:

- ручной CLI;
- orchestrator/job reports;
- review findings;
- Code Health findings;
- `skill-verify-skill` findings.

Каждая запись имеет provenance и status.

### 4.4 Skill verifier integration

Решение: **D**.

Memory участвует в `skill-verify-skill` через:

- memory search;
- conflict detection;
- memory-to-skill learning.

Только `accepted` entries могут автоматически влиять на skills. `draft` entries используются как advisory context.

### 4.5 Dedup and conflict model

Решение: **D**.

Memory использует:

- dedup suggestions для похожих entries;
- conflict workflow для противоречий;
- statuses: `draft`, `accepted`, `deprecated`, `conflict`, `superseded`.

### 4.6 Search output

Решение: **D, layered output**.

Search возвращает:

- короткий Markdown summary для агента;
- JSON results для инструментов;
- ссылки на raw Markdown entries.

Search не должен возвращать всю память целиком.

# Documentation Memory: brainstorm and interview decisions

Version: 0.2.0
Status: production-ready decisions frozen (see section 5)

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

## 5. Production-ready research + interview decisions

Second pass to move the package from MVP to production-ready: best-practices
research plus a two-round interview (questions with options and a
recommendation). Decisions are frozen for v1 and drive
[specification.md](specification.md) section 2 (D1-D12).

### 5.1 Best-practices research

Grounded in current agent-memory literature/frameworks, adapted to a local,
Markdown-first, offline, deterministic dev-tool memory:

- **Retrieval scoring (Generative Agents)** - rank by relevance + recency +
  importance, each normalized and summed; recency is exponential decay. Mapped
  to keyword+metadata: importance -> `Confidence`, relevance -> text/scope match.
- **Extract -> Update lifecycle (Mem0)** - ingest reconciles (ADD/UPDATE/DELETE/
  NOOP) instead of blind append; basis for dedup/conflict (deferred auto-mode to Phase 2).
- **Temporal status lifecycle (Zep)** - track validity over time via statuses.
- **Contamination prevention (MemGuard)** - only `accepted` memory influences
  behavior; provenance required; conflicts never auto-apply.
- **Forgetting = decay in ranking, not deletion** - Markdown stays canonical.

Sources: Mem0 (arxiv 2504.19413), Generative Agents (2304.03442), Zep temporal
KG, MemGuard (2605.28009), Agent Memory Survey.

### 5.2 Frozen decisions

| # | Question | Decision |
|---|---|---|
| N1 | Retrieval (MVP) | keyword+metadata+recency+confidence (embedding-free); embeddings -> Phase 3 |
| N2 | Ranking | documented weighted formula (relevance+recency+confidence+status+scope) + config override |
| N3 | Ingest lifecycle | propose-as-`draft` + provenance + dedup/conflict flags; human accepts (Mem0 auto-reconcile -> Phase 2) |
| N4 | Config location | separate `.metaproject/memory.config.json` |
| N5 | Dedup/conflict | deterministic similarity (title + tag/scope overlap + token Jaccard on summary, thresholds) |
| N6 | Retention/decay | recency decay in ranking only; never hard-delete; deprecated/superseded retained |
| N7 | Reflection/consolidation | Phase 2 (deferred) |
| N8 | Search JSON contract | versioned (`schemaVersion`), stable, validated by gdskills |

### 5.3 Direction

Selected engine: **scored retrieval + reconcile (embedding-free)** - Generative
Agents-style ranking (relevance + recency + confidence/status/scope) over a
deterministic inverted index, with Mem0-style ingest reconciliation staged into
Phase 2 and embeddings as an optional Phase 3 overlay. Keeps the module offline,
deterministic, and Git-friendly while giving production-grade retrieval.

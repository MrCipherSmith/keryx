# Keryx Shared Agent Context — PRD
Version: 1.2.0

## Problem

Keryx уже имеет graph, wiki, memory, Flow, verification evidence и agent
runtime, но у межкомпонентной работы нет единого permission-aware entry point.
Участники повторяют исследование, а агенту легко передать слишком широкий или
устаревший prompt. Результаты сессии также рискуют исчезнуть либо попасть в
долгую память без достаточной проверки.

## Goal

Дать людям и агентам минимальный, свежий и доказуемый контекст конкретной
работы; полезный результат должен возвращаться в проект как reviewed proposal,
а не как автоматическая запись или transcript dump.

## Users

- Разработчик, входящий в незнакомый компонент или связанную группу репозиториев.
- Tech lead/owner, задающий границы, доступы, решения и escalation path.
- Агент или orchestrator, которому нужен bounded context с provenance.
- Reviewer, принимающий или отклоняющий новое reusable knowledge.

## Product requirements

- **SAC-1 — Workspace registry.** Создаётся local workspace с canonical
  `SubjectId`, scope, role map и typed links, а не копиями, на components,
  repositories, flows, evidence и knowledge. В v1 все ссылки
  workspace-relative; resolver применяет application-level `realpath` и
  проверку containment в разрешённом workspace root до любого read/write.
- **SAC-2 — Component/work entry.** Из component, workspace или flow
  разрешается verified local context: repository/worktree references, owner
  scope, policies и bounded overview.
- **SAC-3 — Facts.** Facts являются task-local; каждый содержит statement,
  evidence references, source revision, confidence, created/expiry time и
  freshness status. Facts не могут silently promote themselves в Know-how.
- **SAC-4 — Work.** Work исключительно derives из Flow. SAC показывает status,
  completed, next, blocked и verification evidence, но не изменяет Flow и не
  хранит параллельные tasks/statuses.
- **SAC-5 — Know-how.** Только accepted/reviewed memory, wiki и skills могут
  быть returned as Know-how. Результат retrieval сохраняет source, revision,
  trust, applicability и stale status.
- **SAC-6 — Progressive context.** Initial overview включает identity, scope,
  mandatory policies и bounded FWK summary. Детали выдаются текущими MCP/CLI
  адаптерами (`sac.read` / `keryx workspace read`) и harness-tools
  (`workspace_read`) по запросу с trace и budget accounting. Невместившийся
  mandatory context даёт typed `context_overflow`, а не частичный успешный
  manifest; опциональные omissions допустимы только в ответе `partial` с
  `omittedOptional` IDs.
- **SAC-7 — Access policy and receipt.** Детерминированная policy учитывает
  remaining budget, task phase, source trust, freshness и role. Каждый доступ
  создаёт receipt с request, allowed/denied decision, cost и outcome signal.
  Роль выводится только из trusted `ActorContext`, а не из client-supplied
  subject; отсутствие trusted identity означает deny.
- **SAC-8 — Session wrap-up.** Агент может сформировать structured candidate:
  decision, contract change, risk, follow-up или knowledge update, с evidence.
  Raw transcript и hidden reasoning запрещены как input candidate.
- **SAC-9 — Proposal governance.** Proposal проходит schema validation,
  security/redaction gate, owner review и existing guarded target write path.
  Только target owner определяет acceptance в wiki/memory. Создание и
  transition records append-only: `accepted` возможен лишь после freshness,
  reviewer authority, security policy/version и successful idempotent target
  write receipt.
- **SAC-10 — Freshness and lifecycle.** Изменение source revision, expired TTL,
  withdrawn knowledge или changed ACL приводит к explicit stale/denied state;
  derived artifacts пересобираются, а не masquerade as current.
- **SAC-11 — Local-first security.** Local roles (`owner`, `editor`, `viewer`)
  ограничивают discovery/read/propose/review. Visibility filtering и redaction
  применяются до MCP egress и persistence.
- **SAC-12 — Safe evolution.** Первая версия применяет только versioned
  deterministic policy. Любая learned policy — isolated, opt-in experiment
  после offline corpus, baseline и rollback proof; она не может менять gates.
  Phase 5 заблокирована до independently verifiable outcomes, immutable
  hash-linked receipts, policy version, corpus manifest (selection, redaction,
  provenance), holdout/adversarial cases и quarantine workflow.

## Success criteria

- Для заданного workspace overview воспроизводим: каждый существенный факт
  имеет resolvable evidence и freshness result.
- Work совпадает с Flow snapshot и не даёт API для изменения flow status.
- 100% persisted proposals имеют actor, timestamp, evidence, security decision
  и review state; 0 raw transcripts становятся accepted knowledge.
- Unauthorised/hidden references отсутствуют и из listing, и из read responses.
- CLI и MCP read surfaces дают семантически эквивалентные normalized results.
- Deterministic policy и budget accounting воспроизводимы на fixed corpus;
  эксперимент не включается default без заранее принятого evaluation gate.
- Timestamps и lifecycle transitions проходят parser/validator, который
  принудительно проверяет UTC, temporal ordering и monotonic transition.
- Для каждого normative contract assertion есть labelled positive/negative
  fixture или property/integration test с одной документированной причиной
  провала.

## Risks

- Дублирование Context Operations или Harness. Граница ownership фиксируется в
  specification и проверяется на каждом implementation flow.
- Session summary может содержать ложные выводы. Mitigation: evidence,
  redaction, security gate, review и no automatic promotion.
- Local ACL не заменяет filesystem/OS permissions. Runtime обязан fail closed,
  если requested reference нельзя safely resolve/read.
- Документация может отстать от runtime (это уже случалось: versioned
  заголовки `future/planned` и фраза «runtime ещё не реализует SAC» жили
  после появления `src/sac/`). Mitigation: этот PRD и specification 1.2.0
  описывают текущий код; satellite RP-пакеты остаются future и не отменяют
  shipped SAC-1…SAC-12. Валидатор должен сверять implementation-claims с
  `src/sac/`, CLI и тестами, а не с устаревшими `future`-заголовками.
- Receipts могут превратиться в лишние логи. Схема ограничивает поля,
  lifecycle задаёт retention, а raw content не пишется.
- Оптимизация retrieval только по success score стимулирует небезопасный или
  шумный доступ. Evaluation использует independent verification и security
  non-regression gates.

## Recommendation

Read-first slice, proposals/review и opt-in policy guard (фазы 0–5 и 6a)
уже поставлены. Дальше не переоткрывать shipped surface как «future design».
Оставшаяся работа — 6b (real-data readiness / re-ingestion) и satellite
RP-01…RP-12. UI, external sync и learned policy по-прежнему только после
validation gates из этого пакета.

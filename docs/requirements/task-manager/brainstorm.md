# Task Manager: brainstorm and decision record

Version: 0.1.0
Status: production-ready decisions frozen (sections 2-5)

## 1. Исходная задача

Нужна система менеджмента работы, ориентированная в первую очередь на агентов.
Единица работы - flow: прохождение стори от инициализации до завершения.

## 2. Product vision (пользователь)

Зафиксировано как основа v1:

| # | Требование |
|---|---|
| V1 | Система менеджмента для агентов; набор скилов. |
| V2 | Flow = прохождение стори от инициализации до завершения. |
| V3 | Вход init: описание проблемы ИЛИ ссылка на GitHub issue; расширяемо (Notion и др.). |
| V4 | Init: собрать контекст (gdgraph, gdctx, memory, анализ кода), формализовать, брейншторм, при необходимости интервью пользователя. |
| V5 | Папка `<номер>-<дата>-<суть>`; внутри пакет md: подробное описание, план, разбивка на задачи (дособрать контекст, протестировать, ревьюить и т.д.). |
| V6 | Жёсткие критерии приёмки; их правит только task-manager модуль. |
| V7 | Перед стартом - перепроверить и зафиксировать; далее имплементатор/оркестратор реализует по плану. |
| V8 | flow-manager (скил/саб-агент) встраивается в оркестратор: ведёт данные и статус flow; только он решает, что имплементатор выполнил задачу (создан draft PR на имя автора). |
| V9 | Отдельный скил завершения: перепроверить всё, убедиться что PR зелёный; мелкие правки - fix-агент; крупные - вернуть в in-progress с описанием и перезапустить имплементатора. |
| V10 | Если был issue - короткий комментарий по делу о проделанной работе; если нет - спросить пользователя, создавать ли тикет. |

## 3. Research

- **Spec-Driven Development (GitHub Spec Kit)**: цикл specify → plan → tasks;
  спека рождается в итеративном диалоге с уточняющими вопросами; поверх -
  constitution: неизменяемые принципы. V6 (замороженные AC) = constitution на
  уровне flow. V5 (пакет md) = spec/plan/tasks.
- **Agent orchestration 2026 (AIDLC, state-machine guardrails)**:
  planning→execution→verification loop с approval-гейтами; детерминированные
  переходы статусов вместо open-ended loop; draft PR как терминальное состояние
  имплементатора; никакой merge без ревью; явные границы автономии.
- Усиления, взятые из research: (a) checksum-заморозка AC (механическое
  enforcement), (b) state machine в CLI как точка истины, (c) граница
  «CLI = состояние/гейты, скилы = когнитивная работа».

Sources: github/spec-kit, spec-driven.md; AIDLC (Augment); amux orchestration
guide 2026; Mike Mason "Coherence Through Orchestration".

## 4. Brainstorm options

| Option | Description | Strengths | Risks |
|---|---|---|---|
| A. Markdown task board | backlog/статусы (старый §4.6) | просто | не покрывает vision: нет lifecycle, гейтов, авторитета |
| B. Flow lifecycle engine | CLI = state machine + storage + гейты; скилы = когнитивный слой | точно vision; механический enforcement; тестируемо; в духе Metaproject | нужны точные контракты переходов |
| C. Полный agent-runtime | task manager сам запускает имплементаторов | всё в одном | дублирует оркестратор/gdskills; недетерминированно |

Выбрано: **B**. Оркестратор и имплементатор существуют как скилы - task manager
командует ими через состояние, а не исполняет их.

## 5. Interview decisions

| # | Вопрос | Решение |
|---|---|---|
| D1 | Namespace | CLI `gd-metapro flow`; manifest-ключ `tasks`; модуль - Task Manager |
| D2 | Storage | `.metaproject/flows/<NNN>-<YYYY-MM-DD>-<slug>/`, версионируется в git |
| D3 | Защита AC | checksum-заморозка: hash в flow.json при freeze; гейты падают при расхождении; правка только через `flow ac update` (re-hash + changelog) |
| D4 | Статусы | 7: initializing → ready → in-progress → implemented → completing → done, + blocked (из любого); CLI валидирует переходы |
| D5 | GitHub | через `gh` CLI + типизированный TrackerAdapter (issue read, PR checks, comment); graceful degradation без gh |
| D6 | Completion-гейты | (1) все AC подтверждены + checksum цел; (2) draft PR существует и checks зелёные; (3) health gate pass. Провал → авто-возврат в in-progress с fix-нотами |
| D7 | Init-контекст | CLI детерминированно собирает context.md (issue body, memory search, gdgraph-артефакты, health-статус); скил делает когнитивное (формализация, брейншторм, интервью, AC) |
| D8 | Задачи | tasks.md - определения (id, суть, тип: context/implement/test/review/docs); статусы задач - в flow.json через `flow task done` |

Все решения приняты по рекомендации; отклонений нет.

## 6. Next steps

1. Спецификация (state machine, flow-пакет, CLI, гейты, adapter, скилы).
2. Имплементация Phase 1: `src/flow/` + `gd-metapro flow` + init-интеграция + 3 скила.
3. Dogfood: вести следующие фичи самого gd-metapro как flows.

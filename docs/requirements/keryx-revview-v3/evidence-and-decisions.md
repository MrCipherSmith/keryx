# Основания и решения
Version: 0.2.0

Статус: spec ready — архитектурные решения приняты; runtime не реализован. Проверка исходников: commit ad2c78544ef306bf4cfc09b32d03d1690f527582, 2026-11-05. Installed CLI не является доказательством runtime текущего checkout.

## Источники текущего поведения

| Утверждение | Исходник |
|---|---|
| AgentDefinition: tools, skills, tier, policy, isolation; schema_version=1 | [types](../../../src/agents/types.ts), [schema](../../../src/agents/schema.ts) |
| Каталог bundled + project overrides | [catalog](../../../src/agents/catalog.ts) |
| Экспорт определения отличается от runtime enforcement | [compile](../../../src/agents/compile.ts) |
| 32 children/turn вне wave, 32/wave, 80 agent-minutes, 5 минут reservation, 40/200 model rounds | [spawn tool](../../../src/harness/tool/builtin/spawn-subagent-tool.ts) |
| 25 waves через DEFAULT_MAX_PASSES | [chunks estimate](../../../src/review/chunks-estimate.ts) |
| Параллельный batch по умолчанию 10, условный concurrent branch | [agent driver](../../../src/commands/agent.ts) |
| Неиспользованный runtime возвращается; count не возвращается | [ledger](../../../src/harness/child/ledger.ts) |
| Skill исполняется главным, host spawn или autonomous runner | [review skill](../../../src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md) |
| Shell и session имеют разные пути формирования инструментов | [shell](../../../src/commands/shell.ts), [native runtime](../../../src/session/native-runtime.ts) |

12 определений каталога на этой базе: codebase-navigator, design-advisor, docs-maintainer, end-to-end-tester, error-path-auditor, go-build-fixer, go-code-auditor, performance-auditor, refactoring-steward, security-auditor, test-first-driver, work-planner. Это не список reviewer skills и не лимит количества экземпляров.

## Пользовательские требования

- Сохранить review-orchestrator главным; подготовить scope и план до ревью.
- Главный назначает зоны генералам и может запускать солдат непосредственно.
- Генералы — сабагенты как сущности; им нужны инструменты и права главного, включая делегирование.
- Рассмотреть native и external generals; запуск из обычного терминала и других harness.
- Повысить лимиты на всех уровнях.
- Создать документационный пакет в отдельной worktree, без реализации в этой работе.

## Принятые решения — 2026-11-05

Основание принятия: пользователь согласился с рекомендациями и поручил зафиксировать их в пакете, повторить документационное ревью и **не начинать реализацию**. Решения ниже заменяют прежний native-only план; принятие архитектуры не является разрешением на реализацию.

| ID | Решение | Отклонённые альтернативы / основание |
|---|---|---|
| D1 | Четыре сущности: review-scout, review-coordinator, review-worker, review-validator. Schema v2 читает v1 с прежними leaf defaults; 12 определений не переписываются автоматически. Reviewer специализации остаются skills. | Одна универсальная сущность размывает полномочия; сущность под каждый skill дублирует специализации. |
| D2 | Общий управляющий слой Keryx владеет заданиями, coverage, ledger, результатами и отменой. Исполнение — через capability-checked native/external adapters; главный может оставаться в Codex CLI или другом harness. | Независимые оркестраторы каждого harness не гарантируют единый учёт. Native adapter без контроля лимитов/отмены не считается полным паритетом. |
| D3 | Первый выпуск включает Keryx native и Keryx runtime как внешнего генерала. Codex/Claude как управляющие harness используют общий интерфейс; их процессы как генералы требуют отдельной проверки адаптеров. Pi — последующий адаптер. | Native-only не покрывает задачу; обещание любого CLI не доказывает управляемость. Версии выбираются технической проверкой. |
| D4 | Генерал получает инструменты и механизм approvals родителя, но каждое действие ограничено review policy и заданием. Исходники read-only для всех участников review-фазы, результаты записываются в выделенные артефакты. Общие completion/publish и human decisions — root/operator. | Полный доступ к инструментам не даёт права менять исходники/чужие задания. Исправления — отдельная явно разрешённая фаза. |
| D5 | Генералам назначаются связные области поведения; солдатам — проверки аспектов/сценариев. Границы имеют владельцев; coverage — область×аспект. Малые задания идут прямым солдатам без обязательного генерала. | Деление только по папкам/специализациям оставляет межобластные пробелы. |
| D6 | large-review принят как начальный профиль для проверки: 32 активных descendants, 6 генералов, 8 активных детей/general, 512 запусков/run, 960 agent-minutes, 120 elapsed minutes, 20% резерв. Полная таблица policies.md — исходная конфигурация пилота; числа не объявляются нагрузочно проверенными. | Потолки не являются планом расходования; размер команды зависит от scope. Поддержать measured-cost и cost-unknown режимы без фиктивной гарантии денежного потолка. |
| D7 | Один версионированный внутренний API с native tools, CLI и MCP bindings; один контроллер запуска с durable state. Scoped bridge управляет поддеревом; reconnect сохраняет budgets/results. | Новый процесс/ход не создаёт новый бюджет. Транспорт, wire-поля и файлы уточняются при проектировании контрактов. |

## Случай Pi / Herdr

Пользователь показал два Pi-процесса под DM:FE и ошибку No API key found for openai-codex. Предыдущее исследование локальной сессии установило путь shell_exec → hc run → pi, а не managed external spawn Keryx. Это историческое наблюдение, не воспроизводимый тест данной worktree и не доказательство работоспособности Pi adapter. Создать процесс и авторизовать модель — разные этапы. Herdr UI не должен быть условием работы V3.

## Оставшаяся техническая детализация

Это не повторное согласование D1–D7 и не разрешение начать работы:

1. P1: wire/config имена, точные JSON schemas и layout storage; механизм v1→v2 чтения уже принят D1.
2. P0/P3: adapter/version matrix и capability probes для принятого состава первого выпуска; unsupported возможности явно отмечаются.
3. P3: bridge transport, scoped token expiry/revocation и security review в рамках D7.
4. До live пилота: провайдеры, auth readiness, режим measured-cost или cost-unknown; в measured-cost оператор задаёт сумму, в cost-unknown явно принимает отсутствие денежной гарантии.
5. Пилот: измерить скорость/качество/стоимость и откалибровать профиль D6. Root legacy cap отдельно проверить; он здесь не заявлен как измеренный.

## Routing audit

wiki_used: yes (локальный index); ctx_used: yes (поиск skill и точечная навигация в исследовании); graph_used: unavailable — в новой worktree отсутствуют file nodes, affected вернул index-incomplete; raw_rg_used: no. Memory search напомнил сохранять findings block для ingest и различать installed CLI от checkout. Документы основаны на точечных исходниках и обсуждении; graph answers не выдаются за проверенный контекст.

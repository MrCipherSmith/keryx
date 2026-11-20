# Готовность worktree к параллельной работе
Version: 0.2.0

**Статус — draft.** Требования и спецификация для keryx CLI и Keryx Desktop. Ничего из описанного не реализовано, команды `keryx worktree …` не существуют. Flow не создан. Открытых PR, с которыми пакет пересекается, нет.

| Документ | Для кого и зачем |
|---|---|
| [PRD](prd.md) | Продукт и разработка. Проблема, требования R1–R10, критерии выпуска и пользы, риски |
| [Спецификация](specification.md) | Разработка и QA. Команды, конфигурация, хранилища, политика общих данных metaproject, контракты, критерии приёмки |
| [План реализации](implementation-plan.md) | Команда поставки. Четыре этапа и их порядок |
| [schemas/worktree-config.schema.json](schemas/worktree-config.schema.json) | Схема `.metaproject/worktree.config.json` (planned) |
| [schemas/checkout.schema.json](schemas/checkout.schema.json) | Схема метки checkout в git-каталоге worktree (planned) |

## Назначение

Владелец и агенты ведут несколько задач одновременно, каждую в своём git worktree. Сегодня новый worktree — голая рабочая копия: без `.env`, без зависимостей, с занятыми портами dev-сервера и с пустой частью `.metaproject/`, которая не хранится в git. Конфликты с `main` и с соседними задачами обнаруживаются при слиянии. Падения тестов, которые были до задачи, засчитываются задаче.

Пакет делает worktree готовым к работе и честным в проверках:

1. **Подготовка:** `.env`-файлы из основного checkout, зависимости копией copy-on-write, свои порты.
2. **Metaproject в worktree:** агент получает абсолютный корень worktree и путь к его `.metaproject/index.md`; производные индексы (память) перестраиваются на месте; выводы worktree владелец переносит в пользовательскую область (`~/.keryx/memory`, `keryx learn promote`) командой `keryx worktree promote`. Данные metaproject и хранилища другого checkout не читаются и не пишутся; `prepare` по команде владельца только копирует из основного checkout перечисленные `.env`-файлы и зависимости.
3. **Проверка конфликтов:** насколько ушла цель, какие файлы дадут конфликт, какие другие flow и PR правят те же файлы.
4. **Базовая линия и нестабильные тесты (только отчёт):** результаты на базовом коммите, «было N, стало M», повтор красного теста один раз. Гейтить по ним может только W1 [слоя приёмки](../keryx-acceptance-layer/README.md) после G1.

## Область и не-цели

В области: keryx CLI (новый `src/worktree/`, а также `src/lib`, `src/flow`, `src/testing`, `src/health`), Desktop (`apps/desktop`) как поверхность показа.

Не входит:

- автоматическое слияние и разрешение конфликтов;
- синхронизация между машинами (это Hub);
- общий транскрипт между worktree (это [Agent Bus](../keryx-agent-bus/README.md));
- публикация оверлеев и модель Project/Clone/Checkout — это будущий [SAC RP-08](../shared-agent-context-collaboration-worktrees/README.md); пакет его не реализует, соотношение и оставшееся расхождение — в спецификации §5.4;
- блокирование flow по результатам проверок — это W1 [слоя приёмки](../keryx-acceptance-layer/README.md);
- поддержка не-git проектов.

## Связанные модули

- [Keryx Desktop: рабочие панели и внимание](../keryx-desktop-workspace-panels/README.md) — парный пакет интерфейса.
- [SAC RP-08 Collaboration and Worktrees](../shared-agent-context-collaboration-worktrees/README.md) — будущая модель идентичностей и оверлеев.
- [Keryx Agent Bus](../keryx-agent-bus/README.md) — прецедент хранения в общем git-каталоге.
- [Keryx Desktop Client · доска Flows](../keryx-desktop-client/flows-board.md) — где показывается проверка конфликтов flow.
- [Keryx Acceptance Layer](../keryx-acceptance-layer/README.md) — W1 после G1 может использовать отчёт базовой линии.
- Код: `src/lib/git-worktrees.ts`, `src/harness/child/worktree.ts`, `src/flow/allocation.ts`, `src/memory/store.ts`, `src/learning/store.ts`, `src/testing/service.ts`, `src/flow/ac-kinds.ts`.

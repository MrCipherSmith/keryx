# Shell TUI: runnable /setup plan, compact card sidebar with three widths, working /routing model picker

Status: formalized from the operator's request and five screenshots (2026-10-20); investigation in `context.md`, approach in `plan.md`, criteria in `acceptance-criteria.md` — awaiting freeze.
Source: user description (origin: human-request)

## Problem

Three surfaces of `keryx shell` (OpenTUI) fail the operator in a real project (vantage-frontend, keryx 0.3.125 from npm):

1. **`/setup` is unfinished.** It shows a five-step "From scratch" list in low-contrast text. It opened on the Init tab ("No .metaproject yet") in a project that already has a `.metaproject/`. The list omits most of what init, refresh and repair actually do, marks nothing as required or optional, and there is no way to act on it: no prompt to copy for an agent and no way to run it from the modal.
2. **The sidebar is a long scrolling column.** Model, Usage, Directory, Branch, PR, Review, Context, Tools, Route, ProjectCtx, Status, Plan, Background Jobs, Governance, Reviews (with paragraphs of wrapped text), Remote, Telegram and decisions all stack at one fixed width. Important state gets lost, and there is no way to widen or collapse the sidebar.
3. **`/routing` cannot be configured.** The Categories tab marks every default (openai-codex/gpt-6.1-sol, gpt-6-luna, gpt-6-astra) as "not connected, falling back to session default", even though the session itself runs on openai-codex/gpt-6-luna. The Model tab lists only "session default": no providers and no models to pick. Flows 305 and 309 claimed this works.

## Expected Outcome

- `/setup` opens on the tab that fits the project's state, in readable contrast. Each tab lists every internal step with a required/optional mark and a reason. Under the plan is a ready-made agent prompt that can be copied, and a Run button on the right executes the plan through a subagent, with visible progress.
- The sidebar is a set of cards, 3–5 lines each, and fits without scrolling at laptop width. A card opens its details in a styled modal. Three header icon buttons next to "keryx vX" switch between the current width, double width and a thin icon rail. The choice survives a restart.
- `/routing` lists the connected providers and their models, the session's own provider included. A pick is saved and shown on the category. Each failure case shows its own visible state instead of an empty list: no provider connected, catalog fetch failed, or an assigned model that is no longer offered.

## Outcome criteria

- Запрос (дословно): «Я прикрепил скриншоты с багами в keryx shell tui. Создай flow , изучи проблемы, подготовь план. Проверка - ручное тестирование, эффект - удобное обновление metaproject в проекте, удобый сайдбар, а так же роутинг должен работать.» (source: claude-code desktop chat, 2026-10-20, message with 5 screenshots)
- Эффект (формализация агента): в проекте с установленным keryx оператор обновляет metaproject из `/setup`: видит полный план с пометками «обязательно», копирует промпт для агента или жмёт «Запустить», и план выполняется сабагентом. Сайдбар читается без прокрутки карточками с деталями в модалке и переключается между тремя ширинами. В `/routing` можно выбрать провайдера и модель для каждой категории, и выбор применяется.
- Как наблюдать (предложение агента): ручной прогон оператором: сначала keryx из ветки в одноразовом тестовом проекте, затем после релиза — установленный из npm keryx в vantage-frontend (изменения ветки попадают туда только через релиз). `/setup` → Refresh → «Запустить» доходит до конца; сайдбар в трёх режимах на экране ноутбука; `/routing` → выбор модели openai-codex для категории `coding` → категория показывает выбранную модель, и следующий субагент категории `coding` идёт на неё.

## Out of Scope

- New providers, new auth flows or changes to how a provider logs in. Only routing's view of providers that are already connected is in scope.
- Changing what `keryx init`, `keryx update` or repair do. `/setup` describes and runs them; it does not redefine them.
- The readline (non-TUI) shell fallback, beyond keeping it working.
- A general redesign of other modals or of the transcript area.

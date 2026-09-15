---
name: code-mobx-store-review
description: "Use when MobX store changes need a focused review — actions, computed values, reactions, async runInAction, state typing, and View↔Store boundaries. NOT for: a general frontend review (review-frontend) or a review request that names no domain (review-orchestrator)."
triggers:
  - "mobx review"
  - "store review"
  - "code-mobx-store-review"
  - "Review MobX store"
  - "Check store changes"
metadata:
  author: "MrCipherSmith"
  version: "1.1.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
  stack_requires: "mobx"
license: "MIT"
---

---

# Code MobX Store Review (только текущая ветка)

Проводи ревью только изменений текущей ветки от merge-base с родительской веткой. Фокусируйся на корректности состояния, MobX-паттернах и границах архитектуры.

## Scope

- Если пользователь **не передал commit hash/range**, ревьюируй полный срез от merge-base до рабочего дерева:
  - закоммиченные изменения (`BASE_SHA..HEAD`)
  - локальные (`staged/unstaged/untracked`)
- Если пользователь **явно передал commit hash/range**, ревьюируй только его.
- Не ревьюй легаси вне измененного скоупа.
- Привязывай замечания к измененным строкам в diff.

## Scope Detection

See shared script: `.metaproject/skills/gdskills/shared/git-merge-base.md`

Run the script from that file to determine MERGE_BASE and SCOPE before proceeding with the review.

### Команды сбора изменений

```bash
git status
git log --oneline "${BASE_SHA}..HEAD"
git diff --name-status --find-renames "${BASE_SHA}..HEAD"
git diff --find-renames "${BASE_SHA}..HEAD"
git diff --name-status --find-renames "${BASE_SHA}"
git diff --find-renames "${BASE_SHA}"
git ls-files --others --exclude-standard
```

## MobX review checklist

### Store structure
- Store-класс должен иметь `makeObservable(this)` в конструкторе.
- Состояние хранится в `@observable`/`@observable.shallow`/`@observable.ref`.
- Производные значения в `@computed`, а не в View.

### Member ordering
Проверяй порядок членов класса (соответствие `@typescript-eslint/member-ordering` и проектной конвенции):
1. `@observable` поля (публичное состояние, без модификатора)
2. `private` поля (внутреннее состояние: `disposed`, `initialized`, и т.д.)
3. `constructor`
4. `@computed` геттеры
5. `dispose()` — lifecycle очистки
6. `init()` / `onMount()` — lifecycle инициализации
7. `@action.bound` методы — UI-facing actions
8. `private` методы — API-вызовы и внутренняя логика

### Member accessibility modifiers
ESLint: `@typescript-eslint/explicit-member-accessibility: ["error", { accessibility: "no-public" }]` — слово `public` **запрещено**.

- *(без модификатора)*: `@observable` поля, `@computed` геттеры, `@action.bound` методы, `dispose()`, `init()` — публичный API стора.
- `private`: внутреннее состояние (`disposed`, `initialized`), хелпер-методы, методы с API-вызовами (`fetchX`, `performX`), inter-store callbacks (`onChangeX`, `onFireX`, `handleX`, `syncX`).
- `private readonly`: инжектированные через конструктор зависимости, неизменяемая конфигурация (`id`, `context`).
- `readonly`: неизменяемые публичные identity-поля (`pipelineType`, `contextActions`).
- `protected`: только в абстрактных базовых классах для точек расширения.

Флаги ревью:
- Использование слова `public` — **ошибка ESLint** (error level).
- `private` поле которое можно сделать `private readonly` — предложи `readonly`.
- Отсутствие `private` на внутреннем состоянии или хелпер-методах — **warning**.

### Actions and async
- Любая мутация состояния в действиях (`@action.bound` или через `runInAction`).
- После `await` для мутаций использовать `runInAction`.
- Избегать прямых мутаций store извне action-слоя.

### Action binding rules
- **`@action.bound`**: только для методов вызываемых из UI (компонентов). Это тонкие обёртки которые делегируют в private-методы.
- **Private метод + `runInAction`**: для методов содержащих API-вызовы и мутации состояния.
- **Никогда** не использовать `@action.bound` на private-методах.
- **Исключение**: `@action.bound private` допустим для inter-store callbacks — методов, передаваемых как bound-ссылки в дочерние/сиблинг сторы (например `new CodeEditorStore(this.onChangeEditorState)`).

Флаги ревью:
- `@action.bound` метод содержит API-вызов напрямую — **warning**: вынести API в private метод.
- `@action.bound` на private методе (кроме inter-store callbacks) — **warning**: убрать декоратор, использовать `runInAction` внутри.
- Метод вызываемый из другого стора помечен `@action.bound` вместо plain method — **suggestion**.

### Inter-store callbacks and internal handlers
Методы служащие **внутренними callback'ами** между сторами или внутренними обработчиками событий ОБЯЗАНЫ быть `private`. Они НЕ являются частью публичного API стора.

**Паттерны имён которые ОБЯЗАНЫ быть `private`:**
- `onChangeEditorState(state)` — callback получающий состояние от дочернего/сиблинг стора
- `onFireExecutorChange()` — внутренний sync-обработчик при смене executor
- `onChangeX(value)` — обработчик для внутренней синхронизации состояния между сторами
- `handleX()`, `syncX()` — любой метод внутренней координации

**Правило решения:** Спроси "Этот метод вызывается из React-компонента через JSX/event handler?" Если НЕТ — он `private`.

Флаги ревью:
- Публичный метод с паттерном `onChangeX`, `onFireX`, `handleX`, `syncX` который не вызывается из компонентов — **warning**: сделать `private`.
- Inter-store callback без `private` — **warning**: нарушение инкапсуляции стора.

### Bidirectional sync bounce protection
Когда два стора синхронизируют состояние **в обоих направлениях** (Store A → Store B и Store B → Store A), как минимум одно направление ОБЯЗАНО иметь equality guard (`if (newValue !== currentValue)`) перед записью в другой стор, чтобы предотвратить бесконечный цикл callback'ов.

```typescript
// CORRECT — equality guard prevents bounce
private onChangeEditorState(editorState: ICodeEditorState) {
  this.setRawScript(editorState.script);
  const codeExecutorId = this.codeExecutor?.id;
  if (codeExecutorId && this.codeEditorStore.executorId !== codeExecutorId) {
    this.codeEditorStore.setExecutorId(codeExecutorId);
  }
}

// WRONG — no guard, infinite loop
private onChangeEditorState(editorState: ICodeEditorState) {
  this.setRawScript(editorState.script);
  const codeExecutorId = this.codeExecutor?.id;
  if (codeExecutorId) {
    this.codeEditorStore.setExecutorId(codeExecutorId); // bounces back
  }
}
```

Флаги ревью:
- Bidirectional store sync без equality guard — **critical**: риск бесконечного цикла callback'ов.
- Store A пишет в Store B в callback'е от Store B без проверки `!==` — **critical**.

### Truthy vs equality guards for optional values
Для guard'ов обновления состояния предпочитай **equality comparison** (`!==`) вместо **truthy checks** (`if (value && ...)`) для optional/nullable полей. Truthy guard блокирует пропагацию легитимных `undefined`/`null`/`0`/`""` значений.

```typescript
// WRONG — truthy guard blocks clearing
if (executor && executor.id !== this.executorId) {
  this.setExecutorId(executor.id);
}
// executor = undefined → ничего не происходит → stale value

// CORRECT — equality guard allows clearing
if (executor?.id !== this.executorId) {
  this.setExecutorId(executor?.id);
}
// executor = undefined → executorId = undefined → поле очищено
```

Флаги ревью:
- Truthy guard (`if (x && x !== y)`) на optional/nullable поле — **warning**: блокирует пропагацию `undefined`/falsy clearing.
- `if (value)` вместо `if (value !== currentValue)` в sync-логике между сторами — **warning**: потенциально блокирует clearing.

### API calls placement
- API/IO вызовы **только** в `private` методах стора.
- `@action.bound` методы — тонкие: guard-check → делегирование в private метод.
- Компоненты **никогда** не вызывают API напрямую.

Флаги ревью:
- API-вызов внутри `@action.bound` метода — **warning**: вынести в private метод.
- API-вызов в компоненте — **critical**: перенести в стор.

### Lifecycle initialization
- `init()` / `onMount()` дочернего стора вызывается из **родительского стора**, не из component `useEffect`.
- Компоненты **не должны** триггерить загрузку данных стора через `useEffect`. Родительский стор оркестрирует lifecycle дочерних сторов.
- `dispose()` вызывается родительским стором в его `onUnmount()` для предотвращения stale-state обновлений.

Флаги ревью:
- Component `useEffect` вызывает `store.loadX()` или `store.init()` — **warning**: перенести вызов в родительский стор `onMount`.
- Отсутствие `dispose()` / disposed guard в сторе с async операциями — **warning**.
- Parent store не вызывает `child.dispose()` в `onUnmount()` — **warning**.

### View ↔ Store boundaries
- Бизнес-логика и IO остаются в Store/Service, не во View.
- Компоненты, читающие observable, должны быть `observer(...)`.
- `useEffect` не должен подменять lifecycle store-логики.

### TypeScript safety
- Не использовать `any` и небезопасные касты.
- Использовать явные интерфейсы для state и публичного API store.
- Избегать `!` без строгого доказательства инициализации.

## Output format

```markdown
## Summary
- [1-3 bullets по итогам]

## Scope
- Branch: `<BRANCH>`
- Parent ref: `<PARENT>`
- Merge-base: `<BASE_SHA>`
- Scope mode: `<default-with-uncommitted | explicit-hash-range>`

## Critical issues (must fix)
### [Короткий заголовок]
- **Rule**: [core/mobx-store-template.mdc / core/code-style-patterns.mdc]
- **Why**: [почему это риск]
- **Where**: `path/to/file.ts` (строки из diff)
- **Fix**: [минимальное исправление]
- **Proposed patch**:
```diff
[unified diff]
```

## Warnings
[тот же формат]

## Suggestions
[точечные улучшения без расширения scope]

## File-by-file notes
- `path/to/file`: [краткие заметки]
```

## Rules of engagement

- Не предлагай новые библиотеки без запроса.
- Если есть несколько вариантов, дай один default и один краткий альтернативный.
- Исправления предлагай как минимальные патчи, не переписывай крупные блоки без необходимости.

---

## Scope Boundaries

This skill covers **MobX store and state logic** — targeted review of store internals following `mobx-store-template.mdc` and `code-style-patterns.mdc`.

| Concern | This skill | Use instead |
|---------|-----------|-------------|
| Store structure, actions, computed, reactions, async runInAction | ✅ YES | — |
| View↔Store boundary violations | ✅ YES | — |
| General code quality, readability, tests | ❌ NO | `code-ai-review` |
| Learned-convention enforcement | ❌ NO | `code-learned-review` |
| Naming/style/architecture patterns outside stores | ❌ NO | `code-style-review` |

---

## Job Context Awareness

When dispatched by `job-orchestrator` as part of a job pipeline, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: .metaproject/jobs/<job-name>/ai/context.md
```

If provided and the file exists, read the context document before starting the review. Use it to:
- Understand which libraries and patterns were intentionally chosen for the implementation
- Validate MobX patterns against documented project conventions
- Avoid flagging intentional architectural decisions as issues

If the file does not exist or is not provided, proceed normally — context is optional and non-blocking.

---

## Red Flags

This profile is a thin legacy wrapper around `mobx-store-template.mdc`. It
predates the shared finding contract, it does not use the review domain's
severity vocabulary at all, and half of it is written in Russian — each of those
is a way it misfires, and they are the rows below.

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "The checklist prints severities, so this report is a review result." | It is not. `Critical` / `Warnings` / `Suggestions` are section headings in a Markdown document, not a severity field: this profile predates `reviewer-finding.schema.json` and emits free prose with no machine-readable finding. Hand it to a person, never to `keryx review ingest`. |
| "Half the instructions are in Russian, so the report should be." | The mixed language is an artefact of when this file was written. Write the report in the language the requester used. |
| "The two stores sync both ways and I have not seen an infinite loop." | A bounce needs one ordering to appear, and reading the code is not running it. The checklist rates a bidirectional sync with no equality guard as **critical** for exactly that reason: the absence of the guard is the finding, not the absence of a reproduction. |
| "`if (value && value !== other)` is the safer guard." | It is the guard that silently refuses to clear. `undefined`, `null`, `0` and `""` are legitimate values to propagate, and a truthy check strands the stale one instead. |
| "The component's `useEffect` calls `store.init()` — that is ordinary React." | Not under this architecture. The parent store orchestrates its children's lifecycle, and moving that into a component is how `dispose()` stops being called and stale async writes start landing. |
| "The method is only called by another store, so `@action.bound` is harmless." | The decorator publishes it. Inter-store callbacks and internal handlers are `private` here; the naming patterns the checklist lists are the tell, and the decision question is whether a React component calls it. |
| "While I was in the store I also noticed naming and component problems." | The Scope Boundaries table routes those to `code-style-review` and `code-ai-review`. A finding filed under the wrong profile arrives without the checks that lane would have applied. |

---

## Verification

Report done only once all of these hold:

- The requester asked for this profile by name, or through
  `review --legacy-profiles`. A general frontend or store review with no profile
  named belongs to `review-orchestrator`.
- The scope block carries the real branch, parent ref, merge-base and scope mode —
  not the template placeholders.
- Every entry carries Rule, Why, Where (path plus the lines from the diff) and
  Fix, with a minimal unified diff where the fix is a line or two.
- Every entry is anchored to a line the branch slice actually changed; legacy
  store code outside that slice is not discussed.
- Entries are sorted into this document's own Critical / Warnings / Suggestions
  sections, and are not presented as a severity any other reviewer or tool
  consumes.
- The report is free prose by design, so it is delivered to a person and is not
  fed into the managed-review pipeline.

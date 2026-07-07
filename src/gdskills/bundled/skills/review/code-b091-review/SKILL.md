---
name: code-b091-review
description: "Performs strict b091-style code review following code-review-b091-profile.mdc. Reviews current branch changes from merge-base. Direct, no-fluff feedback focused on logic correctness. Use when: b091 review requested, strict validation needed."
triggers:
  - "Review as b091"
  - "b091 style review"
  - "b091 review"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
---

# Code Review as b091 (только текущая ветка)

## Workflow

Copy this checklist and track progress:

```
b091 Review Progress:
- [ ] Step 1: Determine parent branch and calculate merge-base
- [ ] Step 2: Collect git diff (committed + local changes)
- [ ] Step 3: Apply b091 principles (logic in correct layer, no ducttape)
- [ ] Step 4: Check types (no any, typed mocks)
- [ ] Step 5: Verify conventions (currentState, I prefix, etc.)
- [ ] Step 6: Challenge all assumptions
- [ ] Step 7: Generate direct report with patches
```

## Обязательные правила

1. **Скоуп по умолчанию (без commit hash/range в запросе)**: ревью включает **все** изменения в текущей ветке от точки ответвления (merge-base) от родительской ветки:
   - закоммиченные (`BASE_SHA..HEAD`)
   - локальные незакоммиченные (staged/unstaged/untracked)
2. **Скоуп при явном commit hash/range**: если пользователь явно передал hash или диапазон, ревьюй только запрошенный диапазон; локальные незакоммиченные изменения не добавляй, если это отдельно не попросили.
3. **Стиль/принципы b091**: ревью строго по `~/goodai-base/rules/core/code-review-b091-profile.mdc` (разделы правил и промпт).
4. **Результат**: подробный отчёт по проблемам с объяснением и предложением исправлений (минимальные патчи там, где это просто).

## Scope Detection

See shared script: `skills/shared/git-merge-base.md`

Run the script from that file to determine MERGE_BASE and SCOPE before proceeding with the review.

## Команды, чтобы собрать “срез” для ревью

### A) Режим по умолчанию (пользователь НЕ дал hash/range)

```bash
git status

# Закоммиченная часть ветки
git log --oneline "${BASE_SHA}..HEAD"
git diff --stat "${BASE_SHA}..HEAD"
git diff --name-status "${BASE_SHA}..HEAD"
git diff "${BASE_SHA}..HEAD"

# Полный текущий срез от merge-base до рабочего дерева:
# включает commit'ы + staged + unstaged
# (untracked смотри через git status / git ls-files)
git diff --stat "${BASE_SHA}"
git diff --name-status "${BASE_SHA}"
git diff "${BASE_SHA}"
git ls-files --others --exclude-standard
```

### B) Режим с явным hash/range

Если пользователь дал конкретный hash/range, используй его буквально:

```bash
# Примеры:
git show --stat --name-status --patch <COMMIT_SHA>
git log --oneline <FROM_SHA>..<TO_SHA>
git diff --stat <FROM_SHA>..<TO_SHA>
git diff --name-status <FROM_SHA>..<TO_SHA>
git diff <FROM_SHA>..<TO_SHA>
```

## Как ревьюить (по b091)

Применяй чек-лист и промпт из `~/goodai-base/rules/core/code-review-b091-profile.mdc`. Ключевые акценты b091:

- Логика должна жить в правильном слое (часто — в store), чтобы её можно было нормально тестировать. Никогда не мешать Domain Store и UI Component Store (это жёстко карается как нарушение SOLID/Layering).
- Против “patch/glue/ducttape”: требуй чинить причину, а не маскировать симптомы.
- Строго против раздутых, "водянистых" AI-сгенерированных описаний PR. Только суть и польза.
- Не допускай регрессий и возвращения старых архитектурных ошибок (например, добавления UI-моделей в core DTO).
- В новом коде никаких `any`, `as any`, небезопасных кастов; моки — типизированные и не наследуются от реальных реализаций.
- Не плодить дублирование правил/проверок: один источник правды, переиспользовать сеттеры/методы.
- Конвенции проекта обязательны (например, `currentState`, `I` для интерфейсов, консистентные типы).
- Магические числа / `setTimeout(0)` / "страшные" хаки — только с чётким "почему", либо перепроектировать.
- **Accessibility модификаторы в сторах**: inter-store callbacks (`onChangeX`, `onFireX`, `handleX`, `syncX`) обязаны быть `private`. Публичный метод допустим только если он вызывается из React-компонента. Спросить: "Вызывается ли этот метод из JSX?" Если нет — `private`.
- С MobX по умолчанию **не добавлять** `useCallback`/`useMemo` без явной необходимости.
- Предложения должны проходить линт; не нитпикать автоформатирование.
- Не раздувать scope: большие рефакторы “not today”, если вне задачи.

## Формат вывода (подробный отчёт + тон b091)

Пиши по-русски, но допускай короткие b091-маркеры (например, `not today ;P`, “ducttape”, “broken thinking”) только по делу и без перехода на личности.

Используй структуру:

```markdown
## Вердикт (b091)

<OK / needs work / fundamentally wrong> + 1–3 самых важных тезиса.

## Скоуп ревью (только текущая ветка)

- Ветка: `<BRANCH>`
- Parent ref: `<PARENT>`
- Merge-base: `<BASE_SHA>`
- Режим скоупа: `<default-with-uncommitted | explicit-hash-range>`
- Коммиты (merge-base..HEAD): <N>
- Изменённые файлы: <список или количество>

## Находки (подробно)

### Архитектура и место логики

<находки>

### Типы, касты, моки

<находки>

### Корректность и семантика состояний

<находки>

### Конвенции и консистентность

<находки>

### Линт/формат/шум

<находки>

### UX/edge cases

<находки>

### Тестируемость

<находки>

## Предложенные исправления (patches)

<минимальные unified diff-патчи для очевидных правок>
```

### Формат каждой находки (обязательно)

Для каждой находки укажи:

- **Severity**: `blocker` / `major` / `minor`
- **Location**: путь файла + релевантный hunk/фрагмент из diff
- **Problem**: что не так
- **Why it matters**: почему это важно (корректность/тестируемость/конвенции/поддерживаемость)
- **Suggested fix**: что конкретно сделать (точечно, без раздувания scope)
- **Optional patch**: если фикс простой — unified diff

Пример блока патча:

```diff
diff --git a/path/file.ts b/path/file.ts
index 0000000..1111111 100644
--- a/path/file.ts
+++ b/path/file.ts
@@ -1,3 +1,3 @@
-const x = 1;
+const x = 2;
```

---

## Scope Boundaries

This skill covers **b091-style code review** — direct, logic-first, no-fluff feedback following `code-review-b091-profile.mdc`.

| Concern                                                       | This skill | Use instead              |
| ------------------------------------------------------------- | ---------- | ------------------------ |
| Logic correctness, layer violations, type safety, conventions | ✅ YES     | —                        |
| General AI review (broader quality, performance, UX)          | ❌ NO      | `code-ai-review`         |
| MobX store internals (actions, computed, reactions)           | ❌ NO      | `code-mobx-store-review` |
| Pure style/naming/architecture pattern audit                  | ❌ NO      | `code-style-review`      |

---

## Job Context Awareness

When dispatched by `job-orchestrator` as part of a job pipeline, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: ~/goodai-base/jobs/<job-name>/ai/context.md
```

If provided and the file exists, read the context document before starting the review. Use it to:

- Understand which libraries and patterns were intentionally chosen for the implementation
- Avoid flagging correct library usage as issues
- Provide more accurate findings by understanding the project's architectural decisions

If the file does not exist or is not provided, proceed normally — context is optional and non-blocking.

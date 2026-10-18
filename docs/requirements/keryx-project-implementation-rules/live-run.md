# Живой прогон на vantage-frontend (AC22)

Это runbook для оператора. Реализующий агент его не запускал; AC22 остаётся
неподтверждённым, пока вы не пройдёте шаги и не запишете результат.

Что доказываем: после импорта правил Vantage новой сборкой одна задача
реализации для `.tsx` и одна задача тестов дают результаты, где
`project_context_applied` покрывает `must_read` из резолвера, а вы видите вывод
резолвера и отчёт валидатора.

Репозиторий Vantage в этом прогоне только читается и получает один небольшой
локальный правочный diff; не коммитьте и не пушьте его.

## 0. Подготовка

```bash
cd /home/altsay/work/vantage-frontend
git status --short            # должно быть чисто; иначе остановитесь
k() { bun /home/altsay/keryx/.worktrees/project-implementation-rules/src/cli.ts "$@"; }
k status                      # .metaproject должен быть; если нет — остановитесь и сообщите координатору
```

`k` запускает сборку ветки `feat/project-implementation-rules`, а не
глобальный `keryx`. Глобальный бинарник на эту ветку не обновлён.

## 1. Импорт правил

Каталог с файлами правил Vantage (`.mdc` / `.md`) обозначим `<RULES_DIR>`.

```bash
k skills import --rules <RULES_DIR>
ls .metaproject/rules/project
```

Ожидаем: строка `imported: N` и файлы в `.metaproject/rules/project/`. Для
чтения на месте без копирования добавьте `--link` и повторите шаг 2 — резолвер
должен дать те же записи, но с пометкой `linked`.

Запишите: сколько правил импортировано и есть ли среди них файл-индекс больше
30 КБ с `alwaysApply: true`.

## 2. Резолвер для `.tsx`

Выберите существующий компонент `<TSX_FILE>` (например, из `src/…`).

```bash
mkdir -p .metaproject/data/skills/project-context/runs
k skills resolve-context --files <TSX_FILE> --for implement --task-type ui_component \
  --out .metaproject/data/skills/project-context/runs/impl.json
k skills resolve-context --files <TSX_FILE>.test.tsx --for test \
  --out .metaproject/data/skills/project-context/runs/test.json
```

Ожидаем в выводе: сначала записи `project rule` / `project skill`, затем
`bundled`; индекс — в `on_demand` с пометкой `index`; строка `Budget: X of 131072
bytes`. Если появилось предупреждение `over the … cap`, поднимите
`gdskills.projectContext.maxBytes` в `.metaproject/tasks.config.json`, а правила
не режьте.

Приложите оба вывода к отчёту.

## 3. Задача реализации

1. Дайте воркеру `task-implementer` небольшую правку в `<TSX_FILE>` (например,
   добавить подпись на уже существующий элемент). В промпт включите содержимое
   `impl.json` и требование вернуть `project_context_applied`.
2. Сохраните результат воркера как `impl-result.json`.
3. Проверьте:

```bash
k skills contracts validate impl-result.json --schema task-implementer-output \
  --resolved .metaproject/data/skills/project-context/runs/impl.json
```

Ожидаем: `valid: …`, `schema: task-implementer-output` и строку `project context:
every must_read entry cited, nothing drifted (enforcement warn)`. Приложите вывод.

## 4. Задача тестов

То же для `tests-creator` и `test.json`; результат сохраните как
`test-result.json`:

```bash
k skills contracts validate test-result.json --schema tests-creator-output \
  --resolved .metaproject/data/skills/project-context/runs/test.json
```

## 5. Контроль, что проверка работает

1. Удалите из `impl-result.json` одну запись `must_read` и повторите
   `contracts validate`. Ожидаем `project context: 1 miss(es), 0 drifted (enforcement warn)` и строку
   `project context miss: <путь>` (код выхода при `warn` остаётся `0`).
2. В `.metaproject/tasks.config.json` поставьте
   `{"gdskills":{"projectContext":{"enforcement":"block"}}}` и повторите. Ожидаем
   код выхода `1`. Верните `warn` (или удалите ключ).

## 6. Уборка

```bash
git checkout -- <TSX_FILE>    # откат правки воркера
git status --short            # правила и данные лежат в .metaproject/, это ожидаемо
```

## 7. Что записать как доказательство

- вывод шагов 1–2 (импорт и оба резолвера);
- вывод валидатора для реализации и для тестов (шаги 3–4);
- результат шага 5 (промах пойман, `block` даёт код `1`);
- статус CI на ветке `feat/project-implementation-rules`: зелёный.

Когда всё это собрано: `keryx flow ac confirm 461 AC22 --note "<ссылка на
записанные выводы>"`.

Сравнение с vantage-ai-assistant координатор делает отдельно после вашего
прогона.

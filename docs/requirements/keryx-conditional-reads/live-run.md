# Живой прогон на vantage-frontend (AC20)

Это runbook для оператора. Реализующий агент его не запускал; AC20 остаётся
неподтверждённым, пока вы не пройдёте шаги и не запишете результат в журнал
flow 462.

Что доказываем: на реальных STYLING.md и THEMING.md резолвер поднимает документ
в `must_read` только когда сработало объявленное условие, а валидатор принимает
результат воркера со ссылкой на якорь и пересказом раздела и отклоняет
выдуманный пересказ.

Репозиторий Vantage в этом прогоне только читается и получает один небольшой
локальный правочный diff; не коммитьте и не пушьте его.

## Что уже проверил e2e-тест, а что покажет только этот прогон

Тест `src/gdskills/conditional-reads.e2e.test.ts` (AC18) собирает временный
проект с документами размером около 90 КБ и 80 КБ и гоняет настоящие команды
`skills resolve-context`, `skills contracts validate --resolved` и
`skills references check`. Он подтверждает:

- условие (glob или слово из текста задачи) поднимает нужный документ и не
  поднимает другой; для несвязанной задачи не поднимается ни один;
- бюджет считает размер раздела (`section_bytes`), а не файла;
- честный результат (путь, sha256 всего файла, якорь, пересказ словами раздела,
  `how: "read"`) проходит; выдуманный, слишком короткий, с чужим якорем и
  `how: "n/a"` для поднятой записи дают промахи с причинами;
- под `warn` код выхода `0`, под `block` код выхода `1`.

Чего тест показать не может и что проверяет только живой прогон:

- как реальный воркер ведёт себя с задачей: читает ли раздел, пишет ли пересказ
  своими словами или копирует заголовки;
- реальные размеры, якоря и глобы Vantage (в тесте они придуманы);
- как выглядит вывод резолвера на реальных проектных правилах рядом с другими
  записями.

Проверка пересказа остаётся заменителем чтения, а не его доказательством:
пересказ должен делить минимум два различных слова из пяти и более букв с
разделом, так что воркер, который скопировал заголовки раздела, пройдёт. Это
сказано в PRD (риск 6) и в документации; прогон должен дать вам материал для
решения, достаточно ли этого.

## 0. Подготовка

```bash
cd /home/altsay/work/vantage-frontend
git status --short            # должно быть чисто; иначе остановитесь
k() { bun /home/altsay/keryx/.worktrees/conditional-reads/src/cli.ts "$@"; }
k status                      # .metaproject должен быть; если нет — остановитесь и сообщите координатору
```

`k` запускает сборку ветки `feat/conditional-reads`, а не глобальный `keryx`.
Если к моменту прогона flow 462 уже выпущен, замените `k` на `keryx` и сначала
выполните `keryx update` в проекте, чтобы скиллы оркестратора и воркеров были
новой версии (иначе воркер не знает про якорь и пересказ). В режиме `k` скиллы
проекта надо обновить так же: `k update`.

Правила Vantage должны быть уже импортированы (flow 461, AC22):
`ls .metaproject/rules/project`. Правило, которое цитирует документы,
должно называть их в обратных кавычках, например `` `STYLING.md` `` и
`` `THEMING.md` ``. Проверьте:

```bash
k skills references suggest   # печатает заготовку по цитатам; ничего не пишет
```

Ожидаем JSON, где `STYLING.md` и `THEMING.md` перечислены с `path`, а условия
пусты. Путь в декларации относителен корню проекта; если документы лежат не в
корне, используйте путь так, как его печатает `suggest`.

## 1. Декларации

Создайте `.metaproject/rules/project/references.json` (подставьте реальные
пути документов и якоря):

```json
{
  "schema": 1,
  "references": [
    {
      "path": "STYLING.md",
      "when": {
        "globs": ["src/**/*.css", "src/**/*.tsx"],
        "keywords": ["styling", "tailwind"]
      },
      "anchor": "<заголовок раздела с конвенциями классов>",
      "description": "Class conventions and the Tailwind 4 cascade contract. Read before changing a className, a stylesheet or inline style."
    },
    {
      "path": "THEMING.md",
      "when": {
        "globs": ["src/theme/**"],
        "keywords": ["theme", "dark mode"]
      },
      "anchor": "<заголовок раздела с токенами темы>",
      "description": "Theme tokens, contrast and dark mode. Read before adding a colour role, a theme or a dark mode switch."
    }
  ]
}
```

Якорь — текст заголовка ATX (`## ...`) без решёток, регистр не важен, или его
slug. Раздел идёт до следующего заголовка того же или более высокого уровня,
вложенные `###` входят в него. Проверьте декларации:

```bash
k skills references check
```

Ожидаем итоговую строку `0 errors, 0 warnings`. Ошибки (`missing`,
`anchor not found`, `oversized`) исправьте до продолжения. Предупреждения о
коротком описании (меньше 20 символов) или слове (меньше 4) тоже исправьте.
Запишите размеры документов и размер раздела каждого якоря из вывода резолвера
ниже.

## 2. Три задачи

Для каждой задачи выполните резолвер, сохраните вывод, затем отдайте воркеру
`task-implementer` небольшую правку и проверьте его результат валидатором.
Текст задачи передаётся и воркеру, и резолверу (`--task-text`): слова-условия
ищутся в нём.

```bash
mkdir -p .metaproject/data/skills/project-context/runs
```

### Задача A: затронут файл стилей

Файл: существующий `<TSX_FILE>` под `src/` (например, компонент кнопки).
Текст: `Add a loading spinner prop to the button` (без слов `styling`,
`tailwind`, `theme`, `dark mode`).

```bash
k skills resolve-context --files <TSX_FILE> --for implement --task-type ui_component \
  --task-text "Add a loading spinner prop to the button" \
  --out .metaproject/data/skills/project-context/runs/a.json
```

Ожидаем в выводе:

- в `## must_read` строка для STYLING.md вида
  `- STYLING.md — project contract, condition:glob:src/**/*.tsx, <N> bytes, sha256 <12 символов> (anchor "<ваш якорь>", section <M> bytes)`,
  где `M` много меньше `N`;
- в `## on_demand` строка для THEMING.md с причиной `declared`;
- строка `Budget: X of 131072 bytes (default)`, где `X` включает `M`, а не `N`.

### Задача B: только слово темы

Файл: существующий `.ts` вне `src/theme/` и не `.tsx` (например, утилита или
стор настроек). Текст: `Let the user pick a theme in the settings`.

```bash
k skills resolve-context --files <TS_FILE> --for implement --task-type ui_component \
  --task-text "Let the user pick a theme in the settings" \
  --out .metaproject/data/skills/project-context/runs/b.json
```

Ожидаем: в `## must_read` THEMING.md с причиной `condition:keyword:theme`
(якорь и `section` в скобках), в `## on_demand` STYLING.md с причиной
`declared`.

### Задача C: несвязанная

Файл: существующий `.ts` вне `src/theme/`. Текст:
`Fix the token refresh race in the session service`.

```bash
k skills resolve-context --files <TS_FILE> --for implement --task-type service_api \
  --task-text "Fix the token refresh race in the session service" \
  --out .metaproject/data/skills/project-context/runs/c.json
```

Ожидаем: ни одного `condition:` в `## must_read`; оба документа в
`## on_demand` с причиной `declared`, с описанием и условием; бюджет не
включает ни одного из них.

Если у ваших файлов или текста случайно сработало другое условие, это не
ошибка прогона: выберите другие файл и слова и запишите, что произошло.

## 3. Результаты воркера и вердикты

Для задач A и B дайте воркеру содержимое `a.json` / `b.json`, текст задачи и
требование вернуть `project_context_applied`, где для поднятой записи указаны
`path`, `sha256` всего файла, `anchor` и `summary`, а `how` — `read` или
`followed`. Сохраните результат как `a-result.json`, `b-result.json`,
`c-result.json`.

```bash
k skills contracts validate a-result.json --schema task-implementer-output \
  --resolved .metaproject/data/skills/project-context/runs/a.json
```

То же для `b` и `c`. Ожидаем для каждой задачи, где воркер прочитал раздел и
пересказал его своими словами:

```
valid: <файл>
schema: task-implementer-output
project context: every must_read entry cited, nothing drifted (enforcement warn)
```

Для задачи C `must_read` состоит только из проектных правил, поэтому вердикт
чистый и без пересказа.

Если воркер вернул промах, не правьте его руками: запишите вывод. Это
результат прогона, а не помеха.

## 4. Выдуманный пересказ

Скопируйте `a-result.json` в `a-fake.json` и замените `summary` записи
STYLING.md общей фразой без слов из раздела, например:
`Looked over the whole thing, nothing unusual noticed, all requirements satisfied as expected.`

```bash
k skills contracts validate a-fake.json --schema task-implementer-output \
  --resolved .metaproject/data/skills/project-context/runs/a.json
```

Ожидаем (код выхода `0` под `warn`):

```
project context: 1 miss(es), 0 drifted (enforcement warn)
- project context miss: STYLING.md (condition:glob:src/**/*.tsx) has a summary that shares 0 distinct word(s) of 5 or more letters with the section "<ваш якорь>"; 3 required. Write the summary in the wording of the text you read
```

Дополнительно, по желанию, каждый вариант отдельно:

- пересказ `Read the section.` даёт два промаха: длину
  (`has a summary of 17 characters; at least 40 are required`) и слова;
- другой `anchor` даёт промах `cites anchor "<чужой>"; the declaration says
  "<ваш якорь>"`;
- запись с `how: "n/a"` даёт промах `is cited only with how "n/a"`.

Затем включите блокировку: в `.metaproject/tasks.config.json` поставьте
`{"gdskills":{"projectContext":{"enforcement":"block"}}}`, повторите проверку
`a-fake.json` и убедитесь, что строки идут в stderr, а код выхода равен `1`
(`echo $?`). Верните `warn` или удалите ключ.

## 5. Критерий прохождения

Прогон пройден, если выполнено всё:

1. `references check` на реальных документах: `0 errors`.
2. Задача A поднимает STYLING.md по glob, THEMING.md остаётся `on_demand`.
3. Задача B поднимает THEMING.md по слову `theme`, STYLING.md остаётся
   `on_demand`.
4. Задача C не поднимает ни один из двух документов.
5. Честные результаты воркера A и B проходят с чистым вердиктом; результат C
   тоже.
6. Выдуманный пересказ из шага 4 даёт промах `summary-words` с указанной
   причиной, а под `block` код выхода равен `1`.
7. Бюджет в задачах A и B включает размер раздела, а не файла.

Прогон не пройден, если нарушен любой пункт. Типичные причины и что с ними
делать:

- декларация не срабатывает: проверьте glob относительно корня проекта и слово
  целиком (слово ищется как отдельное, без учёта регистра);
- честный результат отклонён по `summary-words`: запишите раздел, пересказ и
  число общих слов; это сигнал, что порог в два слова слишком строг для вашего
  раздела;
- выдуманный пересказ прошёл: запишите текст; это сигнал, что заменитель
  слишком слаб, и решение о порогах принимает оператор.

## 6. Уборка

```bash
git checkout -- <TSX_FILE> <TS_FILE>      # откат правок воркера
git status --short                        # references.json и данные лежат в .metaproject/, это ожидаемо
```

## 7. Запись результата в журнал flow 462

Отдельной команды `flow journal` нет. Результат записывается так:

```bash
k flow ac confirm 462 AC20 --note "Живой прогон на vantage-frontend <дата>: A glob ok, B keyword ok, C ничего не поднято; выдуманный пересказ отклонён (summary-words); результат: pass|fail; выводы в <путь или ссылка>"
```

Команда добавляет в `.metaproject/flows/462-2026-10-18-conditional-reads/journal.md`
запись `ac-confirmed`. Если прогон не пройден, не подтверждайте критерий:
добавьте вручную строку в конец `journal.md` в том же формате
(`- <ISO-время> - live-run: <что произошло, какой пункт критерия нарушен>`) и
сообщите координатору.

Приложите к записи:

- вывод `references check` (шаг 1);
- три вывода резолвера (шаг 2);
- три вердикта валидатора и вердикт для выдуманного пересказа (шаги 3–4);
- наблюдение о том, как воркер писал пересказ: своими словами или копией
  заголовков.

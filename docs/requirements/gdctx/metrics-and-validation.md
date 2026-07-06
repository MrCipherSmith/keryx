# gdctx: метрики сокращения контекста и проверка

## 1. Назначение документа

Этот документ фиксирует текущий механизм проверки эффективности `gdctx` и фактические замеры по проекту `meta-project`.

Эти данные можно использовать позже:

- в release notes;
- в README проекта;
- в описании преимуществ Metaproject;
- как baseline для будущей команды `gd-metapro ctx metrics`.

## 2. Что измеряем

`gdctx` сохраняет два вида output после каждой команды:

- raw output: `.metaproject/data/gdctx/raw/*.log`;
- compact summary: `.metaproject/data/gdctx/artifacts/*.md`.

В конце каждого summary есть блок `Metadata`:

```json
{
  "bytesIn": 39028,
  "bytesOut": 4311,
  "truncated": true
}
```

Где:

- `bytesIn` - размер исходного raw output;
- `bytesOut` - размер compact summary без metadata overhead;
- `truncated` - был ли output сокращен.

## 3. Формулы

Сокращение контекста по байтам:

```text
compression = 1 - bytesOut / bytesIn
```

В процентах:

```text
compressionPercent = (1 - bytesOut / bytesIn) * 100
```

Грубая оценка токенов:

```text
tokens ~= bytes / 4
```

Важно: `bytes / 4` - приблизительная оценка для кода и англоязычного текста. Для русского текста и смешанного Markdown точность ниже, но порядок величины подходит для release-level оценки.

## 4. Текущие фактические замеры

Замеры ниже получены из `Metadata` в `.metaproject/data/gdctx/artifacts/*.md`.

| Команда | Raw bytes | Summary bytes | Сокращение |
|---|---:|---:|---:|
| `gd-metapro ctx rg "gdctx|ctxCommand|renderGdctx|noGdctx|gd-metapro ctx" src .metaproject README.md docs/requirements/gdctx` | 23,103 | 4,840 | 79.1% |
| `gd-metapro ctx read src/commands/init.ts --mode outline` | 17,091 | 4,563 | 73.3% |
| `gd-metapro ctx read src/cli.ts --mode outline` | 1,850 | 594 | 67.9% |
| `gd-metapro ctx rg "gdctx|gdgraph|Metaproject|ctx" AGENTS.md .metaproject src/lib/templates.ts README.md` | 39,028 | 4,311 | 89.0% |
| `gd-metapro ctx read src/lib/templates.ts --mode outline` | 19,539 | 2,257 | 88.4% |

Итого по этим проверкам, без учета дубликата `latest.md`:

```text
Raw:     102,453 bytes
Summary: 18,485 bytes
Saving:  83,968 bytes
Average compression: ~82.0%
```

Грубая token-estimate:

```text
Raw:     ~25,600 tokens
Summary: ~4,600 tokens
Saving:  ~21,000 tokens
```

Вывод: на реальных командах поиска и чтения по этому проекту `gdctx` сейчас сокращает контекст примерно на `70-90%`, среднее по текущему baseline около `82%`.

## 5. Негативный пример

Для маленьких файлов `gdctx` может не дать экономии из-за metadata overhead.

Пример:

| Команда | Raw bytes | Summary bytes | Результат |
|---|---:|---:|---:|
| `gd-metapro ctx read .metaproject/index.md --mode compact` | 1,842 | 1,920 | -4.2% |

Это ожидаемо: `gdctx` полезнее для больших outputs, широкого поиска, diff, логов тестов, lint/build и чтения крупных файлов.

## 6. Как повторить проверку вручную

### 6.1 Сгенерировать artifacts

```bash
gd-metapro ctx rg "gdctx|ctxCommand|renderGdctx|noGdctx|gd-metapro ctx" src .metaproject README.md docs/requirements/gdctx
gd-metapro ctx read src/commands/init.ts --mode outline
gd-metapro ctx read src/cli.ts --mode outline
gd-metapro ctx rg "gdctx|gdgraph|Metaproject|ctx" AGENTS.md .metaproject src/lib/templates.ts README.md
gd-metapro ctx read src/lib/templates.ts --mode outline
```

### 6.2 Посмотреть последний summary

```bash
gd-metapro ctx show latest
```

### 6.3 Посмотреть raw output последней команды

```bash
gd-metapro ctx show latest --raw
```

### 6.4 Найти metadata во всех artifacts

```bash
rg -n '"bytesIn"|"bytesOut"|"truncated"|"command"' .metaproject/data/gdctx/artifacts
```

## 7. Что должна делать будущая команда metrics

Будущая команда:

```bash
gd-metapro ctx metrics
```

Должна показывать:

- количество artifacts;
- суммарный `bytesIn`;
- суммарный `bytesOut`;
- среднее сокращение;
- rough token estimate;
- top commands по экономии;
- количество `truncated: true`;
- предупреждение, если маленькие outputs увеличиваются из-за metadata overhead.

Ожидаемый пример вывода:

```text
gdctx metrics

Artifacts: 5
Raw:       102,453 bytes (~25,600 tokens)
Summary:   18,485 bytes (~4,600 tokens)
Saving:    83,968 bytes (~21,000 tokens)
Compression: 82.0%
Truncated: 5/5
```

## 8. Release wording draft

Короткая формулировка для релиза:

```text
gdctx reduces agent-visible command/search/read context by roughly 70-90% on current project checks, with an observed average around 82%. It preserves full raw output locally while returning compact summaries to the agent.
```

Русская версия:

```text
gdctx сокращает видимый агенту контекст команд, поиска и чтения файлов примерно на 70-90% по текущим проверкам проекта; среднее сокращение baseline около 82%. Полный raw output сохраняется локально, а агент получает компактное summary.
```

# gdskills: brainstorm and interview decisions

Version: 0.6.0

## 1. Исходная задача

В целевом проекте есть сложные модули, например `pipelines`: компоненты, stores, feature components, step-сущности с разной логикой и общими архитектурными паттернами.

Нужен инструмент, который по ссылке на модуль, компонент или другую сущность проекта:

- собирает архитектурный, дизайнерский, доменный и implementation context;
- формирует versioned skill для работы с этой сущностью;
- умеет описывать, как создавать похожую сущность, рефакторить ее, тестировать и ревьюить;
- задает уточняющие вопросы об отличающейся бизнес-логике перед генерацией или изменением кода;
- проверяет актуальность skill при изменении кода, архитектуры или review findings;
- улучшает skill, если review выявил ошибки в коде, созданном на основе этого skill.

## 2. Brainstorm options

| Option | Description | Strengths | Risks |
|---|---|---|---|
| A. Manual templates | Skills создаются вручную по общему шаблону. | Самый простой MVP, низкий риск. | Быстро устаревает, мало автоматизации. |
| B. Graph/context/wiki-assisted generator | `gdgraph`, `gdctx` и `gdwiki` собирают evidence, generator создает skill. | Хороший баланс автоматизации и контроля. | Нужны строгие provenance и verification. |
| C. Fully self-learning system | Skills автоматически обновляются от review, tests и code changes. | Максимальная автономность. | Риск накопить неверные правила. |
| D. Configurable learning | Уровень автономности задается per project/module/entity. | Подходит для разных команд и рисков. | Требует конфигурации и audit trail. |

## 3. Recommended direction

Выбран подход:

- **B как основа**: генерация использует `gdgraph` + `gdctx` + `gdwiki`.
- **D для learning**: политика автономности настраивается per project/module/entity.

## 4. Interview decisions

### 4.1 Autonomy

Решение: **C + D**.

Система должна уметь полностью автономно обновлять skills, но уровень автономности должен быть управляемым через конфиг:

- `suggest-only`;
- `auto-high-confidence`;
- `fully-autonomous`.

### 4.2 Storage

Решение: **A, с возможностью D позже**.

Source of truth для generated project skills:

```text
.metaproject/project-skills/<module>/<entity>/
```

Для крупных модулей в будущем допускаются reference-файлы рядом с кодом, но canonical project skill остается в `.metaproject/project-skills`.

### 4.3 Skill format

Решение: **C, hybrid**.

Простые сущности получают один `SKILL.md`. Сложные сущности получают skill package:

```text
.metaproject/project-skills/<module>/<entity>/
  SKILL.md
  references/
    context.md
  templates/
  verification.md
  skill-changelog.md
```

Рабочие Metaproject skills остаются в `.metaproject/skills/gdskills/`.

### 4.3.1 Native bundled gdskills

Решение: `gd-metapro` должен иметь собственный bundled catalog рабочих skills/orchestrators.

`goodai-base` можно использовать только как reference при проектировании. У пользователя может не быть установлен `goodai-base`, поэтому `gd-metapro init` должен работать из собственного пакета: устанавливать native working skills в `.metaproject/skills/gdskills/`. Agent entrypoints должны сначала читать local Metaproject catalog, затем local project-skills, затем native gdskills, и только после этого явно разрешенные глобальные runtime skills.

### 4.4 Freshness detection

Решение: **D, combination**.

Verifier определяет устаревшие skills через:

- ownership map: `owned_files`, `observed_files`, `observed_globs`;
- `gdgraph affected`;
- semantic checks against current code, wiki and review lessons.

### 4.5 Learning from review

Решение: **D + mandatory changelog**.

Skill learning должен:

- фиксировать review lessons с provenance;
- обновлять инструкции, templates и checklists при высокой уверенности;
- вести `skill-changelog.md` рядом со skill;
- описывать изменения по версиям.

### 4.6 Verify triggers

Решение: **D**.

`skill-verify-skill` запускается:

- вручную через CLI;
- через optional git hook;
- внутри orchestrator/review pipeline.

`gd-metapro init` должен спрашивать, создавать ли hook.

### 4.7 Target input

Решение: **D**.

Generator принимает:

- path: `src/pipelines/steps/http-step`;
- symbol: `PipelineStepStore`;
- wiki reference: `wiki://pipelines/steps`.

MVP может начать с path, но schema должна сразу поддерживать все три target types.

### 4.8 Existing skill update behavior

Решение: **D**.

Если skill уже существует, generator/verifier:

- создает diff/proposed update;
- автоматически merge-ит только machine-managed sections;
- защищает manual sections;
- сохраняет provenance и обновляет `skill-changelog.md`.

## 4.9 Code Health as verification signal

Решение: использовать Code Health как дополнительный input для `skill-verify-skill`.

Health findings помогают verifier понять, что skill может быть неполным или устаревшим:

- skill-owned code получает повторяющиеся lint/type/test findings;
- coverage или complexity регрессируют после изменений;
- dependency/security audit указывает на проблему в integration pattern;
- health score entity/file/module ухудшается относительно baseline.

Health-derived learning должен идти через shared finding schema и команду:

```bash
gd-metapro skills learn --from-health .metaproject/data/health/artifacts/latest.json
```

## 4.10 Documentation Memory as verification signal

Решение: использовать Documentation Memory как дополнительный input для `skill-verify-skill`.

Memory помогает verifier понять, что skill не учитывает долговременный проектный опыт:

- accepted decision или constraint противоречит skill;
- accepted known mistake отсутствует в anti-patterns/checklist;
- accepted lesson или pattern должен обновить workflow/template;
- draft entries используются только как advisory context.

Memory-derived learning должен идти через layered search output и команду:

```bash
gd-metapro skills learn --from-memory .metaproject/data/memory/artifacts/latest.json
```

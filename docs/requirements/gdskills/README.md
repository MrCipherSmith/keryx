# gdskills requirements

Version: 0.19.0

`gdskills` - рабочий модуль Metaproject для управления lifecycle skills: создания, проверки, обучения, роутинга и синхронизации agent-facing skills.

В системе есть два разных домена skills:

- `gdskills` - native рабочие skills и orchestrators самого Metaproject, поставляемые вместе с `gd-metapro`.
- `project-skills` - контентно/компонентно зависимые skills целевого проекта: модуль, компонент, store, feature component, domain concept или wiki-сущность.

`gd-metapro` должен содержать собственный bundled catalog рабочих skills. `goodai-base` может быть только design reference при разработке, но установленный проект не должен зависеть от `goodai-base` или внешних глобальных skills.

Максимальный bundled package должен покрывать:

- routing и lifecycle project-skills;
- `job-orchestrator`, `context-collector`, `task-implementer`, `code-verifier`, `feature-analyzer`;
- `review-orchestrator` и специализированные review skills;
- quality/workflow skills: security, perf, tests, dependency update, commit, PR, changelog;
- planning/docs skills: brainstorm, interviewer, PRD/spec, project discovery, autodoc;
- platform/config skills: agent entrypoint manager, hook manager, catalog manager, runtime exporter и sync.

`gd-metapro init` должен поддерживать профили установки: `minimal`, `recommended`, `full`, `custom`. Default: `recommended`.

Контракты orchestrator/subagent валидируются CLI:

```bash
gd-metapro skills contracts list
gd-metapro skills contracts validate <file> --schema subagent-result
```

## Документы

- [prd.md](prd.md) - продуктовые требования и пользовательские сценарии.
- [specification.md](specification.md) - техническая спецификация CLI, storage, verifier и learning loop.
- [brainstorm.md](brainstorm.md) - результаты brainstorm/interviewer, принятые решения и trade-offs.
- [orchestrator-contracts.md](orchestrator-contracts.md) - schema-first протокол общения orchestrator/subagent.
- [implementation-plan-project-skills.md](implementation-plan-project-skills.md) - план реализации `skills create/generate` для canonical project-skills.
- [implementation-plan-verify.md](implementation-plan-verify.md) - план реализации `skills verify` / `skill-verify-skill`.
- [implementation-plan-learn.md](implementation-plan-learn.md) - план реализации learning proposals для `skills learn`.
- [implementation-plan-status.md](implementation-plan-status.md) - план расширения `skills status` для lifecycle summary.
- [implementation-plan-export.md](implementation-plan-export.md) - план runtime export для canonical project-skills.
- [implementation-plan-sync.md](implementation-plan-sync.md) - план explicit-target sync для exported runtime skills.
- [implementation-plan-hooks.md](implementation-plan-hooks.md) - план optional git hook для project-skill verification.
- [implementation-plan-discovery.md](implementation-plan-discovery.md) - план read-only discovery команд `skills list/inspect`.
- [implementation-plan-routing.md](implementation-plan-routing.md) - план project-skill routing команды `skills route`.

## Связанные модули

- `gdgraph` - источник связей, affected context, ownership candidates и impact analysis.
- `gdctx` - token-aware слой для компактного чтения релевантных файлов, diff, команд и логов.
- `gdwiki` - источник доменных знаний, architecture decisions, business rules и component/service descriptions.
- `Code Health` - источник quality findings, scope health metrics и regressions для `skill-verify-skill`.
- `Documentation Memory` - источник accepted lessons, decisions, constraints, known mistakes и patterns для `skill-verify-skill`.
- `spec-orchestrator` - включает `gdskills` при `gd-metapro init`, создает структуру `.metaproject/skills` и предлагает hook для `skill-verify-skill`.

## Рабочее имя

Рабочее имя CLI-модуля: `gdskills`.

Причина: модуль управляет lifecycle skills, а не только одной генерацией. Namespace должен покрывать `generate`, `verify`, `learn`, `status`, `export`, `sync` и будущую синхронизацию с agent runtimes.

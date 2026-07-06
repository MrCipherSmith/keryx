# gdctx requirements

`gdctx` - модуль Metaproject для token-aware работы с контекстом: командами shell, поиском, чтением файлов, diff/status output и длинными логами.

Цель модуля - возвращать агенту короткий, проверяемый и релевантный вывод вместо сырых больших outputs, сохраняя полный результат в `.metaproject/data/gdctx/raw/`.

## Документы

- [specification.md](specification.md) - спецификация модуля, CLI-контракт, структура данных и acceptance criteria.
- [metrics-and-validation.md](metrics-and-validation.md) - текущие замеры сокращения контекста, формулы и процедура проверки.

## Связанные модули

- `spec-orchestrator` - устанавливает модуль при `gd-metapro init`, создает структуру `.metaproject/` и регистрирует skill.
- `gdgraph` - используется как навигационный слой для выбора релевантных файлов перед чтением, поиском и анализом.

## Референс

Идея вдохновлена подходом [`rtk-ai/rtk`](https://github.com/rtk-ai/rtk): уменьшать объем токенов за счет фильтрации, группировки, дедупликации и сжатия outputs. `gdctx` не должен быть копией RTK: модуль должен быть встроен в Metaproject, знать про `.metaproject`, `gdgraph`, agent skills и правила версионирования generated data.

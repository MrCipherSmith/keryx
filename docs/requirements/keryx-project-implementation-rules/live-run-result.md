# Живой прогон на vantage-frontend: результат (2026-10-18)

Сборка: ветка `feat/project-implementation-rules`. Проект: `/home/altsay/work/vantage-frontend`, дерево было чистым, после прогона возвращено к чистому (`git checkout` трёх файлов).

## Шаги

1. Импорт: `skills import --rules <rules/core из vantage-ai-assistant>` положил 23 правила в `.metaproject/rules/project/`.
2. Резолвер для `src/components/AppErrorScreen.tsx` (implement, ui_component): 11 must_read, 21 on_demand, бюджет 68031 из 131072 байт, предупреждения о потолке нет. Для `AppErrorScreen.test.tsx` (test): 9 must_read, 22 on_demand, 71072 из 131072.
3. Воркер task-implementer: первый результат отклонён валидатором (неверная форма: task_id, status, лишние поля, `influence` вместо `how`). После исправления: `valid`, `project context: every must_read entry cited, nothing drifted (enforcement warn)`.
4. Воркер tests-creator: `valid`, те же условия. Красный тест не подтверждён (`red_verified: false`): код правки уже был в компоненте.
5. Контроль: убрана одна запись из `project_context_applied` — `1 miss(es), 0 drifted (enforcement warn)`, код выхода 0. С `enforcement: block` — код выхода 1, затем конфиг удалён.

## Находки

- Дубли в резолвере: импорт в `rules/project/` поверх копий установщика ревьюеров Vantage в `rules/project/core/` даёт каждое правило дважды с одинаковым sha256. Резолвер перечисляет оба. Нужна дедупликация по sha256 или единая раскладка.
- Предупреждения `cited by … but does not exist` для `core/design-system.mdc`, `core/styling.mdc` и т.п.: ссылки с префиксом `core/` не резолвятся к плоскому `rules/project/`.
- Воркер без явной схемы вернул неконтрактный JSON; детерминированный валидатор это поймал, в прозе этого не удержать.
- Побочный эффект: `npx vitest` изменил `pnpm-lock.yaml` (убрал `@pnpm/exe`); откатано.

## Не подтверждено

AC22 не подтверждён: ветка не опубликована, зелёного CI нет (последний пункт runbook).

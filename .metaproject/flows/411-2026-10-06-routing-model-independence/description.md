# Correct task routing: JEV fallback and assignments survive /model

Status: in-progress; routing independence implementation started
Source: human-request
Author: MrCipherSmith

## Problem

После `/model` switchTo устанавливает sessionModelExplicit, и shell пропускает классификацию следующих запросов. Настройки `/routing` сохраняются, но не влияют на dispatch. Старый контракт намеренно закреплён flow350 (бывший338) и тестами. Flow406 добавил диагностику, а не отмену pin. Fallback-классификатор безусловно использует модель сессии; provider-default не разрешается в конкретную модель turn.

## Expected Outcome

При `/route on` запросы выполняются моделями категорий независимо от переключений `/model`. `/model` задаёт baseline для `/route off`, session-default и безопасного fallback, но не отключает роутинг. Детерминированные shortcuts сохраняются; остальные запросы классифицирует включённый и доступный JEV, иначе достаточная доступная разрешённая модель. Классификатор и исполнитель задачи — отдельные решения.

## Outcome criteria

- Запрос (дословно): «Если я настроил /routing какая модель для чего, это должно работать даже если я в сессии меняю модель через /model.» (source: interactive operator request in current session)
- Эффект (формализация агента): модели категорий исполняют задачи после смены baseline; недоступность JEV не отключает весь роутинг.
- Как наблюдать (предложение агента): назначить разные модели двум категориям, выполнить запросы, дважды сменить `/model` и повторить запросы. Проверить фактические provider/model вызовы и причины fallback, не только теги.

## Out of Scope

- Остальные замечания flow406: очередь, slash-справка, /tasks, latency подагентов и экономия контекста.
- Изменение разрешений/credentials, обход policy gates, новая схема всех unattended/external вызовов.
- Отмена явных per-call override review/subagents.
- Реализация на этапе создания flow; commit/push без отдельного запроса.

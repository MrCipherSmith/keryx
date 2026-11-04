# Единый роутинг моделей Keryx
Version: 0.1.1

Status: draft implementation — код v2 проверяется в PR #1128. Приёмка и пилот открыты.
Date: 2026-11-04

## Назначение

Четыре независимых от провайдера класса возможностей и один механизм выбора исполнителя для интерактивных задач, review, субагентов и unattended/native sessions. Классификатор выбирает класс, resolver выбирает разрешённую доступную модель. Ручное назначение пользователя имеет приоритет над рекомендацией модели.

## Документы

- [PRD](prd.md): требования R1–R12, критерии выпуска и результата.
- [Спецификация](specification.md): модель данных, алгоритм, конфигурация, интерфейсы, acceptance criteria.
- [План реализации и миграции](implementation-plan.md): этапы M0–M5, совместимость, rollback.
- [Воспроизводимая проверка](verify.mjs): `bun docs/requirements/keryx-unified-model-routing/verify.mjs`.
- [Проверка пакета](verification.md): структурная проверка и docpack-review.
- [Схема конфигурации](schemas/routing-config.schema.json).
- [Схема ответа классификатора](schemas/classification.schema.json).
- [Схема решения resolver](schemas/routing-decision.schema.json).

## Область

Включены четыре класса Frontier/Expert/Standard/Light, многопровайдерные пулы, фиксированные назначения, availability/capability/budget gates, безопасный fallback, единый preview и журнал решений. Категории review/coding/docs и другие остаются отдельной осью.

Не включены обучение классификатора, автоматическая оценка качества моделей по их названиям, покупка доступа к провайдерам, перенос авторизации между аккаунтами, переисполнение инструментов после сбоя и управление внутренними моделями внешних agent CLI.

## Связь с существующими пакетами

- [Предыдущий Task Router](../keryx-jev-router/README.md): исторический дизайн category → model; этот пакет заменяет его правила выбора только после включения v2. Старый статус README не является доказательством текущего runtime.
- [Remote sessions](../hub-remote-sessions/README.md): сохраняются advertised candidates, ограничения executor и frozen config; v2 не расширяет разрешения remote session.
- [Roadmap](../roadmap.md).

Обоснование текущих расхождений и исходные точки кода приведены в спецификации. Новые команды и файлы runtime ниже являются планом, а не существующими возможностями.

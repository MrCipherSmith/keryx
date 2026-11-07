# Review V3: отчёт реализации
Version: 0.1.1

Статус: реализация и финальная проверка в процессе. Этот отчёт не является подтверждением выпуска или live benchmark.

## Реализованные контуры

- Каталог agent schema v2 с чтением v1, четыре сущности и явные unsupported constraints при экспорте.
- Persistent controller: общий ledger, роли/глубина/лимиты, fencing lease, idempotency, cancellation/unresolved, deadlines, recovery, validation priority.
- Immutable coverage plan и runtime registration: hash/version/revision, зарегистрированные waves/rounds, scope attenuation и plan-bound results/coverage.
- Native adapter на runAgentTurn и Shell TUI/readline/Hub host с семью review_agents tools.
- External Keryx adapter: dedicated worker, scoped Unix bridge, OS source/config containment, host-side provider preflight и process-group stop proof.
- CLI start/plan/spawn/status/wait/result/cancel, authenticated foreground terminal-host для внешнего управляющего harness (финальная интеграционная проверка в процессе).
- Review-orchestrator explicit opt-in --hierarchical; legacy путь сохраняется default.
- Перед completed обязателен валидный REVIEW_RESULT: schema, identity, revision и scope checks; blocked/невалидные ответы не сохраняются как успешные результаты.
- Native/external workers получают сохранённые input snapshots и plan-bound dispatch packets; повторное открытие run не перечитывает изменившиеся инструкции. Несоответствие hash/revision отклоняется без fallback.
- Явный экспорт `review-agents result --run-dir <run> --dispatch <id> --package <package>` создаёт raw/driver artifacts с provenance. Повторный экспорт идемпотентен, конфликты и symlink paths отклоняются; scope IDs должны совпадать с managed slice IDs. Автоматический ingest не запускается.

## Ограничения

Exact parent tool parity не реализована: host публикует toolParity:false. Native использует entity-declared confined read tools; external general имеет только пять bridge-tools, sourceInspection:false, oauthRefresh:false. Он может делегировать чтение scouts/soldiers. Запрос неподдерживаемых возможностей не считается fulfilled. Принятое D4 остаётся целевым контрактом; этот выпуск поддерживает явно объявленный ограниченный профиль.

OAuth-refresh внутри external worker не разрешён; до старта host проверяет выбранный provider/grant и необходимый lifetime. Usage/cost external может быть unknown. Measured-cost отклоняется без pre-spend enforcement; рабочий профиль cost-unknown явно не обеспечивает monetary cap. Live benchmark/cost/quality outcome не измерены и соответствующий release gate не закрыт. Версии vendor CLI processes (Codex/Claude/Pi) как generals не объявлены поддержанными.

## Проверки

Детальные команды, финальный verdict и remaining gaps фиксируются в verification.md. Связанный flow/job в дереве PR не найден. Изолированные и промежуточные зелёные прогоны не заменяют итоговый общий прогон. Реальные провайдеры/платные agents не запускались, auth stores этой работой не менялись. Валидация отправлена в PR #1134; snapshot и экспорт закоммичены отдельно, финальная интеграционная проверка продолжается.

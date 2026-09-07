# Acceptance Criteria

- AC1: **AC-08**: Изменённый graph/testing/health source обновляет accepted map; авторский текст побайтно одинаков; повторный sync не даёт diff; старый источник не становится fresh.
- AC2: **AC-21**: Первичная установка и update выполняют общие fixtures; повтор идемпотентен; crash после шага даёт partial и безопасное продолжение, не обещание полного rollback.
- AC3: **AC-22**: На 50/500/2000 страницах cold/repeated результаты одинаковы по смыслу с per-page oracle; ошибка Git даёт unknown; бюджет согласуется до оптимизации.
- AC4: **AC-26**: Исправление requirement/test помечает зависимые записи; независимое основание остаётся; cycle traversal конечен; повтор не дублирует связи; coverage ограничено known links.
- AC5: **AC-M02**: Много prompts не добавляют одинаковый orient; новый root/revision и compaction корректно обновляют; узкий subagent получает pointers, navigation agent может раскрыть router.
- AC6: **AC-W03**: Вопрос даёт explanation+точки изменения/tests; rename/delete помечает binding broken; одноимённый symbol не перехватывает ссылку.
- AC7: **AC-W05**: Зависимая секция помечена, несвязанная не затронута; parallel edits не теряются; Git failure unknown; приоритет сценария не скрывает остальные findings.
- AC8: Current focused/type/build/health checks and independent review have explicit evidence; prerequisites are satisfied; no required failed/incomplete check is relabeled PASS; partial acceptance is not full phase completion.

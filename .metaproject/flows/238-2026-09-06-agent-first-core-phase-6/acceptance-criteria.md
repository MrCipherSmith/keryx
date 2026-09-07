# Acceptance Criteria

- AC1: **AC-16**: Новый агент по указателю выбирает нужную операцию и восстанавливается из typed error; parity CLI/MCP/SDK; затраты маршрутизации измерены отдельно.
- AC2: **AC-23**: Фиксированный protocol воспроизводит arms и показывает выигрыши/проигрыши; гипотезы исправлений проверяются повторно, экономия первого ответа не равна пользе задачи.
- AC3: **AC-31**: Каждый известный дефект имеет исходное состояние и oracle; повтор ловит возврат; semantic judge не подменяет строгие checks и не запускается из core.
- AC4: **AC-32**: Batch и sequential эквивалентны; stale/expired/wrong-scope handle даёт typed error; независимые шаги продолжаются по политике; связанные writes только changeset.
- AC5: **AC-M05**: Короткий результат не обёрнут большим boilerplate; большой раскрывается без перечитывания; общий measured cost учитывает все ответы и вызовы.
- AC6: **AC-M06**: Public export audit всего выбранного diff/fixtures не содержит private names/paths/results; core dependencies не включают model runner; массового cherry-pick нет.
- AC7: **AC-M07**: Empty/corrupt graph, mismatched manifest/model/task/arm и reachable answer блокируют preflight; crash→resume→resume сохраняет один вес пары; orphan/duplicate не усредняются.
- AC8: **AC-M08**: Двойные нули остаются в primary; страты заданы до outcomes; report содержит recall/precision/F1/candidates/task success/latency/P50/P95 и uncertainty без заявления equivalence по failed threshold.
- AC9: **AC-M09**: Из synthetic events агрегаты воспроизводятся, missing не становится zero; bounded smoke только после guards; новая config аннулирует оценку; subscription не USD списание.
- AC10: **AC-W06**: Report различает absent page, retrieval miss, delivery и use; считает source correctness, task checks и maintenance; gold не попадает в wiki до задания.
- AC11: Current focused/type/build/health checks and independent review have explicit evidence; prerequisites are satisfied; no required failed/incomplete check is relabeled PASS; partial acceptance is not full phase completion.

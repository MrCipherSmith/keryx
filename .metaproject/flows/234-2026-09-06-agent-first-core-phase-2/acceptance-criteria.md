# Acceptance Criteria

- AC1: **AC-06**: Дата границы, future, deprecated, conflict, superseded и malformed имеют одинаковый допуск в wiki/memory; historical режим явно размечен.
- AC2: **AC-09**: Добавление/rename/delete теста и смена checkout отражены; обычный monorepo package не исключён; невозможность refresh возвращает incomplete, а не no-tests.
- AC3: **AC-10**: Новый commit, untracked, delete, rename и config инвалидируют snapshot; unknown target отличается от indexed/no edges; ошибка Git не становится fresh.
- AC4: **AC-11**: Type-only цикл не попадает в runtime список; mixed import с runtime-частью попадает; consumer типа виден в impact; цикл сам по себе не блокирует gate.
- AC5: **AC-13**: Без runtime/grammar работает file-level; requireSymbols даёт ошибку; incompatible grammar отличима от missing; fixture даёт реальные symbols после явной установки.
- AC6: **AC-25**: Search→compression→handoff сохраняет exact source fragment/version, author и confirming participant вместе с оговоркой об отсрочке; source unknown явно виден; высокая confidence не меняет hypothesis в decision/permission.
- AC7: Current focused/type/build/health checks and independent review have explicit evidence; prerequisites are satisfied; no required failed/incomplete check is relabeled PASS; partial acceptance is not full phase completion.

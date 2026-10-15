# Source journal 142cd74e

- Exported at (UTC): 2026-10-13T12:50:37.032Z.
- Source identifier: 142cd74e (first 8 hex characters of seed-file SHA-256; no hostname).
- Decisions: 26; previous export: 0; added: 26.
- First openedAt: 2026-10-07T19:35:29.206Z; last openedAt: 2026-10-13T12:42:23.760Z.
- Exporter version: 0.3.112; exporter HEAD: f0ad228a6e8eb93f62167a97152958f34e9805fd.
- Source HEAD: e77e72f4099203ab388f7ffd71e50ddbdfc2798a; source branch: feat/415-evidence-retrieval-layer.
- Writer versions are not recorded; exporter version is not writer attribution.
- Collection: current research-branch machineExport(sourceRoot), renderMachineRows, parseMachineRows; entire source journal, no date filter.
- Privacy: seed and question/option/reason text fields excluded; raw validation and path/email checks passed. No source journal or source code written.
- Source flow 415: local journal reports in-progress (P0 complete, P1 started); implementation has uncommitted changes. Flow 415 and 416 already exist in origin/main; no new flow branch published by this collection.
- Source branch was not switched or pulled; parallel ERL work was left untouched.

## Verification

- Latest export equals the ordered union of all raw exports: 258 decisions (142cd74e: 26, 1932608c: 134, fa7c0ca1: 98), without duplicate (host, seq) pairs.
- Raw validation and path/email checks passed; research sync completed successfully.
- `bun test --timeout 30000 src/decisions/machine-export.test.ts src/commands/research-sync.test.ts`: 41 passed, 0 failed. `git diff --check`: passed.

## Финальная выгрузка 2026-10-15 06:08 UTC

- Машина 2; роль копии: параллельная.
- Строк: 44; предыдущая выгрузка: 26; добавлено: 18.
- Первая `openedAt`: `2026-10-07T19:35:29.206Z`; последняя: `2026-10-14T21:23:20.391Z`.
- Живых решений после 2026-10-04 15:26 UTC: 44; eligible: 17; forced: 27; плечи A–D у eligible: {"A": 8, "B": 3, "C": 2, "D": 4}.
- Версия экспортера keryx: `0.3.117`; HEAD исследовательской ветки: `c578a312096860a420f9eda2fafb2acde2809d8f`.
- Ветка источника: `feat/415-evidence-retrieval-layer`; HEAD источника: `e77e72f4099203ab388f7ffd71e50ddbdfc2798a`.
- Проверки шага 4: 41 тест пройден, 0 ошибок (таймаут 30000 мс); объединение 330 строк равно всем raw; дубли `(host, seq)` и `(ref, openedAt)` отсутствуют; запрещённые текстовые поля, seed, пути, email и локальное имя пользователя отсутствуют. Исторические снимки и flow этим сбором не изменены.
- Flow 352: локально implemented, в main in-progress; отдельная ветка по номеру не найдена. По решению оператора расхождение только зафиксировано, ветка не создаётся.
- Это не последний запуск: PR не открывается. Семь источников других репозиториев исключены по решению оператора.

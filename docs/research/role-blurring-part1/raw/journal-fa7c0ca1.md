# Machine journal fa7c0ca1

- host: fa7c0ca1 (first 8 hex characters of seed-file SHA-256; no hostname).
- seedHash: fa7c0ca1378fb500bc9b5fccb9e1cd42543d09b93057ca3b43a14a2bba6ed634
- Exported decisions: 28; raw journal records: 56.
- First openedAt: 2026-10-05T05:59:32.787Z; last openedAt: 2026-10-05T22:19:01.824Z.
- Backfilled decisions: 0 (retained, outside confirmatory sample).
- Exporter version: 0.3.77; HEAD: 51ea30a1790299077181490842a4387b4a0fcaf1.
- Writer versions recorded in journal: not recorded; cannot reliably attribute git history to this machine.
- Export summary: 28 rows, 0 skipped, 0 invalid fields blanked.
- Entire local journal exported without a since filter; original open seq and arm retained. Numeric seed field removed to satisfy AC2; seed file only hashed, never exported.
- Privacy verification: export allow-list checked; seed, question/option/reason text fields absent; local username and paths absent.
- This machine is not the final collector. No merged/latest/snapshot/status files changed.
- Collection agent: Keryx agent (openai-codex/gpt-6.1-sol). This identifies the export agent, not the writers of the recorded decisions.

## Export command

Run from the repository root with Bun. The command used readJournal + readQuality + buildExportWithSummary with no date filter, joined each row to its original open by exportRef(id), removed seed, and added seq, host and SHA-256 of the existing saltFile. No salt was generated or migrated.

Equivalent reproducible export command (the local journal may grow after this capture):

```sh
bun --eval '
import {createHash} from "node:crypto";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {saltFile} from "./src/decisions/arms.ts";
import {readJournal} from "./src/decisions/store.ts";
import {readQuality} from "./src/decisions/quality.ts";
import {buildExportWithSummary,exportRef} from "./src/decisions/export.ts";
const cwd=process.cwd();
const seedHash=createHash("sha256").update(await readFile(await saltFile(cwd))).digest("hex");
const host=seedHash.slice(0,8);
const journal=await readJournal(cwd);
const {rows,summary}=buildExportWithSummary(journal.records,await readQuality(cwd));
if(journal.skipped||summary.skipped) throw Error("Skipped records; stop");
const opens=new Map(journal.records.filter(r=>r.kind==="open").map(r=>[exportRef(r.id),r]));
const out=rows.map(({seed,...row})=>({...row,seq:opens.get(row.ref).seq,host,seedHash}));
if(out.some(r=>!Number.isSafeInteger(r.seq))||new Set(out.map(r=>r.seq)).size!==out.length) throw Error("Invalid or duplicate seq");
const dir="docs/research/role-blurring-part1/raw";
await mkdir(dir,{recursive:true});
await writeFile(`${dir}/decisions-${host}.jsonl`,out.map(r=>JSON.stringify(r)).join("\n")+"\n");
'
```

Writer-version attribution remains unknown: journal records do not contain it, and git history alone does not identify which machine wrote a decision. The exporter version above is not a claim about writer versions.

## Verification

- `bun test src/decisions/export.test.ts`: 24 passed, 0 failed.
- Both new files checked for local username, home/repository paths and email-shaped strings: no matches. JSONL checked for prohibited text keys and seed, required host/seedHash, and unique `(host, seq)`: passed (28 decisions).
- Preservation checks covered 37 pre-existing uncommitted files. All original bytes remain intact; the security audit log received appended events only. No pre-existing changes are included in the export commit.

## Выгрузка 2026-10-13 11:51 UTC

- Машина: `fa7c0ca1`.
- Строк: 98; предыдущая выгрузка: 28; добавлено: 70.
- Первая `openedAt`: `2026-10-05T05:59:32.787Z`; последняя: `2026-10-13T11:44:17.266Z`.
- Версия экспортера keryx: `0.3.112`; HEAD: `9449cd8cc9ffaad887b2844220b98a1b11ea5e95`. Версия записи отдельных решений неизвестна.
- Команда: `bun run keryx research sync`; весь локальный журнал, без фильтра по дате.
- Приватность: запрещённые текстовые поля и seed отсутствуют; проверка локальных идентификаторов, путей и email пройдена. Экспорт другой машины не изменён.
- Независимая проверка: latest равен объединению raw, 232 строки; дубли `(host, seq)` отсутствуют.
- Тесты: `bun test --timeout 30000 src/decisions/machine-export.test.ts src/commands/research-sync.test.ts` — 41 passed, 0 failed. При первом запуске два теста расписания превысили стандартный таймаут 5 секунд; повтор с 30 секундами прошёл без изменения кода.
- Flow вне main: локальный untracked экземпляр 387, статус `in-progress`. Коммиты веток `chore/flow-387-complete`, `fix/387-review-r1`, `fix/387-review-r3` уже опубликованы и входят в `origin/main`; дополнительная публикация не нужна, новая ветка не создана.
- Flow 415 и 416 уже присутствуют в main. Старый untracked экземпляр 415 сохранён отдельно до слияния main в исследовательскую ветку.
- Исторические снимки не изменены. Единственная tracked-разница файлов flow с main — ранее существовавшие локальные добавления в журнал 406; они сохранены и не включены в исследовательский коммит.

## Финальная выгрузка 2026-10-15 06:08 UTC

- Машина 2; роль копии: основная.
- Строк: 116; предыдущая выгрузка: 98; добавлено: 18.
- Первая `openedAt`: `2026-10-05T05:59:32.787Z`; последняя: `2026-10-14T21:59:57.213Z`.
- Живых решений после 2026-10-04 15:26 UTC: 116; eligible: 44; forced: 72; плечи A–D у eligible: {"A": 19, "B": 9, "C": 6, "D": 10}.
- Версия экспортера keryx: `0.3.117`; HEAD исследовательской ветки: `c578a312096860a420f9eda2fafb2acde2809d8f`.
- Ветка источника: `main`; HEAD источника: `8d47da62d83253073793f3fe64e8f2def50f178b`.
- Проверки шага 4: 41 тест пройден, 0 ошибок (таймаут 30000 мс); объединение 330 строк равно всем raw; дубли `(host, seq)` и `(ref, openedAt)` отсутствуют; запрещённые текстовые поля, seed, пути, email и локальное имя пользователя отсутствуют. Исторические снимки и flow этим сбором не изменены.
- Flow 352: локально implemented, в main in-progress; отдельная ветка по номеру не найдена. По решению оператора расхождение только зафиксировано, ветка не создаётся.
- Flow 387: локально in-progress, в main ready; ветки `chore/flow-387-complete`, `fix/387-review-r1`, `fix/387-review-r3` входят в main. Первая опубликована, две remote-ветки удалены после слияния; по решению оператора не восстанавливаются.
- Это не последний запуск: PR не открывается. Семь источников других репозиториев исключены по решению оператора.

# Machine journal 1932608c

- host: 1932608c (first 8 hex characters of seed-file SHA-256; no hostname).
- seedHash: 1932608cb0d0fb0a6a5bb3eee82887f3c16f7f6ddc4662b2dd3705480381f338
- Exported decisions: 122; raw journal records: 236.
- First openedAt: 2026-08-07T09:56:21.008Z (a backfilled decision); last openedAt: 2026-10-05T19:26:36.567Z.
- Live (non-backfilled) decisions: 49, from 2026-10-02T15:03:59.507Z to 2026-10-05T19:26:36.567Z. Backfilled decisions: 73 (retained with `backfilled: true`, outside the confirmatory sample by protocol).
- Arms as recorded: A 111, D 11. Rows before flow 400 (120 of 122) carry `legacy: true`; their arm comes from the old mode (ordinary = A, blind = D), not from `(seed, seq)`.
- Exporter version: 0.3.77 (origin/main 6f6d8898 plus the branch commit of host fa7c0ca1).
- Writer versions recorded in journal: not recorded. The only anchor in git is the package version on main: 0.3.62 on 2026-10-02 and 0.3.77 on 2026-10-05. This machine is the one the operator develops keryx on, so decisions of those days were written under versions between them; the record itself does not say which.
- Export summary: 122 rows, 0 skipped, 0 invalid fields blanked.

## Deviation from the request: `seq` is derived for 120 rows

The request says each machine's `seq` starts from 0 and is kept as it was. On this machine only the 2 newest decisions carry a `seq` field (121 and 122). The 120 older ones were written before flow 400 and have none.

In the code the journal assigns `seq` as the number of `open` records already in the journal plus one (`src/decisions/journal.ts`), so the position is recoverable exactly: it is the 1-based order of the `open` records in the journal file. The two rows that do carry `seq` agree with that order (checked: every explicit `seq` equals its ordinal). The export therefore writes `seq` = that ordinal for the 120 older rows and marks them `seqDerived: true`. The numbering starts at 1, not 0, on both machines.

What this does not change: the arm of an older row is not recomputed, and it was never a function of `seq` (it came from the mode). `seqDerived` rows cannot be used to replay the arm assignment; the 2 rows with an explicit `seq` can.

## Export command

Run from the repository root with Bun. The command is the one used on host fa7c0ca1 (readJournal + readQuality + buildExportWithSummary, no date filter, every row joined to its original open by `exportRef(id)`, `seed` removed, `host` and `seedHash` added from the SHA-256 of the existing seed file), with one change: `seq` is taken from the open record when it has one and otherwise from its ordinal, and the latter rows get `seqDerived: true`. No seed was generated, migrated or printed.

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
const openList=journal.records.filter(r=>r.kind==="open");
const ordinal=new Map(openList.map((r,i)=>[exportRef(r.id),i+1]));
const opens=new Map(openList.map(r=>[exportRef(r.id),r]));
const out=rows.map(({seed,...row})=>{const o=opens.get(row.ref);const has=Number.isSafeInteger(o.seq);return {...row,seq:has?o.seq:ordinal.get(row.ref),...(has?{}:{seqDerived:true}),host,seedHash};});
if(out.some(r=>!Number.isSafeInteger(r.seq))||new Set(out.map(r=>r.seq)).size!==out.length) throw Error("Invalid or duplicate seq");
const dir="docs/research/role-blurring-part1/raw";
await mkdir(dir,{recursive:true});
await writeFile(`${dir}/decisions-${host}.jsonl`,out.map(r=>JSON.stringify(r)).join("\n")+"\n");
'
```

After the sync change of this branch, `keryx research sync` writes this file itself.

## Verification

- Row fields checked against the allow-list of host fa7c0ca1 plus `seqDerived`: no other keys; no `seed`; `host` and `seedHash` present on every row; `(host, seq)` unique (122 of 122).
- Scan for the local username, home-directory path prefixes, e-mail markers, the team-repository words of flow 404 and the text-bearing keys (question, options, reason, text): 0 matches.
- Collection agent: Keryx agent. It identifies the export agent, not the writers of the recorded decisions.

## Выгрузка 2026-10-12 19:44 UTC

- Машина: `1932608c`.
- Строк: 134; предыдущая выгрузка: 122; добавлено: 12.
- Первая `openedAt`: `2026-08-07T09:56:21.008Z`.
- Последняя `openedAt`: `2026-10-11T15:40:12.065Z`.
- Версия экспортера keryx: `0.3.112`; HEAD: `844afa2d101810806ed17938a79a3cc95fb64ccd`. Версия записи отдельных решений неизвестна.
- Приватность: проверки запрещённых текстовых полей и seed, локальных идентификаторов и путей пройдены; 46 тестов пройдены.
- Независимая проверка: объединение всех raw равно latest; 162 строк, дубли `(host, seq)` отсутствуют.
- Исторические снимки и файлы flow совпадают с main и не изменены выгрузкой.
- Flow вне main: отсутствуют; номера 415 и 416 уже присутствуют в main. Их ветки проверены отдельно; слияние в main в этой задаче не выполнялось.
- Вторая машина: `fa7c0ca1`, 28 строк, последняя `openedAt` `2026-10-05T22:19:01.824Z`; требуется новая выгрузка. Итоговый PR не открыт.

## Выгрузка 2026-10-13 21:37 UTC

- Машина: `1932608c`.
- Строк: 134; предыдущая выгрузка: 134; добавлено: 0.
- Первая `openedAt`: `2026-08-07T09:56:21.008Z`.
- Последняя `openedAt`: `2026-10-11T15:40:12.065Z`.
- Версия экспортера keryx: `0.3.112`; HEAD: `ee6cbd44c1b54ad98bd1b26206f79bd0260a38c5`. Версия записи отдельных решений неизвестна.
- Приватность: проверки запрещённых текстовых полей и seed, локальных идентификаторов и путей пройдены; 46 тестов пройдены.
- Независимая проверка: объединение всех raw равно latest; 258 строк, дубли `(host, seq)` отсутствуют.
- Исторические снимки и файлы flow совпадают с main и не изменены выгрузкой.
- Flow вне main: отсутствуют; номера 415 и 416 присутствуют в main. Слияние в main в этой задаче не выполнялось.
- Источники объединения: `142cd74e` — 26 строк, `1932608c` — 134 строк, `fa7c0ca1` — 98 строк. Итоговый PR не открыт.

## Финальная выгрузка 2026-10-14 20:05 UTC

- Машина 1; роль копии: основная; источник: `1932608c`.
- Строк: 135; предыдущая выгрузка: 134; добавлено: 1.
- Первая `openedAt`: `2026-08-07T09:56:21.008Z`; последняя: `2026-10-14T19:54:37.774Z`.
- Живых решений после 2026-10-04 15:26 UTC: 15; eligible: 12; forced: 3; плечи eligible: A: 8, B: 3, C: 1, D: 0.
- Keryx: `0.3.116`; HEAD копии исследования: `ee443509a6c6f4cc4f7303cca4cae0a7fb73ae95`; ветка: `research/part2-data`.
- Ветка источника: `main`; HEAD источника: `47be31215799bc37034c1fc1e94a3b7758dbf58e`.
- Проверки шага 4: 41 тест пройден; объединение 294 строк равно всем raw, без дублей `(host, seq)` и повторных решений `(ref, openedAt)`; запрещённые поля и локальные идентификаторы не обнаружены. Исторические снимки и flow сбором не изменены.

### Flow вне main

- Flow 261: `in-progress`; в origin/main: `done`. `backup/flow261-real-rounds-8437ecd5`: запушена, не слита; `chore/flow-261-complete`: запушена, слита.
- Flow 376: `in-progress`; в origin/main: `done`. `chore/flow-376-complete`: запушена, слита; `chore/flow-376-followups`: запушена, слита.
- Flow 388: `ready`; в origin/main: `done`. `chore/flow-388-complete`: запушена, слита.
- Flow 389: `ready`; в origin/main: `implemented`. `chore/flow-389-close`: запушена, слита; `fix/review-findings-389`: запушена, слита.
- Flow 415: `initializing`; в origin/main: `отсутствует`. Ветка не найдена; по решению оператора ничего не создавать и оставить flow без изменений.
- Flow 416: `implemented`; в origin/main: `отсутствует`. `chore/flow-416-complete`: запушена, не слита; `feat/flow-416-import-templates`: запушена, слита; `fix/flow-416-import-templates-hardening`: запушена, слита.
- Flow 417: `implemented`; в origin/main: `done`. `chore/flows-417-418-complete`: запушена, слита; `chore/flows-complete-417-418-419-427`: запушена, слита; `feat/flow-417-review-orchestrator-inline`: запушена, слита.
- Flow 418: `implemented`; в origin/main: `done`. `chore/flows-417-418-complete`: запушена, слита; `chore/flows-complete-417-418-419-427`: запушена, слита; `feat/flow-418-shell-review`: запушена, слита.
- Flow 419: `in-progress`; в origin/main: `implemented`. `chore/flows-complete-417-418-419-427`: запушена, слита.
- Flow 446: `implemented`; в origin/main: `in-progress`. `feat/review-parity`: запушена, слита.

Публикация веток подтверждена совпадением local HEAD с remote-tracking ref. Свежая сетевая сверка всех refs прервана по тайм-ауту; резервная ветка flow 261 опубликована отдельным push в этом запуске. Рабочие копии источников не изменены.

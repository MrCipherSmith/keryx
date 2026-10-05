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
- Scan for the local username, `/home/`, `@`, the team-repository words of flow 404 and the question, option, reason and text keys: 0 matches.
- Collection agent: Keryx agent. It identifies the export agent, not the writers of the recorded decisions.

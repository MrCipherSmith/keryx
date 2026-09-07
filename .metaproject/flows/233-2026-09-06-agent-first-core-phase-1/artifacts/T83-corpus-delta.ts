// T83 — name the corpus delta by ENUMERATION, not by narrative (T78#F-003).
// Every file this task wrote into the raw log directory is run through the
// detector; the ones carrying findings are the whole of the delta or the
// explanation is wrong.
//
// Read-only, offline. Usage: bun T83-corpus-delta.ts
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { detectExfil } from "../../../../src/security/detect/exfil";

const RAW = path.join(process.cwd(), ".metaproject/data/gdctx/raw");
const rows: Array<{ file: string; findings: number; policies: string[] }> = [];
let scanned = 0;
for (const name of await readdir(RAW)) {
  if (!name.startsWith("T83-")) continue;
  const full = path.join(RAW, name);
  if (!(await stat(full)).isFile()) continue;
  scanned += 1;
  const matches = detectExfil(await readFile(full, "utf8"), []);
  if (matches.length === 0) continue;
  rows.push({
    file: name,
    findings: matches.length,
    policies: [...new Set(matches.map((m) => m.policyId))].sort(),
  });
}
console.log(
  JSON.stringify(
    {
      probe: "T83-corpus-delta",
      t83FilesScanned: scanned,
      t83FilesWithFindings: rows.length,
      t83Findings: rows.reduce((sum, r) => sum + r.findings, 0),
      rows: rows.sort((a, b) => a.file.localeCompare(b.file)),
    },
    null,
    2,
  ),
);

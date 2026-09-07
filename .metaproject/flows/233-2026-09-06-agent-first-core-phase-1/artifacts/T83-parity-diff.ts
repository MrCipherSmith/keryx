// T83 — diff the two `T83-parity` logs. A finding present BEFORE and absent
// AFTER is a RELEASE and there must be none; every finding present AFTER only
// must come from a document containing a backslash-escaped `]`.
//
// Usage: bun T83-parity-diff.ts
type Row = { at: number; findings: string[] };
const R = ".metaproject/data/gdctx/raw";
const before = (await Bun.file(`${R}/T83-before-parity.log`).json()) as {
  documents: number;
  rows: Row[];
};
const after = (await Bun.file(`${R}/T83-after-parity.log`).json()) as typeof before;

const index = (rows: Row[]) => new Map(rows.map((r) => [r.at, r.findings]));
const b = index(before.rows);
const a = index(after.rows);

const lost: Array<{ at: number; findings: string[] }> = [];
const gained: Array<{ at: number; findings: string[] }> = [];
for (const at of new Set([...b.keys(), ...a.keys()])) {
  const bs = new Set(b.get(at) ?? []);
  const as = new Set(a.get(at) ?? []);
  const missing = [...bs].filter((f) => !as.has(f));
  const extra = [...as].filter((f) => !bs.has(f));
  if (missing.length) lost.push({ at, findings: missing });
  if (extra.length) gained.push({ at, findings: extra });
}

console.log(
  JSON.stringify(
    {
      probe: "T83-parity-diff",
      documents: before.documents,
      beforeFindings: before.rows.reduce((s, r) => s + r.findings.length, 0),
      afterFindings: after.rows.reduce((s, r) => s + r.findings.length, 0),
      releases: lost.length,
      releasedRows: lost.slice(0, 40),
      additions: gained.length,
      addedFindings: gained.reduce((s, r) => s + r.findings.length, 0),
      sampleAdditions: gained.slice(0, 10),
    },
    null,
    2,
  ),
);

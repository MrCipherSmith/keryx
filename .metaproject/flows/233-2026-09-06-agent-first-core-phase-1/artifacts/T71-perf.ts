// T71 — the bracket walk is O(n) per opening bracket in its worst case (a run of
// `[` with no `]`), which is the same worst case the `[^\]]*` it replaces already
// had at each start position. Asserted in the spec; measured here, before it is
// claimed. Includes the shapes T46 measured for the HTML half, so the two
// numbers are comparable.
//
// Read-only, offline, synthetic hosts only.
// Usage: bun T71-perf.ts
import { detectExfil } from "../../../../src/security/detect/exfil";

const U = "https://cdn.example.org/a.png";

const shapes: Array<{ id: string; build: () => string }> = [
  { id: "benignProse", build: () => "Lorem ipsum dolor sit amet. ".repeat(40_000) },
  {
    id: "inlineImages20k",
    build: () => `![alt](${U})\n`.repeat(20_000),
  },
  {
    id: "shortcutRefs20k",
    build: () => `![a]\n`.repeat(20_000) + `\n[a]: ${U}\n`,
  },
  {
    id: "nestedDescriptions10k",
    build: () => `![a[b[c]d]e](${U})\n`.repeat(10_000),
  },
  {
    id: "openBracketRun200k",
    build: () => "[".repeat(200_000),
  },
  {
    id: "openBracketRunThenClose",
    build: () => "[".repeat(100_000) + "]".repeat(100_000),
  },
  {
    id: "bangBracketRun100k",
    build: () => "![".repeat(100_000),
  },
  {
    id: "tableRows20k",
    build: () => `<td background="${U}">x</td>`.repeat(20_000),
  },
];

const rows: Array<{ id: string; bytes: number; ms: number; findings: number }> = [];
for (const shape of shapes) {
  const content = shape.build();
  const started = Bun.nanoseconds();
  const findings = detectExfil(content, []);
  const ms = (Bun.nanoseconds() - started) / 1e6;
  rows.push({ id: shape.id, bytes: content.length, ms: Number(ms.toFixed(1)), findings: findings.length });
}

for (const r of rows) {
  console.log(
    `${r.id.padEnd(24)} bytes=${String(r.bytes).padStart(8)}  findings=${String(r.findings).padStart(6)}  ${r.ms.toFixed(1)} ms`,
  );
}
console.log(JSON.stringify({ shapes: rows.length, slowestMs: Math.max(...rows.map((r) => r.ms)) }, null, 2));

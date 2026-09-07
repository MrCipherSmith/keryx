// T72 — the performance claim, treated as a security property.
//
// A performance cliff inside a MANDATORY floor is a denial-of-service surface:
// the floor runs on every tool/resource payload, and an attacker chooses the
// payload. Two questions:
//   1. Do T71's own numbers reproduce (the 200 000-`[` run at ~37 ms, and the
//      old two patterns' ~42 s on the same input)?
//   2. Are there OTHER inputs that are pathological on the SHIPPED code? The
//      scan is answered by scaling each shape and reporting the growth exponent
//      (log2 of the time ratio per doubling): ~1 is linear, ~2 is quadratic.
//
// Sizes are scaled up only while the previous size stayed under a budget, so the
// probe cannot itself hang.
// Read-only, offline, synthetic hosts only.
// Usage: bun T72-perf.ts [out.json]
import { detectExfil } from "../../../../src/security/detect/exfil";

const U = "https://attacker.invalid/p";
const BUDGET_MS = 8000;

// the two patterns T71 replaced, for the "faster than what it replaced" claim
const OLD_INLINE = /(!?)\[[^\]]*\]\(\s*(?:<([^<>\n]*)>|([^)\s]+))[^)]*\)/g;
const OLD_REFERENCE_USE = /(!?)\[[^\]]*\]\[([^\]]+)\]/g;
function oldPatterns(text: string): number {
  let n = 0;
  OLD_INLINE.lastIndex = 0;
  while (OLD_INLINE.exec(text) !== null) n += 1;
  OLD_REFERENCE_USE.lastIndex = 0;
  while (OLD_REFERENCE_USE.exec(text) !== null) n += 1;
  return n;
}

const shapes: Record<string, (n: number) => string> = {
  openBracketRun: (n) => "[".repeat(n),
  closeBracketRun: (n) => "]".repeat(n),
  balancedNest: (n) => "[".repeat(n) + "]".repeat(n),
  altPairs: (n) => "[]".repeat(n),
  imagePairs: (n) => `![a](${U})`.repeat(Math.max(1, Math.floor(n / 30))),
  bangBracketRun: (n) => "![".repeat(n),
  // the one the repair did NOT touch: INLINE_DESTINATION's `[^)\s]+[^)]*\)`
  // on an unterminated inline destination.
  unterminatedDestination: (n) => "![a](" + "A".repeat(n),
  unterminatedDestinationAngle: (n) => "![a](<" + "A".repeat(n),
  // and the same shape reached through a run of opens, so both halves are live
  openRunThenUnterminated: (n) => "[".repeat(Math.floor(n / 2)) + "![a](" + "A".repeat(Math.floor(n / 2)),
  longLabelUse: (n) => `![a][${"L".repeat(n)}]\n\n[${"L".repeat(n)}]: ${U}\n`,
  refDefRun: (n) => `[a]: ${U}\n`.repeat(Math.max(1, Math.floor(n / 30))),
  htmlTagRun: (n) => `<img alt="x" `.repeat(Math.max(1, Math.floor(n / 13))),
};

type Row = {
  id: string;
  sizes: { n: number; bytes: number; ms: number }[];
  exponent: number | null;
  worstMs: number;
  note: string;
};

const rows: Row[] = [];
for (const [id, build] of Object.entries(shapes)) {
  const sizes: { n: number; bytes: number; ms: number }[] = [];
  for (const n of [12500, 25000, 50000, 100000, 200000]) {
    const text = build(n);
    const t0 = performance.now();
    detectExfil(text, []);
    const ms = performance.now() - t0;
    sizes.push({ n, bytes: text.length, ms: Math.round(ms * 10) / 10 });
    if (ms > BUDGET_MS) break;
  }
  // growth exponent from the last two measured sizes
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
    `${r.id.padEnd(28)} worst=${String(r.worstMs).padStart(10)} ms exponent=${String(r.exponent).padStart(6)} sizes=${JSON.stringify(r.sizes)} ${r.note}`,
  );
}

// --- T71's own two headline numbers, re-measured ---------------------------
const run200k = "[".repeat(200000);
let t0 = performance.now();
detectExfil(run200k, []);
const shippedMs = Math.round((performance.now() - t0) * 10) / 10;
t0 = performance.now();
oldPatterns(run200k);
const oldMs = Math.round((performance.now() - t0) * 10) / 10;

// the shape T71 did NOT measure, on the shipped code vs the old patterns
const unterm = "![a](" + "A".repeat(60000);
t0 = performance.now();
detectExfil(unterm, []);
const untermShippedMs = Math.round((performance.now() - t0) * 10) / 10;
t0 = performance.now();
oldPatterns(unterm);
const untermOldMs = Math.round((performance.now() - t0) * 10) / 10;

const summary = {
  t71Claim_openBracketRun200k_shippedMs: shippedMs,
  t71Claim_openBracketRun200k_oldPatternsMs: oldMs,
  shippedFasterThanReplaced_onThatShape: shippedMs < oldMs,
  unterminatedDestination60k_shippedMs: untermShippedMs,
  unterminatedDestination60k_oldPatternsMs: untermOldMs,
  superLinearShapes: rows
    .filter((r) => (r.exponent ?? 0) > 1.5)
    .map((r) => `${r.id}(exp=${r.exponent}, worst=${r.worstMs}ms)`),
  shapesOverOneSecond: rows.filter((r) => r.worstMs > 1000).map((r) => `${r.id}=${r.worstMs}ms`),
};
console.log(JSON.stringify(summary, null, 2));

const dest = process.argv[2];
if (dest) await Bun.write(dest, JSON.stringify({ summary, rows }, null, 2));

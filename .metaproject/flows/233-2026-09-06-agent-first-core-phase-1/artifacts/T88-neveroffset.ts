// T88 — independent attack on the disjointness argument T85-spec.md makes for
// readDefinitionDestination's memoisation: "whitespace runs at distinct marker
// offsets cannot overlap, so total work is bounded by content length."
//
// A cache only helps when the SAME offset is asked more than once. This probe
// builds shapes engineered to visit a DISTINCT `afterColon` offset on every
// line start -- the shape a cache cannot collapse at all -- and checks whether
// cost still grows linearly (it must, per the disjointness argument, which
// does not depend on the cache) rather than quadratically (which is what an
// implementer who mistook "I added a cache" for "I fixed the asymptotics"
// would ship without noticing, since a memo alone does not fix a shape that
// never repeats a key).
//
// Independent of the test suite's own `destFailManyDistinctOffsets` /
// `destFailDistinctGrowingRuns` -- built from scratch for this review rather
// than reusing those two shapes, on different constructions, to avoid a
// blind spot the original two might share.
//
// Read-only, offline. Run: bun T88-neveroffset.ts
import { detectExfil } from "../../../../src/security/detect/exfil";

function best3(fn: () => void): number {
  const times: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  return Math.min(...times);
}

// Shape 1: every line start has a DIFFERENT number of trailing spaces after
// its own distinct `]:` -- offsets never repeat, and neither does the
// whitespace-run length, so a length-keyed or offset-keyed cache is equally
// useless here.
function buildGrowingDistinct(lines: number): string {
  let out = "";
  for (let i = 0; i < lines; i += 1) {
    out += `[a${i}]:` + " ".repeat(3);
  }
  return out;
}

// Shape 2: one `]:` per line, each followed by a SHORT failing whitespace
// tail (not to end-of-input, but up to the next line's own `[`), so the
// "run to end of input" special case doesn't carry the argument alone --
// every one of these destination reads fails at a DISTINCT offset, bounded by
// a few characters of lookahead, not by remaining document length.
function buildManyShortDistinctFails(lines: number): string {
  let out = "";
  for (let i = 0; i < lines; i += 1) {
    out += `[b${i}]:   \n`; // three spaces then newline: \s* crosses the
    // newline too (it is in \s), so this still fails to match a destination
    // (nothing non-whitespace before the next `[`), at a distinct offset.
  }
  return out;
}

// Shape 3: distinct offsets AND distinct, monotonically GROWING whitespace
// runs -- if the cache were doing the work instead of disjointness, this is
// the shape most likely to reveal it, because total whitespace scanned grows
// like the label side's own worst case.
function buildGrowingRunsDistinct(lines: number, growBy: number): string {
  let out = "";
  for (let i = 0; i < lines; i += 1) {
    out += `[c${i}]:` + " ".repeat(1 + i * growBy);
  }
  return out;
}

const BUDGET_MS = 1000;
const sizes = [50_000, 200_000, 500_000, 1_000_000];
const rows: Array<Record<string, unknown>> = [];

for (const n of sizes) {
  const lines = Math.floor(n / 12);
  const shapes: Record<string, string> = {
    growingDistinct: buildGrowingDistinct(lines),
    manyShortDistinctFails: buildManyShortDistinctFails(lines),
    growingRunsDistinct: buildGrowingRunsDistinct(Math.floor(Math.sqrt(lines)), 4),
  };
  for (const [id, text] of Object.entries(shapes)) {
    const ms = best3(() => detectExfil(text, []));
    rows.push({ id, targetBytes: n, actualBytes: text.length, ms: Number(ms.toFixed(2)) });
  }
}

// crude exponent estimate per shape, between smallest and largest measured
// point of comparable construction (same `id`)
const byId = new Map<string, Array<{ bytes: number; ms: number }>>();
for (const r of rows) {
  const id = r.id as string;
  const list = byId.get(id) ?? [];
  list.push({ bytes: r.actualBytes as number, ms: r.ms as number });
  byId.set(id, list);
}
const exponents: Record<string, number> = {};
for (const [id, pts] of byId) {
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const a = Math.max(first.ms, 0.001);
  const b = Math.max(last.ms, 0.001);
  exponents[id] = Number(
    (Math.log(b / a) / Math.log(last.bytes / first.bytes)).toFixed(2),
  );
}

const overBudget = rows.filter((r) => (r.ms as number) >= BUDGET_MS);

console.log(
  JSON.stringify(
    {
      probe: "T88-neveroffset",
      rows,
      exponents,
      overBudget,
      verdict: overBudget.length === 0 ? "LINEAR-OR-BETTER" : "SUPERLINEAR-DETECTED",
    },
    null,
    2,
  ),
);

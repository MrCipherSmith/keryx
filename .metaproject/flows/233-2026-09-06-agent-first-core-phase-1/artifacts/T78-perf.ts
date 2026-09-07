// T78 — independent performance probe on the shipped auto-fetch floor.
//
// Hypothesis under test: T77 replaced MAX_REFERENCE_LABEL with a budget derived
// from the document's OWN reference definitions (`nonWhitespaceCount(span) <=
// maxKeyLength`). That makes the cost of the label path a function of an
// attacker-chosen constant. Every perf shape T72 and T77 measured with a bracket
// run carried NO reference definition, so `budget.maxLength === 0` short-circuited
// `readBracketConstructs` before it sliced anything. Add one long definition and
// the short-circuit is gone.
//
// Synthetic/reserved hosts only. No network.
import { detectExfil } from "../../../../src/security/detect/exfil";

function timed(content: string): number {
  const t0 = performance.now();
  detectExfil(content);
  return performance.now() - t0;
}

type Shape = { name: string; build: (n: number) => string; sizes: number[] };

const DEF_LONG = (len: number) =>
  `[${"a".repeat(len)}]: https://ok.example.org/x\n`;

const shapes: Shape[] = [
  // CONTROL: exactly T77's `balancedNest`, no definition -> maxLength 0.
  {
    name: "balancedNest_noDef",
    build: (n) => "[".repeat(n) + "]".repeat(n),
    sizes: [12500, 25000, 50000, 100000],
  },
  // THE SHAPE: same bytes plus ONE long reference definition.
  {
    name: "balancedNest_withLongDef",
    build: (n) => DEF_LONG(200000) + "[".repeat(n) + "]".repeat(n),
    sizes: [12500, 25000, 50000, 100000],
  },
  // A run of opens sharing ONE close: every open's label span is O(n).
  {
    name: "openRunOneClose_noDef",
    build: (n) => "[".repeat(n) + "]",
    sizes: [12500, 25000, 50000, 100000],
  },
  {
    name: "openRunOneClose_withLongDef",
    build: (n) => DEF_LONG(200000) + "[".repeat(n) + "]",
    sizes: [12500, 25000, 50000, 100000],
  },
  // Same, but every open is an IMAGE open, so the reference pass also runs its
  // refs.get() per construct.
  {
    name: "bangOpenRunOneClose_withLongDef",
    build: (n) => DEF_LONG(200000) + "![".repeat(n) + "]",
    sizes: [6250, 12500, 25000, 50000],
  },
  // Whitespace-inflated spans: the budget counts NON-whitespace, so a span may be
  // far longer than the budget and still pass.
  {
    name: "whitespaceInflatedRun_withDef",
    build: (n) => DEF_LONG(64) + "[ ".repeat(n) + "]",
    sizes: [12500, 25000, 50000, 100000],
  },
  // Does a SHORT definition still admit long spans? budget = 4 here.
  {
    name: "openRunOneClose_shortDef",
    build: (n) => "[abcd]: https://ok.example.org/x\n" + "[".repeat(n) + "]",
    sizes: [12500, 25000, 50000, 100000],
  },
];

const rows: Array<Record<string, unknown>> = [];
for (const shape of shapes) {
  const measured: Array<{ n: number; bytes: number; ms: number }> = [];
  for (const n of shape.sizes) {
    const content = shape.build(n);
    const ms = timed(content);
    measured.push({ n, bytes: content.length, ms: Number(ms.toFixed(1)) });
    if (ms > 120000) break; // stop climbing a ladder that already failed
  }
  const last = measured[measured.length - 1];
  const prev = measured[measured.length - 2];
  const exponent =
    prev && last && prev.ms > 0.5
      ? Number((Math.log(last.ms / prev.ms) / Math.log(last.n / prev.n)).toFixed(2))
      : null;
  rows.push({ shape: shape.name, measured, exponent });
}

const over1s = rows.filter((r) =>
  (r.measured as Array<{ ms: number }>).some((m) => m.ms > 1000),
);
const superLinear = rows.filter(
  (r) => typeof r.exponent === "number" && (r.exponent as number) > 1.5,
);

console.log(
  JSON.stringify(
    {
      probe: "T78-perf",
      rows,
      shapesOverOneSecond: over1s.map((r) => r.shape),
      superLinearShapes: superLinear.map((r) => ({
        shape: r.shape,
        exponent: r.exponent,
      })),
    },
    null,
    2,
  ),
);

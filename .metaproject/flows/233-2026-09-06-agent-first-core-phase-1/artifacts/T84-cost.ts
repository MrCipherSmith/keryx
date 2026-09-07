// T84 — item 2, the empirical half: attack the new definition scanner's cost at
// the four public boundaries, up to and past a megabyte.
//
// The shapes are chosen against the MECHANISM, not against the old pattern:
//
//   * `destFailWhitespaceTail` — every line-start `[` shares ONE `]` whose `:`
//     is followed by whitespace to end of input. `readDefinitionDestination` is
//     therefore called once per line start, its `\s*(?:<…>|(\S+))` backtracks
//     over the whole tail, and it returns null, so `resumeAt` never advances and
//     nothing suppresses the next call. Nothing in the ladder T83 built has this
//     shape: all of theirs either have no `]:` at all or succeed on the first read.
//   * `destFailNewlineTail` / `destFailAngleTail` — the same seam with a newline
//     tail and with an unterminated `<`.
//   * `escapedDefsAllResolving` — T83's own reported worst, re-measured.
//   * `resolvingBangUses` — T82's worst under a megabyte, re-measured.
//   * `lineStartOpensNoClose` — the shape whose pre-change quadratic T83 removed.
//
// Usage: bun T84-cost.ts [ladder|boundary]
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

// Each builder takes a TOTAL byte target and returns a document of about that
// size, so a ladder compares like with like.
const builders: Record<string, (bytes: number) => string> = {
  destFailWhitespaceTail: (bytes) => {
    const half = Math.floor(bytes / 2);
    return "[a\n".repeat(Math.floor(half / 3)) + "]:" + " ".repeat(half);
  },
  destFailNewlineTail: (bytes) => {
    const half = Math.floor(bytes / 2);
    return "[a\n".repeat(Math.floor(half / 3)) + "]:" + "\n".repeat(half);
  },
  destFailAngleTail: (bytes) => {
    const half = Math.floor(bytes / 2);
    return "[a\n".repeat(Math.floor(half / 3)) + "]: <" + " ".repeat(half);
  },
  destFailEscapedWhitespaceTail: (bytes) => {
    const half = Math.floor(bytes / 2);
    return "[a\\\n".repeat(Math.floor(half / 4)) + "\\]]:" + " ".repeat(half);
  },
  escapedDefsAllResolving: (bytes) => {
    const per = `[k0\\]z]: ${U}\n![k0\\]z]`.length;
    const n = Math.max(1, Math.floor(bytes / per));
    return (
      Array.from({ length: n }, (_, i) => `[k${i}\\]z]: ${U}\n`).join("") +
      Array.from({ length: n }, (_, i) => `![k${i}\\]z]`).join("")
    );
  },
  resolvingBangUses: (bytes) => {
    const def = `[k]: ${U}\n`;
    const n = Math.max(1, Math.floor((bytes - def.length) / 4));
    return def + "![k]".repeat(n);
  },
  lineStartOpensNoClose: (bytes) => "[aaaaaaaaa\n".repeat(Math.max(1, Math.floor(bytes / 11))),
};

function best(fn: () => void, trials = 3): number {
  let ms = Infinity;
  for (let i = 0; i < trials; i += 1) {
    const t = performance.now();
    fn();
    ms = Math.min(ms, performance.now() - t);
  }
  return Number(ms.toFixed(1));
}

const mode = process.argv[2] ?? "ladder";

if (mode === "ladder") {
  const targets = [131072, 262144, 524288, 1048576];
  const rows: Array<Record<string, unknown>> = [];
  for (const [id, build] of Object.entries(builders)) {
    const points = targets.map((bytes) => {
      const text = build(bytes);
      return { target: bytes, bytes: text.length, ms: best(() => detectExfil(text, [])) };
    });
    const a = points[0] as { bytes: number; ms: number };
    const z = points[points.length - 1] as { bytes: number; ms: number };
    rows.push({
      shape: id,
      points,
      exponent: Number((Math.log(z.ms / a.ms) / Math.log(z.bytes / a.bytes)).toFixed(2)),
      worstMs: Math.max(...points.map((p) => p.ms)),
    });
  }
  console.log(
    JSON.stringify(
      {
        probe: "T84-cost/ladder",
        rows,
        overOneSecondAtOrUnderOneMb: rows
          .filter((r) => (r.worstMs as number) >= 1000)
          .map((r) => r.shape),
        superLinear: rows.filter((r) => (r.exponent as number) > 1.5).map((r) => r.shape),
      },
      null,
      2,
    ),
  );
} else {
  // The four public boundaries, at a megabyte and just under it.
  const cwd = process.cwd();
  const targets = [524288, 1048576];
  const rows: Array<Record<string, unknown>> = [];
  for (const [id, build] of Object.entries(builders)) {
    for (const target of targets) {
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
            description: id,
            inputSchema: { type: "object" },
            mutating: false,
            invoke: async () => ({ note: text }),
          },
        ],
      };
      let mcpMs = Infinity;
      for (let i = 0; i < 3; i += 1) {
        const t = performance.now();
        await dispatchCallTool(ctx, "p.x", {});
        mcpMs = Math.min(mcpMs, performance.now() - t);
      }
      let seamMs = Infinity;
      for (let i = 0; i < 3; i += 1) {
        const t = performance.now();
        await redactToolOutput(cwd, serialized);
        seamMs = Math.min(seamMs, performance.now() - t);
      }
      const persistMs = best(() => prepareOutputForPersistence(pass, serialized));
      const transportMs = best(() =>
        validateOutputForTransport({ value: { note: text }, format: "json" }),
      );
      const boundaries = {
        mcp: Number(mcpMs.toFixed(1)),
        persist: persistMs,
        transport: transportMs,
        seam: Number(seamMs.toFixed(1)),
      };
      rows.push({
        shape: id,
        bytes: text.length,
        boundaries,
        worstMs: Math.max(...Object.values(boundaries)),
        worstBoundary: Object.entries(boundaries).sort((x, y) => y[1] - x[1])[0]?.[0],
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        probe: "T84-cost/boundary",
        rows,
        boundariesOverOneSecond: rows
          .filter((r) => (r.worstMs as number) >= 1000)
          .map((r) => `${r.shape}@${r.bytes}=${r.worstMs}ms`),
        worst: rows.reduce((acc, r) =>
          (r.worstMs as number) > (acc.worstMs as number) ? r : acc,
        ),
      },
      null,
      2,
    ),
  );
}

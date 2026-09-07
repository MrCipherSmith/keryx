// RED/GREEN coverage for finalizeExpressOracleRun (flow 238/T8, same defect shape as
// scripts/benchmark/ablation-emission-gating.test.ts / oracle-emission-gating.test.ts):
// the captured gdgraph-affected system fixture used to be written to disk and each
// gold-kind's manifest printed to stdout BEFORE validatePairedBenchmark ran. Unlike the
// single-manifest producers, express-oracle scores ONE system output against TWO
// independent gold kinds (co-change / dependency) — this file specifically covers that
// two-manifest, shared-fixture gating: each manifest is gated on its OWN validity, but the
// ONE shared raw fixture is gated on BOTH being valid (see finalizeExpressOracleRun's doc
// comment for why). No network, no git clone, no gdgraph shell-out — only the pure
// finalize function with injected fake I/O.

import { describe, expect, test } from "bun:test";
import type { PairedBenchmarkManifestV2 } from "../../src/metrics/benchmark";
import { finalizeExpressOracleRun, type ExpressOracleEmissionIO } from "./run-express-oracle";
import type { GoldKind } from "../../src/metrics/oracle-runner";

function fakeManifest(taskId: string): PairedBenchmarkManifestV2 {
  return {
    protocol: "paired-3-5-v2",
    ladder: "metastore",
    task_ids: [taskId],
    runs: [],
    speedClaim: { claimed: false },
  };
}

function fakeIo(): { io: ExpressOracleEmissionIO; writes: string[]; prints: Array<{ kind: GoldKind; contents: string }>; lines: string[] } {
  const writes: string[] = [];
  const prints: Array<{ kind: GoldKind; contents: string }> = [];
  const lines: string[] = [];
  return {
    io: {
      writeSystemFixture: async (contents) => {
        writes.push(contents);
      },
      printManifest: (kind, contents) => {
        prints.push({ kind, contents });
      },
      logLine: (line) => {
        lines.push(line);
      },
    },
    writes,
    prints,
    lines,
  };
}

describe("finalizeExpressOracleRun", () => {
  test("both gold kinds invalid: nothing written, nothing printed, exit code 1", async () => {
    const { io, writes, prints, lines } = fakeIo();
    const code = await finalizeExpressOracleRun(
      { note: "fake" },
      { "co-change": fakeManifest("a"), dependency: fakeManifest("b") },
      {
        "co-change": { valid: false, errors: ["co-change fabricated error"] },
        dependency: { valid: false, errors: ["dependency fabricated error"] },
      },
      io,
    );

    expect(code).toBe(1);
    expect(writes).toEqual([]);
    expect(prints).toEqual([]);
    expect(lines.some((l) => l.includes("co-change fabricated error"))).toBe(true);
    expect(lines.some((l) => l.includes("dependency fabricated error"))).toBe(true);
    expect(lines.some((l) => l.includes("left unchanged"))).toBe(true);
  });

  test("both gold kinds valid: the shared fixture is written once and each manifest is printed once; exit code 0", async () => {
    const { io, writes, prints, lines } = fakeIo();
    const code = await finalizeExpressOracleRun(
      { note: "fake" },
      { "co-change": fakeManifest("a"), dependency: fakeManifest("b") },
      { "co-change": { valid: true, errors: [] }, dependency: { valid: true, errors: [] } },
      io,
    );

    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(prints).toHaveLength(2);
    expect(prints.map((p) => p.kind).sort()).toEqual(["co-change", "dependency"]);
    expect(lines.some((l) => l.includes("wrote fixtures/benchmark/express/gdgraph-affected.json"))).toBe(true);
  });

  test("one gold kind invalid, the other valid: the invalid one prints nothing, the valid one still prints, but the SHARED fixture is never written (exit code 1)", async () => {
    const { io, writes, prints, lines } = fakeIo();
    const code = await finalizeExpressOracleRun(
      { note: "fake" },
      { "co-change": fakeManifest("a"), dependency: fakeManifest("b") },
      { "co-change": { valid: true, errors: [] }, dependency: { valid: false, errors: ["dependency fabricated error"] } },
      io,
    );

    expect(code).toBe(1);
    // The shared raw fixture cannot be "half published" for one gold kind and not the other.
    expect(writes).toEqual([]);
    // But the co-change manifest, which IS valid on its own, still reaches stdout — a
    // sibling gold kind's invalidity never suppresses an independently-valid manifest.
    expect(prints).toHaveLength(1);
    expect(prints[0]?.kind).toBe("co-change");
    expect(lines.some((l) => l.includes("dependency fabricated error"))).toBe(true);
  });
});

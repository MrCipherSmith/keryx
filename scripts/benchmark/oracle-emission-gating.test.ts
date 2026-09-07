// RED/GREEN coverage for the same defect fixed across every scripts/benchmark/run-*-oracle.ts
// producer this lane owns (flow 238/T8, mirroring the sibling lane's
// scripts/benchmark/ablation-emission-gating.test.ts for run-ablation*.ts): the captured
// system-output fixture used to be written to disk and the derived manifest printed to
// stdout BEFORE validatePairedBenchmark ran. Each producer's `finalize*` function now gates
// both emissions on `validation.valid` — no live provider calls, no network, no shell-outs;
// these tests only exercise the pure finalize functions with injected fake I/O.

import { describe, expect, test } from "bun:test";
import type { PairedBenchmarkManifestV2 } from "../../src/metrics/benchmark";
import { finalizeGdctxOracleRun } from "./run-gdctx-oracle";
import { finalizeGdwikiOracleRun } from "./run-gdwiki-oracle";
import { finalizeMemoryOracleRun } from "./run-memory-oracle";
import { finalizeRagEmbeddingBaselineRun } from "./run-rag-embedding-baseline";
import { finalizeTestingOracleRun } from "./run-testing-oracle";

function fakeManifest(): PairedBenchmarkManifestV2 {
  return {
    protocol: "paired-3-5-v2",
    ladder: "metastore",
    task_ids: ["metastore:example"],
    runs: [],
    speedClaim: { claimed: false },
  };
}

function fakeSingleFixtureIo() {
  const writes: string[] = [];
  const prints: string[] = [];
  const lines: string[] = [];
  return {
    io: {
      writeResultsFixture: async (contents: string) => {
        writes.push(contents);
      },
      printManifest: (contents: string) => {
        prints.push(contents);
      },
      logLine: (line: string) => {
        lines.push(line);
      },
    },
    writes,
    prints,
    lines,
  };
}

const singleFixtureCases: Array<{
  name: string;
  call: (validation: { valid: boolean; errors: string[] }, io: ReturnType<typeof fakeSingleFixtureIo>["io"]) => Promise<number>;
}> = [
  {
    name: "finalizeMemoryOracleRun (run-memory-oracle.ts)",
    call: (validation, io) => finalizeMemoryOracleRun({ note: "fake" }, fakeManifest(), validation, io),
  },
  {
    name: "finalizeGdctxOracleRun (run-gdctx-oracle.ts)",
    call: (validation, io) => finalizeGdctxOracleRun({ note: "fake" }, fakeManifest(), validation, io),
  },
  {
    name: "finalizeGdwikiOracleRun (run-gdwiki-oracle.ts)",
    call: (validation, io) => finalizeGdwikiOracleRun({ note: "fake" }, fakeManifest(), validation, io),
  },
  {
    name: "finalizeRagEmbeddingBaselineRun (run-rag-embedding-baseline.ts)",
    call: (validation, io) => finalizeRagEmbeddingBaselineRun({ note: "fake" }, fakeManifest(), validation, io),
  },
];

describe.each(singleFixtureCases)("$name", ({ call }) => {
  test("an invalid manifest is never written to disk or printed, and the exit code is 1", async () => {
    const { io, writes, prints, lines } = fakeSingleFixtureIo();
    const code = await call({ valid: false, errors: ["fabricated validation error"] }, io);

    expect(code).toBe(1);
    expect(writes).toEqual([]);
    expect(prints).toEqual([]);
    expect(lines.some((l) => l.includes("valid: no"))).toBe(true);
    expect(lines.some((l) => l.includes("fabricated validation error"))).toBe(true);
    expect(lines.some((l) => l.includes("left unchanged"))).toBe(true);
  });

  test("a valid manifest is written to disk and printed exactly once, and the exit code is 0", async () => {
    const { io, writes, prints, lines } = fakeSingleFixtureIo();
    const code = await call({ valid: true, errors: [] }, io);

    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(prints).toHaveLength(1);
    expect(lines.some((l) => l.includes("valid: yes"))).toBe(true);
    expect(lines.some((l) => l.startsWith("wrote fixtures/benchmark/"))).toBe(true);
  });
});

describe("finalizeTestingOracleRun (run-testing-oracle.ts, two raw fixtures + one manifest)", () => {
  function fakeIo() {
    const coverageWrites: string[] = [];
    const relatedWrites: string[] = [];
    const prints: string[] = [];
    const lines: string[] = [];
    return {
      io: {
        writeCoverageFixture: async (contents: string) => {
          coverageWrites.push(contents);
        },
        writeRelatedFixture: async (contents: string) => {
          relatedWrites.push(contents);
        },
        printManifest: (contents: string) => {
          prints.push(contents);
        },
        logLine: (line: string) => {
          lines.push(line);
        },
      },
      coverageWrites,
      relatedWrites,
      prints,
      lines,
    };
  }

  test("an invalid manifest writes NEITHER fixture and prints nothing; exit code is 1", async () => {
    const { io, coverageWrites, relatedWrites, prints, lines } = fakeIo();
    const code = await finalizeTestingOracleRun(
      { note: "coverage" },
      { note: "related" },
      fakeManifest(),
      { valid: false, errors: ["fabricated validation error"] },
      io,
    );

    expect(code).toBe(1);
    expect(coverageWrites).toEqual([]);
    expect(relatedWrites).toEqual([]);
    expect(prints).toEqual([]);
    expect(lines.some((l) => l.includes("valid: no"))).toBe(true);
    expect(lines.some((l) => l.includes("fabricated validation error"))).toBe(true);
    expect(lines.some((l) => l.includes("left unchanged"))).toBe(true);
  });

  test("a valid manifest writes BOTH fixtures and prints once; exit code is 0", async () => {
    const { io, coverageWrites, relatedWrites, prints, lines } = fakeIo();
    const code = await finalizeTestingOracleRun(
      { note: "coverage" },
      { note: "related" },
      fakeManifest(),
      { valid: true, errors: [] },
      io,
    );

    expect(code).toBe(0);
    expect(coverageWrites).toHaveLength(1);
    expect(relatedWrites).toHaveLength(1);
    expect(prints).toHaveLength(1);
    expect(lines.some((l) => l.includes("valid: yes"))).toBe(true);
  });
});

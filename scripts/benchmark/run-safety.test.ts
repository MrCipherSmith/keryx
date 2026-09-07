// RED/GREEN coverage for finalizeSafetyRun (flow 238/T8, same defect shape as
// scripts/benchmark/ablation-emission-gating.test.ts / oracle-emission-gating.test.ts):
// both raw case fixtures (completion-honesty, false-premise) used to be written to disk and
// both derived manifests printed to stdout BEFORE validatePairedBenchmark ran. The two case
// groups are independent (never averaged — see run-safety.ts's module comment), so each is
// gated on ITS OWN validity, not on the other's. No live provider calls, no network, no git
// worktrees — only the pure finalize function with injected fake I/O.

import { describe, expect, test } from "bun:test";
import type { PairedBenchmarkManifestV2 } from "../../src/metrics/benchmark";
import { finalizeSafetyRun, type SafetyEmissionIO } from "./run-safety";

function fakeManifest(taskId: string): PairedBenchmarkManifestV2 {
  return {
    protocol: "paired-3-5-v2",
    ladder: "harness",
    task_ids: [taskId],
    runs: [],
    speedClaim: { claimed: false },
  };
}

function fakeIo(): {
  io: SafetyEmissionIO;
  honestyWrites: string[];
  premiseWrites: string[];
  honestyPrints: string[];
  premisePrints: string[];
  lines: string[];
} {
  const honestyWrites: string[] = [];
  const premiseWrites: string[] = [];
  const honestyPrints: string[] = [];
  const premisePrints: string[] = [];
  const lines: string[] = [];
  return {
    io: {
      writeHonestyFixture: async (contents) => {
        honestyWrites.push(contents);
      },
      writePremiseFixture: async (contents) => {
        premiseWrites.push(contents);
      },
      printHonestyManifest: (contents) => {
        honestyPrints.push(contents);
      },
      printPremiseManifest: (contents) => {
        premisePrints.push(contents);
      },
      logLine: (line) => {
        lines.push(line);
      },
    },
    honestyWrites,
    premiseWrites,
    honestyPrints,
    premisePrints,
    lines,
  };
}

describe("finalizeSafetyRun", () => {
  test("both groups invalid: nothing written, nothing printed, exit code 1", async () => {
    const { io, honestyWrites, premiseWrites, honestyPrints, premisePrints, lines } = fakeIo();
    const code = await finalizeSafetyRun(
      { note: "honesty" },
      fakeManifest("honesty"),
      { valid: false, errors: ["honesty fabricated error"] },
      { note: "premise" },
      fakeManifest("premise"),
      { valid: false, errors: ["premise fabricated error"] },
      io,
    );

    expect(code).toBe(1);
    expect(honestyWrites).toEqual([]);
    expect(premiseWrites).toEqual([]);
    expect(honestyPrints).toEqual([]);
    expect(premisePrints).toEqual([]);
    expect(lines.some((l) => l.includes("honesty fabricated error"))).toBe(true);
    expect(lines.some((l) => l.includes("premise fabricated error"))).toBe(true);
  });

  test("both groups valid: both fixtures written and both manifests printed exactly once, exit code 0", async () => {
    const { io, honestyWrites, premiseWrites, honestyPrints, premisePrints, lines } = fakeIo();
    const code = await finalizeSafetyRun(
      { note: "honesty" },
      fakeManifest("honesty"),
      { valid: true, errors: [] },
      { note: "premise" },
      fakeManifest("premise"),
      { valid: true, errors: [] },
      io,
    );

    expect(code).toBe(0);
    expect(honestyWrites).toHaveLength(1);
    expect(premiseWrites).toHaveLength(1);
    expect(honestyPrints).toHaveLength(1);
    expect(premisePrints).toHaveLength(1);
    expect(lines.some((l) => l.includes("wrote fixtures/benchmark/keryx/safety-completion-honesty"))).toBe(true);
    expect(lines.some((l) => l.includes("wrote fixtures/benchmark/keryx/safety-false-premise"))).toBe(true);
  });

  test("honesty invalid, premise valid: honesty is suppressed, premise still emits independently, exit code 1", async () => {
    const { io, honestyWrites, premiseWrites, honestyPrints, premisePrints, lines } = fakeIo();
    const code = await finalizeSafetyRun(
      { note: "honesty" },
      fakeManifest("honesty"),
      { valid: false, errors: ["honesty fabricated error"] },
      { note: "premise" },
      fakeManifest("premise"),
      { valid: true, errors: [] },
      io,
    );

    expect(code).toBe(1);
    expect(honestyWrites).toEqual([]);
    expect(honestyPrints).toEqual([]);
    // The false-premise group is independently valid and is NOT held hostage by the
    // unrelated completion-honesty group's invalidity.
    expect(premiseWrites).toHaveLength(1);
    expect(premisePrints).toHaveLength(1);
    expect(lines.some((l) => l.includes("honesty fabricated error"))).toBe(true);
  });
});

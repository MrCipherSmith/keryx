// RED/GREEN coverage for the defect fixed in build-comparative-report.ts: the report used
// to be written to disk and printed to stdout BEFORE its validity was checked, so an
// invalid report reached both places before the process exited non-zero — an artifact on
// disk indistinguishable from a good one. finalizeComparativeReport gates the write+print
// on `validation.valid` and is exercised here directly with injected I/O (no live fixture
// reads, no network) so the ordering contract is checked without running `main`.

import { describe, expect, test } from "bun:test";
import { finalizeComparativeReport } from "./build-comparative-report";
import type { ComparativeReport } from "../../src/metrics/comparative";

function fakeReport(): ComparativeReport {
  return {
    ladder: "comparative",
    referenceModel: "deepseek-v4-flash",
    targets: [{ target: "keryx", adapter: "native-reviewed", fairness: "met", model: "deepseek-v4-flash" }],
    cells: [
      {
        taskId: "harness:ablation:example",
        cell: "keryx-on",
        target: "keryx",
        model: "deepseek-v4-flash",
        successRate: { successes: 3, n: 3, rate: 1, ci95: { lower: 0.5, upper: 1 }, reliability: "exact" },
        medianToolCalls: 2,
        medianTokens: 100,
        publishable: true,
      },
    ],
  };
}

function fakeIo() {
  const writes: string[] = [];
  const prints: string[] = [];
  const lines: string[] = [];
  return {
    io: {
      writeReport: async (contents: string) => {
        writes.push(contents);
      },
      printReport: (contents: string) => {
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

describe("finalizeComparativeReport", () => {
  test("an invalid report is never written to disk or printed, and the exit code is 1", async () => {
    const { io, writes, prints, lines } = fakeIo();
    const report = fakeReport();
    const code = await finalizeComparativeReport(report, { valid: false, errors: ["cell keryx-on: not publishable"] }, io);

    expect(code).toBe(1);
    expect(writes).toEqual([]);
    expect(prints).toEqual([]);
    expect(lines.some((l) => l.includes("valid (AC-6): no"))).toBe(true);
    expect(lines.some((l) => l.includes("cell keryx-on: not publishable"))).toBe(true);
    expect(lines.some((l) => l.includes("left unchanged"))).toBe(true);
  });

  test("a valid report is written to disk and printed exactly once, and the exit code is 0", async () => {
    const { io, writes, prints, lines } = fakeIo();
    const report = fakeReport();
    const code = await finalizeComparativeReport(report, { valid: true, errors: [] }, io);

    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"ladder": "comparative"');
    expect(prints).toHaveLength(1);
    expect(lines.some((l) => l.includes("valid (AC-6): yes"))).toBe(true);
    expect(lines.some((l) => l.includes("wrote fixtures/benchmark/keryx/comparative-report.json"))).toBe(true);
  });

  test("emission order: write+print happen only after the caller has already computed validity (no emission call precedes validation in the caller)", async () => {
    // finalizeComparativeReport takes `validation` as an argument — it cannot run before
    // the caller computes it. This test pins that contract: calling it with an invalid
    // validation object produces zero emission calls, proving validation gates emission
    // rather than merely preceding it in source order.
    const { io, writes, prints } = fakeIo();
    await finalizeComparativeReport(fakeReport(), { valid: false, errors: ["x"] }, io);
    expect(writes.length + prints.length).toBe(0);
  });
});

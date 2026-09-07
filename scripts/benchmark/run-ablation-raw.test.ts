// RED/GREEN coverage for the defect fixed in run-ablation-raw.ts: the raw per-seed fixture
// used to be written to disk and the derived manifest printed to stdout BEFORE
// validatePairedBenchmark ran, so an invalid manifest's fixture reached disk (and stayed
// there — build-comparative-report.ts later reads it back as "already-validated") before
// the process exited non-zero. finalizeRawBaselineRun gates both emissions on
// `validation.valid` and is exercised here directly with injected I/O — no live provider
// calls, no network, no DEEPSEEK_API_KEY required.

import { describe, expect, test } from "bun:test";
import { finalizeRawBaselineRun } from "./run-ablation-raw";
import type { PairedBenchmarkManifestV2 } from "../../src/metrics/benchmark";

function fakeManifest(): PairedBenchmarkManifestV2 {
  return {
    protocol: "paired-3-5-v2",
    ladder: "comparative",
    task_ids: ["harness:ablation:example"],
    runs: [],
    speedClaim: { claimed: false },
  };
}

function fakeIo() {
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

describe("finalizeRawBaselineRun", () => {
  test("an invalid manifest is never written to disk or printed, and the exit code is 1", async () => {
    const { io, writes, prints, lines } = fakeIo();
    const code = await finalizeRawBaselineRun(
      { note: "fake", tasks: [] },
      fakeManifest(),
      { valid: false, errors: ["protocol: expected 3-5 task_ids, got 1"] },
      io,
    );

    expect(code).toBe(1);
    expect(writes).toEqual([]);
    expect(prints).toEqual([]);
    expect(lines.some((l) => l.includes("manifest valid: no"))).toBe(true);
    expect(lines.some((l) => l.includes("expected 3-5 task_ids"))).toBe(true);
    expect(lines.some((l) => l.includes("left unchanged"))).toBe(true);
  });

  test("a valid manifest is written to disk and printed exactly once, and the exit code is 0", async () => {
    const { io, writes, prints, lines } = fakeIo();
    const resultsFixture = { note: "fake", tasks: [] };
    const code = await finalizeRawBaselineRun(resultsFixture, fakeManifest(), { valid: true, errors: [] }, io);

    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"note": "fake"');
    expect(prints).toHaveLength(1);
    expect(lines.some((l) => l.includes("manifest valid: yes"))).toBe(true);
    expect(lines.some((l) => l.includes("wrote fixtures/benchmark/keryx/ablation-results-raw.json"))).toBe(true);
  });
});

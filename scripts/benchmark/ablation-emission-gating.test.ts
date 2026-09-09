// RED/GREEN coverage for the same defect fixed across every scripts/benchmark/
// run-ablation*.ts producer (see run-ablation-raw.test.ts and build-comparative-report.test.ts
// for the two named-in-task cases): the raw per-seed fixture used to be written to disk and
// the derived manifest printed to stdout BEFORE validatePairedBenchmark ran. This file
// enumerates the remaining six sibling producers found to share the exact same ordering
// (via `keryx ctx rg -- "validatePairedBenchmark|process.exit|console.log\\(JSON"` over
// scripts/benchmark) and checks each one's extracted `finalize*` function gates both
// emissions on `validation.valid` — no live provider calls, no network, no git worktrees.

import { describe, expect, test } from "bun:test";
import type { PairedBenchmarkManifestV2 } from "../../src/metrics/benchmark";
import { finalizeAblationRun } from "./run-ablation";
import { finalizeAblationCodexRun } from "./run-ablation-codex";
import { finalizeMutatingAblationRun } from "./run-ablation-mutating";
import { finalizeMutatingCodexRun } from "./run-ablation-mutating-codex";
import { finalizeMutatingGrokRun } from "./run-ablation-mutating-grok";
import { finalizeMutatingOpencodeRun } from "./run-ablation-mutating-opencode";

function fakeManifest(): PairedBenchmarkManifestV2 {
  return {
    protocol: "paired-3-5-v2",
    ladder: "harness",
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

const cases: Array<{ name: string; call: (validation: { valid: boolean; errors: string[] }, io: ReturnType<typeof fakeIo>["io"]) => Promise<number> }> = [
  {
    name: "finalizeAblationRun (run-ablation.ts)",
    call: (validation, io) => finalizeAblationRun({ note: "fake" }, fakeManifest(), validation, "ablation-results.json", "ladder=harness", io),
  },
  {
    name: "finalizeAblationCodexRun (run-ablation-codex.ts)",
    call: (validation, io) => finalizeAblationCodexRun({ note: "fake" }, fakeManifest(), validation, io),
  },
  {
    name: "finalizeMutatingAblationRun (run-ablation-mutating.ts)",
    call: (validation, io) => finalizeMutatingAblationRun({ note: "fake" }, fakeManifest(), validation, "ablation-mutating-results.json", io),
  },
  {
    name: "finalizeMutatingCodexRun (run-ablation-mutating-codex.ts)",
    call: (validation, io) => finalizeMutatingCodexRun({ note: "fake" }, fakeManifest(), validation, io),
  },
  {
    name: "finalizeMutatingGrokRun (run-ablation-mutating-grok.ts)",
    call: (validation, io) => finalizeMutatingGrokRun({ note: "fake" }, fakeManifest(), validation, io),
  },
  {
    name: "finalizeMutatingOpencodeRun (run-ablation-mutating-opencode.ts)",
    call: (validation, io) => finalizeMutatingOpencodeRun({ note: "fake" }, fakeManifest(), validation, io),
  },
];

describe.each(cases)("$name", ({ call }) => {
  test("an invalid manifest is never written to disk or printed, and the exit code is 1", async () => {
    const { io, writes, prints, lines } = fakeIo();
    const code = await call({ valid: false, errors: ["fabricated validation error"] }, io);

    expect(code).toBe(1);
    expect(writes).toEqual([]);
    expect(prints).toEqual([]);
    expect(lines.some((l) => l.includes("valid: no"))).toBe(true);
    expect(lines.some((l) => l.includes("fabricated validation error"))).toBe(true);
    expect(lines.some((l) => l.includes("left unchanged"))).toBe(true);
  });

  test("a valid manifest is written to disk and printed exactly once, and the exit code is 0", async () => {
    const { io, writes, prints, lines } = fakeIo();
    const code = await call({ valid: true, errors: [] }, io);

    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(prints).toHaveLength(1);
    expect(lines.some((l) => l.includes("valid: yes"))).toBe(true);
    expect(lines.some((l) => l.startsWith("wrote fixtures/benchmark/keryx/"))).toBe(true);
  });
});

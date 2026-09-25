// Flow 331, AC2/AC5/AC7 — the ci-triage adapter, offline (hermetic) only.
// Live mode is exercised by `run.ts`'s own live path (AC6), not by the test
// suite — `check:core`/CI never touch the network.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { ciTriageAdapter } from "./ci-triage";
import type { AdapterRunContext, Dataset } from "../types";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");

const EMPTY_DATASET: Dataset = {
  schemaVersion: 1,
  generatedAt: "1970-01-01T00:00:00.000Z",
  sourceRepo: "keryx (this repository, public)",
  labelMapping: { "true-positive": "", "false-positive": "", unlabeled: "" },
  findings: [],
  flows: [],
  counts: { packages: 0, findings: 0, byLabel: { "true-positive": 0, "false-positive": 0, unlabeled: 0 } },
  problems: [],
};

function ctx(live: boolean): AdapterRunContext {
  return { root: ROOT, dataset: EMPTY_DATASET, live, bunPath: process.execPath, cliPath: path.join(ROOT, "src", "cli.ts") };
}

describe("ciTriageAdapter: without-jev (synthetic baseline)", () => {
  test("scores the naive 'always real-regression' baseline against the eval set's truth labels, no subprocess", async () => {
    const adapter = ciTriageAdapter();
    const result = await adapter.run("without-jev", ctx(false));
    expect(result.available).toBe(true);
    if (!result.available) throw new Error("unreachable");
    expect(result.n).toBe(8);
    expect(result.usage).toEqual({ jevCalls: 0, inputTokens: 0, cost: 0, wallClockMs: 0 });
    // Every prediction is `flagged: true` (the baseline always predicts real-regression).
    expect(result.predictions.every((p) => p.flagged)).toBe(true);
    // At least one case in the eval set is NOT a real-regression (flaky/infra), so the baseline is imperfect.
    expect(result.predictions.some((p) => p.correct === false)).toBe(true);
  });
});

describe("ciTriageAdapter: with-jev, offline replay (AC5/AC7 hermeticity)", () => {
  test("runs with no ambient OPENROUTER_API_KEY (or saved credential) and still succeeds — fixtures answer every question", async () => {
    const originalKey = process.env.OPENROUTER_API_KEY;
    // Deliberately poisoned, not merely absent: offline mode must not reach the
    // network under any ambient credential state, saved or env — see the
    // adapter's own synthetic-key comment.
    process.env.OPENROUTER_API_KEY = "not-a-real-key";
    try {
      const adapter = ciTriageAdapter();
      const result = await adapter.run("with-jev", ctx(false));
      expect(result.available).toBe(true);
      if (!result.available) throw new Error("unreachable");
      expect(result.n).toBe(8);
      expect(result.predictions).toHaveLength(8);
      expect(result.usage.cost).toBeGreaterThanOrEqual(0);
      expect(result.notes.join(" ")).toContain("Offline");
    } finally {
      if (originalKey !== undefined) process.env.OPENROUTER_API_KEY = originalKey;
    }
  });

  test("offline replay is deterministic across repeated runs", async () => {
    const adapter = ciTriageAdapter();
    const first = await adapter.run("with-jev", ctx(false));
    const second = await adapter.run("with-jev", ctx(false));
    if (!first.available || !second.available) throw new Error("unreachable");
    expect(first.predictions).toEqual(second.predictions);
    expect(first.usage.cost).toBe(second.usage.cost);
  });
});

// Flow 331, AC2/AC7 — the review-conform adapter, always offline (the CLI
// has no --live flag for this verb — see the adapter's own file header).
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { reviewConformAdapter } from "./review-conform";
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

describe("reviewConformAdapter: without-jev", () => {
  test("every clause is not-evaluated — the component does not exist without Jev", async () => {
    const adapter = reviewConformAdapter();
    const result = await adapter.run("without-jev", ctx(false));
    expect(result.available).toBe(true);
    if (!result.available) throw new Error("unreachable");
    expect(result.predictions.every((p) => p.flagged === false)).toBe(true);
    expect(result.usage.jevCalls).toBe(0);
    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.cost).toBe(0);
  });
});

describe("reviewConformAdapter: with-jev, offline fixtures", () => {
  test("replays src/commands/fixtures/conform/ and flags the known likely-violated clause", async () => {
    const adapter = reviewConformAdapter();
    const result = await adapter.run("with-jev", ctx(false));
    expect(result.available).toBe(true);
    if (!result.available) throw new Error("unreachable");
    expect(result.n).toBeGreaterThan(0);
    const byId = new Map(result.predictions.map((p) => [p.id, p]));
    // From the committed fixture (src/commands/fixtures/conform/jev-response.json via the CLI test suite): 0.22 < 0.5 threshold.
    expect(byId.get("change-limits-2")?.flagged).toBe(true);
    expect(byId.get("change-limits-1")?.flagged).toBe(false);
    expect(result.addedTruePositives).toBeNull();
    expect(result.usage.jevCalls).toBeGreaterThan(0);
  });

  test("live and offline are identical — the CLI has no --live path for this verb", async () => {
    const adapter = reviewConformAdapter();
    const offline = await adapter.run("with-jev", ctx(false));
    const live = await adapter.run("with-jev", ctx(true));
    if (!offline.available || !live.available) throw new Error("unreachable");
    expect(offline.predictions).toEqual(live.predictions);
    expect(offline.usage.cost).toBe(live.usage.cost);
    expect(offline.usage.jevCalls).toBe(live.usage.jevCalls);
  });
});

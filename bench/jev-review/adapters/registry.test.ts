// Flow 331, AC2/AC7 — the adapter registry, and the not-available stubs for
// components in flight in other worktrees.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { registerAdapters } from "./registry";
import { flowCheckAcAdapter, reviewJevRulesAdapter, severityCalibrationAdapter } from "./not-available";
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
function ctx(live = false): AdapterRunContext {
  return { root: ROOT, dataset: EMPTY_DATASET, live, bunPath: process.execPath, cliPath: path.join(ROOT, "src", "cli.ts") };
}

describe("registerAdapters", () => {
  test("registers ci-triage and review-conform as available, and the three in-flight hooks as not available", () => {
    const adapters = registerAdapters();
    const byId = new Map(adapters.map((a) => [a.id, a]));
    expect(byId.get("ci-triage")?.available).toBe(true);
    expect(byId.get("review-conform")?.available).toBe(true);
    expect(byId.get("flow-check-ac")?.available).toBe(false);
    expect(byId.get("review-jev-rules")?.available).toBe(false);
    expect(byId.get("severity-calibration")?.available).toBe(false);
    expect(adapters).toHaveLength(5);
  });

  test("ids are unique", () => {
    const ids = registerAdapters().map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("not-available stubs (AC2: flow 328/330/later hooks)", () => {
  test("report not-available for both arms, with a reason naming the flow, and touch nothing", async () => {
    for (const factory of [flowCheckAcAdapter, reviewJevRulesAdapter, severityCalibrationAdapter]) {
      const adapter = factory();
      expect(adapter.available).toBe(false);
      expect(adapter.unavailableReason).toBeTruthy();
      for (const arm of ["without-jev", "with-jev"] as const) {
        const result = await adapter.run(arm, ctx());
        expect(result.available).toBe(false);
        if (result.available) throw new Error("unreachable");
        expect(result.arm).toBe(arm);
        expect(result.reason).toBe(adapter.unavailableReason ?? "");
      }
    }
  });
});

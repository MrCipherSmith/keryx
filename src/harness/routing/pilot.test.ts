import { expect, test } from "bun:test";
import { summarizeRoutingPilot } from "./pilot";

const baseline = { requestId: "request", snapshotDigest: "snapshot", classifierReceiptId: "receipt" };
const selected = { providerId: "alpha", modelId: "same-id" };

test("compares provider and model only for identical routing inputs", () => {
  const report = summarizeRoutingPilot([
    { ...baseline, kind: "preview", selection: selected },
    { ...baseline, kind: "dispatch", selection: { providerId: "beta", modelId: "same-id" } },
    { ...baseline, kind: "dispatch", snapshotDigest: "changed", selection: selected },
    { ...baseline, kind: "dispatch", classifierReceiptId: "different", selection: selected },
  ]);
  expect(report).toMatchObject({ comparableDispatches: 1, mismatches: 1, unmatchedDispatches: 2, parity: "fail" });
});

test("empty observations and missing fallback reasons cannot count as success", () => {
  expect(summarizeRoutingPilot([])).toMatchObject({ parity: "unmeasured", fallbackTrace: "unmeasured" });
  expect(summarizeRoutingPilot([
    { ...baseline, kind: "dispatch", selection: selected, fallback: { parentDecisionId: "previous" } },
  ])).toMatchObject({ fallbackDispatches: 1, incompleteFallbacks: 1, fallbackTrace: "fail" });
});

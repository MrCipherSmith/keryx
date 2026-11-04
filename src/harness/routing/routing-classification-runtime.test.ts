import { expect, test } from "bun:test";
import { applyRoutingClassificationResult } from "./routing-classification-runtime";
import type { RoutingClassifierResult } from "./classifier-chain-v2";
import type { RoutingRequest } from "./routing-request";

const request = (category: RoutingRequest["category"]): RoutingRequest => ({
  requestId: "r",
  category,
  origin: "operator",
  baseline: { providerId: "p", modelId: "m" },
  requirements: { capabilities: ["tools"], inputTokensRequired: 1, outputTokensReserved: 1 },
});

const classified: RoutingClassifierResult = {
  status: "classified",
  adapterId: "jev",
  receiptId: "receipt",
  classification: { category: "planning", modelClass: "frontier", confidence: 0.9, reasonCode: "complex", requiredCapabilities: ["vision", "tools"] },
  trace: [{ adapterId: "jev", outcome: "accepted", confidence: 0.9 }],
};

test("classification preserves trusted category and merges requirements", () => {
  const result = applyRoutingClassificationResult(request("review"), classified);
  expect(result.status).toBe("ready");
  if (result.status !== "ready") return;
  expect(result.request.category).toBe("review");
  expect(result.request.requirements.capabilities).toEqual(["tools", "vision"]);
  expect(result.request.recommendation).toEqual({ modelClass: "frontier", source: "classifier", receiptId: "receipt" });
});

test("default category may be assigned by classification", () => {
  const result = applyRoutingClassificationResult(request("default"), classified);
  if (result.status !== "ready") throw new Error("expected ready");
  expect(result.request.category).toBe("planning");
});

test("failure is explicit and cancellation never invokes fallback", () => {
  const fallback = applyRoutingClassificationResult(request("default"), {
    status: "fallback",
    assignment: { mode: "class", modelClass: "standard" },
    reason: "classifier-failed",
    receiptId: "failed-receipt",
    trace: [],
  });
  expect(fallback.status === "ready" ? fallback.request.classification : undefined).toEqual({ status: "failed", receiptId: "failed-receipt" });
  expect(applyRoutingClassificationResult(request("default"), { status: "cancelled", reason: "cancelled", trace: [] })).toEqual({ status: "cancelled", reason: "cancelled" });
});

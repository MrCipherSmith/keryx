import { expect, test } from "bun:test";
import { runRoutingClassifierChain, type RoutingClassification, type RoutingClassifierAdapter } from "./classifier-chain";
import { RoutingBudgetLedger } from "./routing-budget";

const accepted: RoutingClassification = {
  category: "coding",
  modelClass: "expert",
  confidence: 0.9,
  reasonCode: "multi-module-change",
  requiredCapabilities: ["tools"],
};

const adapter = (id: string, classify: RoutingClassifierAdapter<string>["classify"]): RoutingClassifierAdapter<string> => ({ id, classify });
const options = (adapters: readonly RoutingClassifierAdapter<string>[]) => ({
  adapters,
  minConfidence: 0.7,
  onFailure: { mode: "class" as const, modelClass: "standard" as const },
});

test("deterministic, JEV and model adapters share one strict contract", async () => {
  for (const id of ["deterministic", "jev", "model"]) {
    const result = await runRoutingClassifierChain("task", options([adapter(id, async () => accepted)]));
    expect(result.status).toBe("classified");
    if (result.status === "classified") expect(result.classification).toEqual(accepted);
  }
});

test("invalid and low-confidence outputs advance once to the next adapter", async () => {
  const calls: string[] = [];
  const result = await runRoutingClassifierChain("task", options([
    adapter("invalid", async () => {
      calls.push("invalid");
      return { ...accepted, extra: true };
    }),
    adapter("low", async () => {
      calls.push("low");
      return { ...accepted, confidence: 0.2 };
    }),
    adapter("accepted", async () => {
      calls.push("accepted");
      return accepted;
    }),
  ]));
  expect(calls).toEqual(["invalid", "low", "accepted"]);
  expect(result.status).toBe("classified");
  expect(result.trace.map((entry) => entry.outcome)).toEqual(["invalid", "low-confidence", "accepted"]);
});

test("aggregate deadline aborts an adapter that ignores cancellation and applies explicit fallback", async () => {
  const calls: string[] = [];
  const never = new Promise<unknown>(() => undefined);
  const result = await runRoutingClassifierChain("task", {
    ...options([
      adapter("slow", async () => {
        calls.push("slow");
        return never;
      }),
      adapter("must-not-run", async () => {
        calls.push("must-not-run");
        return accepted;
      }),
    ]),
    deadlineMs: 5,
  });
  expect(result.status).toBe("fallback");
  expect(calls).toEqual(["slow"]);
  expect(result.trace[0]?.outcome).toBe("timeout");
});

test("caller cancellation is terminal and never invokes fallback adapters", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const resultPromise = runRoutingClassifierChain("task", {
    ...options([adapter("first", async (_input, { signal }) => {
      calls.push("first");
      controller.abort("stop");
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return accepted;
    }),
    adapter("second", async () => {
      calls.push("second");
      return accepted;
    })]),
    signal: controller.signal,
  });
  const result = await resultPromise;
  expect(result.status).toBe("cancelled");
  expect(calls.length).toBeLessThanOrEqual(1);
});

test("chain bounds and duplicate adapter ids are rejected", async () => {
  const one = adapter("same", async () => accepted);
  expect(runRoutingClassifierChain("task", options([one, one]))).rejects.toThrow("unique");
  expect(runRoutingClassifierChain("task", options([
    one,
    adapter("two", async () => accepted),
    adapter("three", async () => accepted),
    adapter("four", async () => accepted),
  ]))).rejects.toThrow("at most three");
});

test("classifier attempts reserve the same money ledger as execution", async () => {
  const budget = new RoutingBudgetLedger({ taskUsd: 0.5 });
  const result = await runRoutingClassifierChain("task", {
    ...options([adapter("jev", async () => accepted)]),
    budget,
    estimatedCostUsd: () => 0.6,
  });
  expect(result.status).toBe("fallback");
  expect(result.trace).toEqual([{ adapterId: "jev", outcome: "budget-exceeded" }]);
});

test("classifier reservation reconciles provider-reported actual cost", async () => {
  const budget = new RoutingBudgetLedger({ taskUsd: 1 });
  await runRoutingClassifierChain("task", {
    ...options([adapter("model", async () => accepted)]),
    budget,
    estimatedCostUsd: () => 0.8,
    actualCostUsd: () => 0.2,
  });
  expect(budget.snapshot()).toEqual({ capUsd: 1, spentUsd: 0.2, reservedUsd: 0, remainingUsd: 0.8 });
});

test("classifier receipt binds request input and config identity", async () => {
  const classifier = adapter("model", async () => accepted);
  const context = { receiptVersion: 1 as const, requestId: "request-a", configDigest: "config-a", requirementsDigest: "requirements-a" };
  const first = await runRoutingClassifierChain("task-a", {
    ...options([classifier]),
    receiptContext: context,
  });
  const changedInput = await runRoutingClassifierChain("task-b", {
    ...options([classifier]),
    receiptContext: context,
  });
  const changedConfig = await runRoutingClassifierChain("task-a", {
    ...options([classifier]),
    receiptContext: { ...context, configDigest: "config-b" },
  });
  const changedRequirements = await runRoutingClassifierChain("task-a", {
    ...options([classifier]),
    receiptContext: { ...context, requirementsDigest: "requirements-b" },
  });
  expect(first.status).toBe("classified");
  expect(changedInput.status).toBe("classified");
  expect(changedConfig.status).toBe("classified");
  expect(changedRequirements.status).toBe("classified");
  if (first.status !== "classified" || changedInput.status !== "classified" || changedConfig.status !== "classified" || changedRequirements.status !== "classified") return;
  expect(first.receiptId).not.toBe(changedInput.receiptId);
  expect(first.receiptId).not.toBe(changedConfig.receiptId);
  expect(first.receiptId).not.toBe(changedRequirements.receiptId);
});

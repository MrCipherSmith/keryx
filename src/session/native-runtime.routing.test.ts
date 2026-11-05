import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callRound, okReply, scriptedProvider } from "../commands/agent.test-helpers";
import { normalizeRoutingV2Config } from "../harness/routing/config-v2";
import { RoutingBudgetLedger } from "../harness/routing/routing-budget";
import type { RoutingRequest } from "../harness/routing/routing-request";
import { resolveRoutingForRuntime } from "../harness/routing/routing-runtime";
import { createRoutingSnapshot } from "../harness/routing/snapshot";
import { canonicalDigest, type Control } from "../remote-control/protocol";
import { NativeRoutingBudgetStore } from "./native-routing-budget";
import { createNativeSessionRuntime } from "./native-runtime";

test("native runtime shares the selection ledger across model rounds without switching candidates", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-native-routing-budget-"));
  const provider = scriptedProvider([callRound("unknown", "missing_tool", "{}"), okReply]);
  const target = { providerId: "scripted", modelId: "m" };
  const routingConfig = normalizeRoutingV2Config({ user: { schemaVersion: 2,
    categories: { default: { mode: "baseline" } },
    execution: { maxAttempts: 3, selectionTimeoutMs: 3_000, maxEstimatedCostUsd: 0.15, unknownCost: "allow" } } });
  const request: RoutingRequest = { requestId: "native-budget", category: "default", origin: "native-session", baseline: target,
    requirements: { capabilities: ["tools"], inputTokensRequired: 1, outputTokensReserved: 10 } };
  const routingSnapshot = createRoutingSnapshot({ configDigest: routingConfig.configDigest, observedAt: "2026-11-04T00:00:00.000Z",
    catalogRevision: "catalog", policyRevision: "policy", capabilityRevision: "capability", authFailedProviderIds: [], baseline: target,
    models: [{ target, connected: true, credentialsAvailable: true, policyAllowed: true, parentAllowed: true, availability: "available",
      capabilities: ["tools"], contextLength: 100_000, cooldown: false, estimatedCostUsd: 0.1, observedLatencyMs: 1 }] });
  const receipt = resolveRoutingForRuntime({ request, snapshot: routingSnapshot, config: routingConfig });
  const store = new NativeRoutingBudgetStore();
  store.publish(receipt.receiptId, { target, receipt, config: routingConfig, budget: new RoutingBudgetLedger({ taskUsd: 0.15, unknownCost: "allow" }),
    journal: { cwd, configDir: cwd }, estimatedCostUsd: () => 0.1, actualCostUsd: () => 0.1 });
  const runtime = createNativeSessionRuntime({ cwd, provider: provider.provider, providerId: target.providerId, modelId: target.modelId, routingBudgetStore: store });
  const config: Control["SessionConfig"] = { configVersion: 1, baselineCandidateId: "scripted:m", reasoningEffort: "none",
    routing: { enabled: true, profileId: "local", candidateIds: ["scripted:m"], fallbackCandidateId: "scripted:m" },
    policyDigest: "a".repeat(64), capabilityDigest: "a".repeat(64) };
  const snapshot: Control["ConfigSnapshot"] = { config, configDigest: canonicalDigest(config), effectiveCandidateId: "scripted:m",
    routingDecision: "classified", fallbackReason: "none", selectionReceiptId: receipt.receiptId };
  try {
    const result = await runtime.run({ write: () => {} }, [], "Use a tool and continue", snapshot, {});
    expect(result).toMatchObject({ outcome: "failed", reason: "provider-error" });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({ providerId: target.providerId, modelId: target.modelId });
  } finally { await runtime.stop(); await rm(cwd, { recursive: true, force: true }); }
});

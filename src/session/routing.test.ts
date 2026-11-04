import { expect, test } from "bun:test";
import type { Control } from "../remote-control/protocol";
import { createSessionRouting } from "./routing";

const digest = "a".repeat(64);
const candidate: Control["RoutingCandidate"] = { candidateId: "baseline", providerId: "provider", modelId: "model", reasoningEfforts: ["none"], available: true, reason: "none", privacyClass: "approved-egress", costClass: "metered" };
const config: Control["SessionConfig"] = { configVersion: 1, baselineCandidateId: candidate.candidateId, reasoningEffort: "none", policyDigest: digest, capabilityDigest: digest,
  routing: { enabled: true, profileId: "local", candidateIds: [candidate.candidateId], fallbackCandidateId: candidate.candidateId } };
const availability: Control["RoutingAvailability"] = { version: 1, policyDigest: digest, capabilityDigest: digest, profileIds: ["local"], candidates: [candidate] };

test("session routing preserves legacy fallback for ordinary classifier failures", async () => {
  const routing = createSessionRouting({ config, availability, classify: async () => { throw new Error("transient"); } });
  expect(await routing.select("task", config)).toMatchObject({ effectiveCandidateId: candidate.candidateId, routingDecision: "classifier-fallback", fallbackReason: "classifier-failed" });
});

test("session routing propagates an active v2 fatal classifier failure", async () => {
  const fatal = Object.assign(new Error("routing-v2-config-invalid"), { fatal: true });
  const routing = createSessionRouting({ config, availability, classify: async () => { throw fatal; }, fatalClassificationError: (cause) => cause === fatal });
  await expect(routing.select("task", config)).rejects.toBe(fatal);
});

test("session routing preserves a canonical v2 receipt supplied by the classifier", async () => {
  const receipt = "b".repeat(64);
  const routing = createSessionRouting({ config, availability, classify: async () => ({ candidateId: candidate.candidateId, selectionReceiptId: receipt }) });
  expect((await routing.select("task", config)).selectionReceiptId).toBe(receipt);
});

test("session routing does not attach a receipt for a rejected candidate", async () => {
  const receipt = "b".repeat(64);
  const routing = createSessionRouting({ config, availability, classify: async () => ({ candidateId: "outside-frozen-set", selectionReceiptId: receipt }) });
  const snapshot = await routing.select("task", config);
  expect(snapshot).toMatchObject({ effectiveCandidateId: candidate.candidateId, routingDecision: "classifier-fallback", fallbackReason: "candidate-unavailable" });
  expect(snapshot.selectionReceiptId).not.toBe(receipt);
});

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

test("session routing propagates a fatal classifier failure", async () => {
  const fatal = Object.assign(new Error("routing-config-invalid"), { fatal: true });
  const routing = createSessionRouting({ config, availability, classify: async () => { throw fatal; }, fatalClassificationError: (cause) => cause === fatal });
  await expect(routing.select("task", config)).rejects.toBe(fatal);
});

test("session routing preserves a canonical routing receipt supplied by the classifier", async () => {
  const receipt = "b".repeat(64);
  const routing = createSessionRouting({ config, availability, classify: async () => ({ candidateId: candidate.candidateId, selectionReceiptId: receipt }) });
  expect((await routing.select("task", config)).selectionReceiptId).toBe(receipt);
});

test("session routing preserves a receipt when routing selects the separately authorized baseline", async () => {
  const receipt = "c".repeat(64);
  const alternate = { ...candidate, candidateId: "alternate", modelId: "alternate" };
  const baselineSeparate: Control["SessionConfig"] = { ...config,
    routing: { ...config.routing, candidateIds: [alternate.candidateId], fallbackCandidateId: alternate.candidateId } };
  const routing = createSessionRouting({ config: baselineSeparate, availability: { ...availability, candidates: [candidate, alternate] },
    classify: async () => ({ candidateId: candidate.candidateId, selectionReceiptId: receipt }) });
  expect(await routing.select("task", baselineSeparate)).toMatchObject({ effectiveCandidateId: candidate.candidateId,
    routingDecision: "classified", fallbackReason: "none", selectionReceiptId: receipt });
});

test("session routing does not attach a receipt for a rejected candidate", async () => {
  const receipt = "b".repeat(64);
  const routing = createSessionRouting({ config, availability, classify: async () => ({ candidateId: "outside-frozen-set", selectionReceiptId: receipt }) });
  const snapshot = await routing.select("task", config);
  expect(snapshot).toMatchObject({ effectiveCandidateId: candidate.candidateId, routingDecision: "classifier-fallback", fallbackReason: "candidate-unavailable" });
  expect(snapshot.selectionReceiptId).not.toBe(receipt);
});

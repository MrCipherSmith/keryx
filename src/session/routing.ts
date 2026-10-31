import { randomUUID } from "node:crypto";
import { canonicalDigest, type Control } from "../remote-control/protocol";

export interface SessionRoutingOptions {
  config: Control["SessionConfig"];
  availability: Control["RoutingAvailability"];
  classify?: (text: string, config: Control["SessionConfig"], signal?: AbortSignal) => Promise<string | undefined>;
}
export function createSessionRouting(options: SessionRoutingOptions) {
  const available = (id: string, config: Control["SessionConfig"]) => options.availability.candidates.find((candidate) =>
    candidate.candidateId === id && candidate.available && candidate.reason === "none" && candidate.reasoningEfforts.includes(config.reasoningEffort));
  return {
    availability: () => structuredClone(options.availability),
    validate(config: Control["SessionConfig"]): boolean {
      return config.policyDigest === options.availability.policyDigest && config.capabilityDigest === options.availability.capabilityDigest
        && options.availability.profileIds.includes(config.routing.profileId)
        && available(config.baselineCandidateId, config) !== undefined
        && config.routing.candidateIds.every((id) => available(id, config) !== undefined)
        && config.routing.candidateIds.includes(config.routing.fallbackCandidateId);
    },
    async select(text: string, config: Control["SessionConfig"], signal?: AbortSignal): Promise<Control["ConfigSnapshot"]> {
      const pinned = structuredClone(config);
      let effectiveCandidateId = pinned.baselineCandidateId;
      let routingDecision: Control["ConfigSnapshot"]["routingDecision"] = "baseline";
      let fallbackReason: Control["ConfigSnapshot"]["fallbackReason"] = "none";
      if (pinned.routing.enabled) {
        try {
          const selected = await options.classify?.(text, pinned, signal);
          if (selected !== undefined && pinned.routing.candidateIds.includes(selected) && available(selected, pinned) !== undefined) {
            effectiveCandidateId = selected; routingDecision = "classified";
          } else { routingDecision = "classifier-fallback"; fallbackReason = selected === undefined ? "classifier-failed" : "candidate-unavailable"; }
        } catch { routingDecision = "classifier-fallback"; fallbackReason = "classifier-failed"; }
      }
      return { config: pinned, configDigest: canonicalDigest(pinned), effectiveCandidateId, routingDecision, fallbackReason, selectionReceiptId: randomUUID() };
    },
  };
}

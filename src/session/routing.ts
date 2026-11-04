import { randomUUID } from "node:crypto";
import { canonicalDigest, type Control } from "../remote-control/protocol";

export interface SessionRoutingOptions {
  config: Control["SessionConfig"];
  availability: Control["RoutingAvailability"];
  classify?: (text: string, config: Control["SessionConfig"], signal?: AbortSignal) => Promise<string | { readonly candidateId?: string; readonly selectionReceiptId?: string } | undefined>;
  /** Active routing failures that must refuse the turn instead of becoming a legacy baseline fallback. */
  fatalClassificationError?: (cause: unknown) => boolean;
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
      let selectionReceiptId: string | undefined;
      let routingDecision: Control["ConfigSnapshot"]["routingDecision"] = "baseline";
      let fallbackReason: Control["ConfigSnapshot"]["fallbackReason"] = "none";
      if (pinned.routing.enabled) {
        try {
          const classified = await options.classify?.(text, pinned, signal);
          const selected = typeof classified === "string" ? classified : classified?.candidateId;
          if (selected !== undefined && pinned.routing.candidateIds.includes(selected) && available(selected, pinned) !== undefined) {
            effectiveCandidateId = selected; routingDecision = "classified";
            selectionReceiptId = typeof classified === "object" ? classified.selectionReceiptId : undefined;
          } else { routingDecision = "classifier-fallback"; fallbackReason = selected === undefined ? "classifier-failed" : "candidate-unavailable"; }
        } catch (cause) {
          if (options.fatalClassificationError?.(cause) === true) throw cause;
          routingDecision = "classifier-fallback"; fallbackReason = "classifier-failed";
        }
      }
      return { config: pinned, configDigest: canonicalDigest(pinned), effectiveCandidateId, routingDecision, fallbackReason, selectionReceiptId: selectionReceiptId ?? randomUUID() };
    },
  };
}

// Flow 308 (W8, Lane B, T6): the public door of `src/security/impact-evidence`.
//
// W6's registration slot: `createImpactEvidenceProvider(deps?) =>
// (request: ImpactEvidenceRequest) => Promise<ImpactEvidenceDecision>`, keyed
// by `IMPACT_EVIDENCE_HOOK_ID = "keryx.impact-evidence"`. That is the exact
// signature W6 registers at the `keryx.impact-evidence` provider slot when it
// wires host delivery. Host delivery itself — actually installing a
// `pre-tool-context` surface into a harness's own hook config so this
// provider is invoked before a tool call — goes through the adapter
// registry's `pre-tool-context` surface flag (`src/integrations`,
// `surfacesOf(adapter, { flag: "pre-tool-context" })`) ONLY, and no such
// surface is registered for any adapter yet (`host.ts#hostDeliveryStatus`
// reports every adapter as `not-registered` today). Wiring that surface is
// NOT this flow's job — see `host.ts`'s doc comment.
//
// F19 (review round 1, documentation): `ImpactEvidenceRequest.acknowledgement`
// / `.rollbackLine` / `.denied` cannot be supplied by today's Claude Code
// PreToolUse delivery — its hook payload carries no such fields, and there is
// no round-trip yet from a human's answer at the permission prompt back into
// the NEXT hook call. Until W6's runtime wires that round-trip, the host
// (Claude) delivery path in `src/commands/security-impact-evidence.ts`
// necessarily returns `outcome: "ask"` with the evidence/rollback prompt in
// `additionalContext` whenever this provider needs one of those fields, and a
// human answers through Claude Code's own permission UI — this module makes
// no attempt to invent or infer an acknowledgement/rollback line on its own.

export type {
  AffectedEvidenceSection,
  ImpactEvidence,
  ImpactEvidenceDecision,
  ImpactEvidenceHookClass,
  ImpactEvidenceLogEvent,
  ImpactEvidenceLogRecord,
  ImpactEvidenceProfile,
  ImpactEvidenceReason,
  ImpactEvidenceRequest,
  MemoryCaveatEntry,
  RelatedTestsEvidenceSection,
} from "./types";
export { IMPACT_EVIDENCE_HOOK_ID } from "./types";

export { computeImpactEvidence, renderEvidenceBlock } from "./evidence";
export type { ComputeImpactEvidenceDeps } from "./evidence";

export {
  appendLogRecord,
  impactEvidenceDataRoot,
  loadSessionState,
  logPath,
  readLogRecords,
  saveSessionState,
  sanitizeSessionId,
} from "./state";
export type { ImpactEvidenceSessionState } from "./state";

export { createImpactEvidenceProvider, impactEvidenceHookClass, normalizeRequestFiles } from "./provider";
export type { ImpactEvidenceProviderDeps } from "./provider";

export { hostDeliveryStatus } from "./host";
export type { HostDeliveryEntry, HostDeliveryStatus } from "./host";

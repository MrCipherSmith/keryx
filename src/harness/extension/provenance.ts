// Registered-extension provenance + registry-side escalation (flow 024, R2-2 /
// W15+ / R2-1+ / W12+ / W7+ / W10+, reviewer track: security/contract).
//
// Closes E-03 §4 AC-R2-2 (2 scenarios):
//   - SC_R18_REGISTERED_EXTENSION_PROVENANCE (AC1/AC2): a successful W15
//     `registerExtension` (pinned manifest + non-empty capability grant)
//     persists an `ExtensionProvenanceRecord` carrying the pinned `manifestHash`,
//     the grant's `grantId`, its `capabilities` EXACTLY (a fresh copy — authority
//     is NEVER widened beyond the grant), and a derived-trust `Provenance` (W7
//     shape, `trustLevel:"derived"`, a fresh id from the injected `idSeq()`,
//     taint-linked to the registration parent via W12 `childProvenance`). A
//     fail-closed registration (missing manifest / empty grant) propagates the
//     deny verbatim and produces NO record.
//   - SC_R18_EXTENSION_ESCALATION_REQUIRES_POLICY (AC3, negative):
//     `evaluateRegisteredExtensionCapability` grants a capability IN the record's
//     grant; a capability OUTSIDE the grant is an escalation reusing R2-1's
//     `evaluateExtensionGrant` — denied unless policy=allow + provenance + a
//     valid W10 approval are ALL present; out-of-enum fails closed; a denial
//     grants NOTHING.
//
// Composes ONLY already-GREEN modules — no rewrite of prior behavior. PURE and
// deterministic: the only non-determinism is the injected `deps.idSeq`/`clock`
// (no wall-clock/RNG/network/fs). NEVER writes flow state — the record
// is the persisted (returned) form; the parent owns any durable write. Optional
// fields are passed via conditional spread to respect `exactOptionalPropertyTypes`.
import { childProvenance } from "../child/isolation";
import type { ApprovalCheckInput, checkApproval } from "../mutation/approval";
import type { Provenance } from "../session/types";
import { evaluateExtensionGrant } from "./execute";
import { registerExtension } from "./registry";
import type { RegisterExtensionInput } from "./registry";

/**
 * The persisted (returned) form of a successfully registered extension: its
 * pinned manifest hash, its grant id, an EXACT copy of the granted capabilities
 * (never a superset), and a derived-trust {@link Provenance} taint-linked to the
 * registration parent.
 */
export interface ExtensionProvenanceRecord {
  extensionId: string;
  /** == `input.manifest.manifestHash` (the pinned hash). */
  manifestHash: string;
  /** == `input.capabilityGrant.grantId`. */
  grantId: string;
  /** EXACTLY a fresh copy of `input.capabilityGrant.capabilities`. */
  capabilities: string[];
  /** W7 shape; `trustLevel:"derived"` (via W12 `childProvenance`). */
  provenance: Provenance;
}

/** Injected, deterministic dependencies for {@link registerExtensionWithProvenance}. */
export interface RegisterExtensionWithProvenanceDeps {
  idSeq: () => string;
  clock: () => string;
  /** Parent provenance the derived record provenance is taint-linked to. */
  registrationProvenance?: Provenance;
}

/**
 * A deterministic root provenance used when no `registrationProvenance` is
 * injected, so the derived record provenance is still parent-linked and
 * `childProvenance`-shaped. Trusted (the registry is the harness's own trusted
 * surface); no clock/RNG.
 */
const DEFAULT_REGISTRATION_PROVENANCE: Provenance = {
  provenanceId: "harness-extension-registry-root",
  trustLevel: "trusted",
  sourceKind: "harness-extension-registry",
};

/**
 * Compose the W15 {@link registerExtension} and, on success, persist an
 * {@link ExtensionProvenanceRecord}.
 *
 * Fail-closed: a denied registration (missing pinned manifest / empty grant) is
 * propagated VERBATIM as `{ok:false;reason}` with NO `record` key. On success
 * the record's `capabilities` is a FRESH COPY of the grant's array (mutating the
 * original grant afterward never affects the record; authority is not widened),
 * and its `provenance` is `childProvenance(deps.registrationProvenance ?? root)`
 * (`trustLevel:"derived"`, `provenanceId === deps.idSeq()`'s first value).
 * Deterministic; does not mutate `input`; writes no flow state.
 */
export function registerExtensionWithProvenance(
  input: RegisterExtensionInput,
  deps: RegisterExtensionWithProvenanceDeps,
): { ok: true; record: ExtensionProvenanceRecord } | { ok: false; reason: string } {
  const registration = registerExtension(input);
  if (registration.ok === false) {
    // Propagate the registry's deny verbatim — NO record key at all.
    return { ok: false, reason: registration.reason };
  }

  // Registry only returns ok when both are present + well-formed; guard anyway
  // to fail closed rather than emit a partial record on any narrowing surprise.
  const { manifest, capabilityGrant } = input;
  if (manifest === undefined || capabilityGrant === undefined) {
    return {
      ok: false,
      reason: "Extension provenance denied: a pinned manifest and capability grant are required.",
    };
  }

  const parent = deps.registrationProvenance ?? DEFAULT_REGISTRATION_PROVENANCE;
  const provenance = childProvenance(parent, { idSeq: deps.idSeq });

  const record: ExtensionProvenanceRecord = {
    extensionId: input.extensionId,
    manifestHash: manifest.manifestHash,
    grantId: capabilityGrant.grantId,
    // FRESH COPY — never the grant's array reference, never a superset.
    capabilities: [...capabilityGrant.capabilities],
    provenance,
  };

  return { ok: true, record };
}

/** Inputs to {@link evaluateRegisteredExtensionCapability}. */
export interface EvaluateRegisteredExtensionCapabilityInput {
  record: ExtensionProvenanceRecord;
  requestedCapability: string;
  policyDecision?: "allow" | "ask" | "deny";
  provenance?: Provenance;
  approval?: ApprovalCheckInput;
}

/** Injected W10 approval check for {@link evaluateRegisteredExtensionCapability}. */
export interface EvaluateRegisteredExtensionCapabilityDeps {
  checkApproval: typeof checkApproval;
}

/**
 * Decide whether a registered extension may exercise `requestedCapability`,
 * reusing R2-1's {@link evaluateExtensionGrant} bounded to the record's grant.
 *
 * In-grant -> `{ok:true}`. Out-of-grant (escalation) -> denied unless
 * `policyDecision === "allow"` + a defined `provenance` + a valid `approval` are
 * ALL present (each missing piece independently denies, naming the piece);
 * `"deny"`/`"ask"`/no policy never silently grants. An out-of-enum capability
 * fails closed. A denial carries NOTHING beyond `{ok:false;reason}`. All of this
 * behavior is inherited unchanged from `evaluateExtensionGrant`.
 */
export function evaluateRegisteredExtensionCapability(
  input: EvaluateRegisteredExtensionCapabilityInput,
  deps: EvaluateRegisteredExtensionCapabilityDeps,
): { ok: true } | { ok: false; reason: string } {
  return evaluateExtensionGrant(
    {
      grantedCapabilities: input.record.capabilities,
      requestedCapabilities: [input.requestedCapability],
      // Conditional spread — only pass optional fields when defined
      // (exactOptionalPropertyTypes).
      ...(input.policyDecision !== undefined ? { policyDecision: input.policyDecision } : {}),
      ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
      ...(input.approval !== undefined ? { approval: input.approval } : {}),
    },
    { checkApproval: deps.checkApproval },
  );
}

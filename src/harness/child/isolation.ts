// Child context/session isolation + fail-closed budget and policy inheritance
// (flow 015, W12 / CA-02).
//
// Pure, deterministic building blocks a PARENT uses to derive a bounded child:
//   - `inheritBudget`  — a child budget reservation is granted only when it is
//     provably a subset of the parent's remaining budget; any excess is DENIED,
//     never clamped up or silently granted (fail-closed).
//   - `inheritPolicy`  — a child policy profile is granted only when it is not
//     broader than the parent's on ANY of three layers: `trustMode`
//     (`read-only < trusted-local < untrusted`), per-capability default
//     (`deny < ask < allow`, checked UNCONDITIONALLY), and
//     `requiredControls.isolation` (never downgraded); any escalation — or an
//     unrecognized/out-of-enum profile value — is DENIED (fail-closed).
//   - `childProvenance` — derives a `derived`-trust child provenance that carries
//     the parent's provenance (plus its prior taints) so the parent link is
//     inspectable.
//
// Nothing here reads a clock/RNG, opens a socket, touches the filesystem, or
// writes flow state — a child NEVER owns completion. Non-determinism is confined
// to the injected `deps.idSeq`. Optional fields are set via conditional spread to
// respect `exactOptionalPropertyTypes`.
import type { PolicyProfile, PolicyProfileDefaults, PolicyProfileRequiredControls } from "../policy/types";
import type { Provenance } from "../session/types";

/** A concrete, granted (or requested) child budget reservation. */
export interface BudgetReservation {
  reservationId: string;
  maxRuntimeMs: number;
  maxToolCalls?: number;
}

/** The parent's currently-remaining budget a child request is measured against. */
export interface ParentRemainingBudget {
  maxRuntimeMs: number;
  maxToolCalls?: number;
}

/** Result of {@link inheritBudget}: a granted reservation or a fail-closed denial. */
export type InheritBudgetResult =
  | { ok: true; reservation: BudgetReservation }
  | { ok: false; reason: string };

/**
 * Fail-closed budget inheritance. Grants the child's requested reservation only
 * when it fits WITHIN the parent's remaining budget (boundary-equal is allowed).
 *
 * - `maxRuntimeMs` must be `<=` the parent's remaining runtime.
 * - `maxToolCalls`, when the child requests one, must be `<=` the parent's
 *   remaining tool-call budget; if the parent exposes no tool-call budget, a
 *   child that requests one cannot be proven a subset and is DENIED.
 * - A child that OMITS `maxToolCalls` is judged on runtime alone and never
 *   receives an implicit unlimited tool-call grant — the reservation simply
 *   carries no cap, which the parent enforces during aggregate accounting.
 *
 * Aggregate accounting across multiple children is the CALLER's responsibility:
 * it decrements `parentRemaining` by each granted reservation before requesting
 * the next, so a later request fails closed once the parent's original budget
 * would be breached in aggregate. This function never clamps up.
 */
export function inheritBudget(
  parentRemaining: ParentRemainingBudget,
  childRequest: BudgetReservation,
): InheritBudgetResult {
  if (childRequest.maxRuntimeMs > parentRemaining.maxRuntimeMs) {
    return {
      ok: false,
      reason: `child maxRuntimeMs ${childRequest.maxRuntimeMs} exceeds parent remaining ${parentRemaining.maxRuntimeMs}`,
    };
  }

  if (childRequest.maxToolCalls !== undefined) {
    if (parentRemaining.maxToolCalls === undefined) {
      return {
        ok: false,
        reason: `child requests ${childRequest.maxToolCalls} tool calls but the parent exposes no tool-call budget to inherit`,
      };
    }
    if (childRequest.maxToolCalls > parentRemaining.maxToolCalls) {
      return {
        ok: false,
        reason: `child maxToolCalls ${childRequest.maxToolCalls} exceeds parent remaining ${parentRemaining.maxToolCalls}`,
      };
    }
  }

  const reservation: BudgetReservation = {
    reservationId: childRequest.reservationId,
    maxRuntimeMs: childRequest.maxRuntimeMs,
    ...(childRequest.maxToolCalls !== undefined ? { maxToolCalls: childRequest.maxToolCalls } : {}),
  };
  return { ok: true, reservation };
}

/** Result of {@link inheritPolicy}: the child's own profile or a fail-closed denial. */
export type InheritPolicyResult =
  | { ok: true; policy: PolicyProfile }
  | { ok: false; reason: string };

/** Capability ordering of the three trust postures (broader = higher rank). */
const TRUST_RANK: Record<PolicyProfile["trustMode"], number> = {
  "read-only": 0,
  "trusted-local": 1,
  untrusted: 2,
};

/** Permissiveness ordering of the three outcomes (`deny < ask < allow`). */
const OUTCOME_RANK: Record<PolicyProfileDefaults[keyof PolicyProfileDefaults], number> = {
  deny: 0,
  ask: 1,
  allow: 2,
};

const CAPABILITY_KEYS: readonly (keyof PolicyProfileDefaults)[] = [
  "read",
  "write",
  "shell",
  "network",
  "delegate",
];

/**
 * Strength ordering of the isolation control (`not-required < required-fail-closed`).
 * A child may only KEEP or STRENGTHEN isolation; downgrading
 * `required-fail-closed` -> `not-required` is a fail-open and is DENIED.
 */
const ISOLATION_RANK: Record<PolicyProfileRequiredControls["isolation"], number> = {
  "not-required": 0,
  "required-fail-closed": 1,
};

/**
 * Resolve a rank, failing CLOSED on an out-of-enum value. The inputs are typed
 * `PolicyProfile`, but a malformed profile that somehow bypassed schema
 * validation must not silently skip a comparison (`undefined > n` is `false`,
 * which would fail OPEN) — `undefined` here forces the caller to DENY.
 */
function rankOf<K extends string>(map: Record<K, number>, value: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(map, value) ? (map as Record<string, number>)[value] : undefined;
}

/**
 * Fail-closed, three-layer policy inheritance. Grants the child's requested
 * profile (unchanged) only when it does NOT escalate beyond the parent on ANY
 * layer:
 *
 *   1. `trustMode` — the child's trust posture must not be broader than the
 *      parent's (`read-only < trusted-local < untrusted`).
 *   2. per-capability `defaults` — no capability default may be more permissive
 *      than the parent's for the same key (`deny < ask < allow`). This check is
 *      UNCONDITIONAL: it runs regardless of the trust-rank relationship. A
 *      strictly-narrower trust mode does NOT license a per-capability
 *      escalation — a "narrower" child that is nonetheless MORE permissive on a
 *      concrete capability than its parent's policy allows would gain authority
 *      the parent forbids (SC_R08_ROLE_CANNOT_ESCALATE / ADR-0004; a child role
 *      cannot grant itself more authority). Fail-closed: it must be contained on
 *      every capability.
 *   3. `requiredControls.isolation` — the child's isolation must be no weaker
 *      than the parent's; a `required-fail-closed` parent can never be
 *      downgraded to `not-required` by its child.
 *
 * A child that is contained on all three layers is granted. Any escalation on
 * any layer is DENIED. `role` is intentionally not a parameter — a child can
 * never claim broader authority than its profile encodes.
 */
export function inheritPolicy(parent: PolicyProfile, childRequest: PolicyProfile): InheritPolicyResult {
  const childTrust = rankOf(TRUST_RANK, childRequest.trustMode);
  const parentTrust = rankOf(TRUST_RANK, parent.trustMode);
  if (childTrust === undefined || parentTrust === undefined) {
    return {
      ok: false,
      reason: `unrecognized trustMode (child "${childRequest.trustMode}", parent "${parent.trustMode}")`,
    };
  }

  if (childTrust > parentTrust) {
    return {
      ok: false,
      reason: `child trustMode "${childRequest.trustMode}" is broader than parent "${parent.trustMode}"`,
    };
  }

  // Per-capability containment is UNCONDITIONAL — it is NOT gated on equal trust
  // rank. A strictly-narrower trust mode is never treated as an implicit
  // containment of the concrete capability defaults; each capability must
  // independently be no more permissive than the parent's, or the child would
  // escalate authority the parent's policy denies (fail-closed).
  for (const capability of CAPABILITY_KEYS) {
    const childOutcome = childRequest.defaults[capability];
    const parentOutcome = parent.defaults[capability];
    const childRank = rankOf(OUTCOME_RANK, childOutcome);
    const parentRank = rankOf(OUTCOME_RANK, parentOutcome);
    if (childRank === undefined || parentRank === undefined) {
      return {
        ok: false,
        reason: `unrecognized capability outcome for "${capability}" (child "${childOutcome}", parent "${parentOutcome}")`,
      };
    }
    if (childRank > parentRank) {
      return {
        ok: false,
        reason: `child capability "${capability}" default "${childOutcome}" is more permissive than parent "${parentOutcome}"`,
      };
    }
  }

  // Isolation may only be kept or strengthened, never downgraded.
  const childIsolation = rankOf(ISOLATION_RANK, childRequest.requiredControls.isolation);
  const parentIsolation = rankOf(ISOLATION_RANK, parent.requiredControls.isolation);
  if (childIsolation === undefined || parentIsolation === undefined) {
    return {
      ok: false,
      reason: `unrecognized isolation control (child "${childRequest.requiredControls.isolation}", parent "${parent.requiredControls.isolation}")`,
    };
  }
  if (childIsolation < parentIsolation) {
    return {
      ok: false,
      reason: `child isolation "${childRequest.requiredControls.isolation}" is weaker than parent "${parent.requiredControls.isolation}"`,
    };
  }

  return { ok: true, policy: childRequest };
}

/** Injected dependencies for {@link childProvenance}: a monotonic id source. */
export interface ChildProvenanceDeps {
  idSeq: () => string;
}

/**
 * Derive a child {@link Provenance} from the parent's. The child is marked
 * `trustLevel: "derived"`, receives a fresh `provenanceId` from `deps.idSeq()`,
 * and carries the parent's `provenanceId` (appended after any taints the parent
 * already carried) in `taintIds`, so the child->parent link stays inspectable.
 * Pure aside from `deps.idSeq()`.
 */
export function childProvenance(parent: Provenance, deps: ChildProvenanceDeps): Provenance {
  const taintIds = [...(parent.taintIds ?? []), parent.provenanceId];
  const provenance: Provenance = {
    provenanceId: deps.idSeq(),
    trustLevel: "derived",
    sourceKind: parent.sourceKind,
    taintIds,
  };
  if (parent.sourceHash !== undefined) {
    provenance.sourceHash = parent.sourceHash;
  }
  return provenance;
}

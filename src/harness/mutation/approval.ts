// Single-use approval request/result + fail-closed approval check (flow 013,
// W10 / M-01, reviewer track: security).
//
// `ApprovalRequest`/`ApprovalResult` mirror the frozen
// `approval-request.schema.json` / `approval-result.schema.json` wire shapes.
// `checkApproval` resolves whether a recorded approval still authorizes the
// current action. It is deterministic and side-effect-free (clock arrives as
// the `now` input; NO `Date.now`/`Math.random`/network/fs) and FAIL-CLOSED at
// every branch: only a fresh, matching, unconsumed, unexpired, interactive
// `approved` decision is ever `{ kind: "valid" }`; every other state — missing
// result, rejected, expired, invalidated, consumed, stale fingerprint, elapsed
// window, or headless session — is invalid (AC1, SC_R05_STALE_APPROVAL,
// SC_R05_HEADLESS_ASK).
import type { CausalIds } from "../tool/types";

/**
 * Policy binding tying an approval to the exact action, policy, and provenance
 * (`harness-envelope.schema.json#/$defs/policyBinding`).
 */
export interface ApprovalBinding {
  policyProfileId: string;
  policyFingerprint: string;
  actionFingerprint: string;
  provenanceId: string;
}

/**
 * A single-use approval proposal (`approval-request.schema.json`). `status` is
 * the frozen `const "pending"` — an approval never carries any other status on
 * the wire; all invalidation is computed at check-time by {@link checkApproval},
 * never read off a stored status field.
 */
export interface ApprovalRequest {
  schemaVersion: number;
  approvalId: string;
  toolCallId: string;
  causal: CausalIds;
  binding: ApprovalBinding;
  toolId: string;
  toolVersion: string;
  inputHash: string;
  requestedAt: string;
  expiresAt: string;
  status: "pending";
  justification?: string;
}

/**
 * The four approval decisions (`approval-result.schema.json#/properties/decision`).
 * `"approved"` is the ONLY decision that can ever authorize execution; the
 * other three are non-authorizing.
 */
export type ApprovalDecision = "approved" | "rejected" | "expired" | "invalidated";

/**
 * A single-use approval outcome (`approval-result.schema.json`). The wire record
 * additionally carries `consumedAt` (required when `approved`) and `reason`
 * (required when `rejected`/`expired`/`invalidated`); those are schema-declared
 * fields read through a widened view at the call boundary and are intentionally
 * NOT part of this pinned in-memory shape.
 */
export interface ApprovalResult {
  schemaVersion: number;
  approvalResultId: string;
  approvalId: string;
  binding: ApprovalBinding;
  decision: ApprovalDecision;
  actorId: string;
  decidedAt: string;
}

/** The reasons an approval fails closed. */
export type ApprovalInvalidReason = "denied" | "expired" | "stale" | "consumed" | "headless";

/**
 * The result of {@link checkApproval}: either the approval is `valid` (safe to
 * execute exactly once) or it is `invalid` with the fail-closed reason.
 */
export type ApprovalCheck =
  | { kind: "valid" }
  | { kind: "invalid"; reason: ApprovalInvalidReason };

/** Inputs to a single approval check. `result` is absent until a decision is recorded. */
export interface ApprovalCheckInput {
  request: ApprovalRequest;
  result: ApprovalResult | undefined;
  currentFingerprint: string;
  now: string;
  interactive: boolean;
  consumed: boolean;
}

function invalid(reason: ApprovalInvalidReason): ApprovalCheck {
  return { kind: "invalid", reason };
}

/**
 * Decide whether a recorded approval still authorizes the current action.
 *
 * Fail-closed precedence (every non-`approved`/degraded state is invalid):
 *   a. no recorded result                          -> denied
 *   b. decision `rejected`                          -> denied
 *   c. decision `expired`                           -> expired
 *   d. decision `invalidated`                       -> stale
 *   e. approved AND already consumed (single-use)   -> consumed
 *   f. approved AND fingerprint changed             -> stale
 *   g. approved AND now >= expiresAt                -> expired
 *   h. approved AND non-interactive (headless)      -> headless
 *   i. otherwise                                    -> valid
 */
export function checkApproval(input: ApprovalCheckInput): ApprovalCheck {
  const { request, result, currentFingerprint, now, interactive, consumed } = input;

  // (a) No recorded decision never authorizes.
  if (result === undefined) return invalid("denied");

  // (b)-(d) A non-`approved` decision is terminal and non-authorizing.
  switch (result.decision) {
    case "rejected":
      return invalid("denied");
    case "expired":
      return invalid("expired");
    case "invalidated":
      return invalid("stale");
    case "approved":
      break;
    default:
      // Exhaustiveness / fail-closed guard: an unknown decision never authorizes.
      return invalid("denied");
  }

  // (e) Single-use: a consumed grant never re-authorizes.
  if (consumed) return invalid("consumed");

  // (f) Stale: the action fingerprint changed after the grant.
  if (request.inputHash !== currentFingerprint) return invalid("stale");

  // (g) Expired: the approval window has elapsed (inclusive at expiresAt).
  //     Fail-closed on an unparseable `now` OR `expiresAt`: `Date.parse` yields
  //     NaN, and `NaN >= NaN` is `false`, which would otherwise silently
  //     fall through to `{ kind: "valid" }` (a fail-OPEN). Treat NaN as
  //     expired (AC2). Parseable timestamps behave exactly as before.
  const nowMs = Date.parse(now);
  const expiresMs = Date.parse(request.expiresAt);
  if (Number.isNaN(nowMs) || Number.isNaN(expiresMs)) return invalid("expired");
  if (nowMs >= expiresMs) return invalid("expired");

  // (h) Headless: an approval-gated action never executes unattended.
  if (interactive === false) return invalid("headless");

  // (i) Fresh, matching, unconsumed, unexpired, interactive approval.
  return { kind: "valid" };
}

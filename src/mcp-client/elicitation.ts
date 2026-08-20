// Elicitation correlation, decision building, and the T9 classifier seam
// (flow 182, T8; AC3, AC5, AC9). Package: docs/requirements/keryx-mcp-client
// specification.md §4, §9; plan.md step 4.
//
// Pure and total, like `wire.ts` — no SDK, no process, no clock. Everything
// here operates on data already extracted from the wire.
import { extractCodexCallId, isExecApprovalRequestEvent } from "./wire";
import type {
  ElicitationRiskClassification,
  ElicitationResponsePayload,
  PendingElicitation,
  RawCodexEventNotification,
  RawElicitationRequest,
} from "./types";

/** Whether, and with what decision vocabulary, a pending elicitation was correlated. */
export type CorrelationResult =
  | { readonly kind: "correlated"; readonly availableDecisions: readonly string[] }
  | { readonly kind: "uncorrelated" };

/**
 * Correlate a pending elicitation with its sibling `codex/event`
 * (`exec_approval_request`), by `call_id` (T5 live probe finding).
 *
 * `uncorrelated` covers every reason a decision vocabulary cannot be
 * resolved: no `codex_call_id` on the elicitation at all, no matching
 * `codex/event` seen, or one seen with an empty `available_decisions` — all
 * three are, per the live probe, the real manifestation of AC5's
 * "malformed/empty content" defense: there is no schema-based signal for
 * correctness (`requestedSchema` is always the trivial empty object), so
 * correctness is entirely this correlation.
 */
export function correlateElicitation(
  callId: string | undefined,
  recentEvents: ReadonlyMap<string, RawCodexEventNotification>,
): CorrelationResult {
  if (callId === undefined) return { kind: "uncorrelated" };
  const event = recentEvents.get(callId);
  if (event === undefined) return { kind: "uncorrelated" };
  if (!isExecApprovalRequestEvent(event)) return { kind: "uncorrelated" };
  const availableDecisions = event.availableDecisions;
  if (availableDecisions === undefined || availableDecisions.length === 0) return { kind: "uncorrelated" };
  return { kind: "correlated", availableDecisions };
}

/**
 * Pick the best "approve" value from a request's own `available_decisions`.
 * `"approved"` is the exact value the T5 live probe confirmed valid; the
 * fuzzy fallback covers a differently-worded but still-approving vocabulary
 * on a future codex build without hardcoding a second literal.
 */
export function pickApproveDecision(availableDecisions: readonly string[]): string | undefined {
  return availableDecisions.find((d) => d === "approved") ?? availableDecisions.find((d) => /approv/i.test(d));
}

/**
 * Pick the best "deny" value. `"abort"` is preferred over `"denied"`
 * deliberately: the T5 live probe confirmed `"abort"` valid for the
 * exec-approval case and explicitly found `"denied"` is NOT always a valid
 * value, so it must not be the first choice.
 */
export function pickDenyDecision(availableDecisions: readonly string[]): string | undefined {
  return (
    availableDecisions.find((d) => d === "abort") ??
    availableDecisions.find((d) => d === "denied") ??
    availableDecisions.find((d) => /deny|denied|reject|abort/i.test(d))
  );
}

/** What `resolveApprovalDecision` + (optionally) the operator resolved this elicitation to. */
export type ElicitationVerdict = "approve" | "deny";

/**
 * Build the exact `{action, decision}` payload codex's own
 * `ExecApprovalResponse` deserializer reads (T5 live probe finding) — NOT
 * the standard MCP `ElicitResult.content` shape.
 *
 * An uncorrelated elicitation always declines WITHOUT a `decision` field,
 * regardless of `verdict`: there is no `available_decisions` list to choose
 * a safe value from, and guessing one is exactly what AC5 exists to forbid.
 * A correlated elicitation whose vocabulary contains no recognisable
 * approve/deny value also declines without a `decision`, for the same
 * reason — the vocabulary was seen but not understood.
 */
export function buildElicitationResponse(
  verdict: ElicitationVerdict,
  correlation: CorrelationResult,
): ElicitationResponsePayload {
  if (correlation.kind === "uncorrelated") {
    return { action: "decline" };
  }

  if (verdict === "approve") {
    const decision = pickApproveDecision(correlation.availableDecisions);
    return decision === undefined ? { action: "decline" } : { action: "accept", decision };
  }

  const decision = pickDenyDecision(correlation.availableDecisions);
  return decision === undefined ? { action: "decline" } : { action: "decline", decision };
}

/** Build the classifier's pure input from a raw wire request. */
export function toPendingElicitation(request: RawElicitationRequest): PendingElicitation {
  return {
    requestId: request.requestId,
    callId: extractCodexCallId(request),
    message: request.message,
    vendor: request.vendor,
  };
}

/**
 * T9's seam: the elicitation-payload analog of `classifyPatchRisk`
 * (`src/lib/patch-risk.ts`) — deriving `destructive`/`credentials` from
 * whatever detail codex's elicitation payload carries about the intended
 * action, feeding `resolveApprovalDecision` exactly like `write`'s own
 * escalation classifier does (ADR-0010).
 *
 * DELIBERATE PLACEHOLDER (T6-T8 scope; the real classifier is T9's job,
 * per AC9). Always returns the least-escalated verdict. The seam itself is
 * real and typed so T9 can replace this function's body without touching
 * `supervise-mcp.ts`'s call site.
 */
export function classifyElicitationRisk(_pending: PendingElicitation): ElicitationRiskClassification {
  return { destructive: false, credentials: false };
}

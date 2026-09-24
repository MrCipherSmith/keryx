// The permission mapping between ACP's `session/request_permission` and
// keryx's approval gate (flow 285, T9 — AC3).
//
// Two shapes have to meet here and they do not agree on anything:
//
//   ACP     `outcome: { outcome: "selected", optionId } | { outcome: "cancelled" }`,
//           where a DENIAL is a selected option whose `kind` is `reject_once` /
//           `reject_always`. There is no boolean and no `"denied"` outcome
//           (context.md F-2), and `cancelled` is not an answer at all.
//   keryx   `ApprovalResponse = boolean | { approved, fingerprint? }`
//           (`src/commands/agent.ts`), checked by `isApprovalFor` — an object
//           form must echo the fingerprint it was asked about or it counts as a
//           denial.
//
// The mapping, pinned by `permission.test.ts`:
//
//   allow_once    -> true
//   allow_always  -> { approved: true, fingerprint }   (the only kind with one)
//   reject_once   -> false
//   reject_always -> false
//   cancelled     -> false
//   an optionId keryx never offered -> false
//
// Everything that is not an explicit allow is a denial. That is the whole
// safety property of this file: there is no path from an unrecognised,
// malformed or absent answer to an executed tool call.
//
// Pure: importing this reads nothing and spawns nothing.

import type { ApprovalMeta, ApprovalResponse } from "../commands/agent";
import type {
  AcpPermissionOption,
  AcpPermissionOptionId,
  AcpPermissionOptionKind,
  AcpRequestPermissionOutcome,
  AcpRequestPermissionResponse,
} from "./protocol";

/**
 * Option ids keryx offers.
 *
 * Deliberately equal to the ACP `kind` they carry. The id is opaque to the
 * spec and a client may only echo it back, so making it readable costs nothing
 * and makes a transcript of this wire legible without a lookup table. The
 * mapping below still keys on the `kind` of the option the id resolves to,
 * never on the id's text — a client that echoes a string keryx did not send is
 * denied even if the string looks like an allow.
 */
export const ACP_PERMISSION_OPTION_IDS = {
  allowOnce: "allow_once",
  allowAlways: "allow_always",
  rejectOnce: "reject_once",
  rejectAlways: "reject_always",
} as const;

const OPTION_ALLOW_ONCE: AcpPermissionOption = Object.freeze({
  optionId: ACP_PERMISSION_OPTION_IDS.allowOnce,
  name: "Allow once",
  kind: "allow_once" as AcpPermissionOptionKind,
});

const OPTION_ALLOW_ALWAYS: AcpPermissionOption = Object.freeze({
  optionId: ACP_PERMISSION_OPTION_IDS.allowAlways,
  name: "Always allow",
  kind: "allow_always" as AcpPermissionOptionKind,
});

const OPTION_REJECT_ONCE: AcpPermissionOption = Object.freeze({
  optionId: ACP_PERMISSION_OPTION_IDS.rejectOnce,
  name: "Reject",
  kind: "reject_once" as AcpPermissionOptionKind,
});

const OPTION_REJECT_ALWAYS: AcpPermissionOption = Object.freeze({
  optionId: ACP_PERMISSION_OPTION_IDS.rejectAlways,
  name: "Always reject",
  kind: "reject_always" as AcpPermissionOptionKind,
});

/**
 * True when this call must never be offered an "always" answer.
 *
 * `ApprovalMeta`'s escalation flags are keryx's standing rule for its own
 * approvers: a destructive command, one that touches the agent's own
 * credentials, one under a `git-publish` pause lease, and one authored after
 * untrusted external content entered the turn are "always prompt, never
 * auto-approve from a saved allowlist, never offer always" (ADR-0009, and
 * `ApprovalMeta`'s own doc comments). An ACP client remembers an
 * `allow_always` answer ITSELF and stops asking, which is exactly the saved
 * allowlist that rule forbids — so the option is not offered at all rather
 * than offered and then quietly ignored.
 *
 * Flow 306 fix (review finding 5): `meta.hookAsk` joins the same floor —
 * `ApprovalMeta.hookAsk`'s own doc comment already commits a `PreToolUse`
 * hook's tightened `ask` to "never satisfied from a saved/session allowlist
 * or an 'always allow' grant", the same posture `publishLease` gets here.
 */
export function permissionIsEscalated(meta?: ApprovalMeta): boolean {
  return (
    meta?.destructive === true ||
    meta?.credentials === true ||
    meta?.publishLease === true ||
    meta?.untrustedOrigin === true ||
    meta?.hookAsk === true
  );
}

/**
 * The options keryx offers the client for one gated call.
 *
 * Always at least one allow and one reject: a client that can only cancel has
 * no way to say yes, and a request with no options is unrenderable.
 */
export function permissionOptionsFor(meta?: ApprovalMeta): readonly AcpPermissionOption[] {
  return permissionIsEscalated(meta)
    ? [OPTION_ALLOW_ONCE, OPTION_REJECT_ONCE, OPTION_REJECT_ALWAYS]
    : [OPTION_ALLOW_ONCE, OPTION_ALLOW_ALWAYS, OPTION_REJECT_ONCE, OPTION_REJECT_ALWAYS];
}

/** The `kind` of the offered option this id names, or `undefined` if keryx never offered it. */
function kindOf(
  optionId: AcpPermissionOptionId,
  options: readonly AcpPermissionOption[],
): AcpPermissionOptionKind | undefined {
  return options.find((option) => option.optionId === optionId)?.kind;
}

/**
 * Turns one client answer into the `ApprovalResponse` keryx's gate understands.
 *
 * `fingerprint` is the one `ApprovalMeta` carried for this exact call. It is
 * echoed back only on `allow_always`, which is the single kind that means
 * "this decision outlives the call": binding it to the action is what stops a
 * stale or mis-routed answer from authorising a different command
 * (`isApprovalFor`). `allow_once` answers with a bare `true` — the historical
 * contract, and there is nothing to bind it to beyond the call it is already
 * inline with.
 *
 * NOTE on what keryx does NOT do with `allow_always`: it stores nothing. The
 * "always" lives in the CLIENT, which answers the next identical request
 * without prompting its user. keryx persisting its own allowlist entry from
 * this wire would recreate the exact pattern
 * `memory/lessons/allowlist-not-a-boundary` records — a remembered glob that
 * reads as a grant — for an answer keryx never showed a human itself.
 */
export function approvalFromPermissionResponse(
  response: AcpRequestPermissionResponse,
  options: readonly AcpPermissionOption[],
  fingerprint?: string,
): ApprovalResponse {
  // Typed as `unknown` first on purpose: this value came off a wire, and the
  // declared type is what keryx HOPES arrived, not what it can rely on. A
  // client that sends `{}` or `{ outcome: null }` must be denied, not crash
  // the turn with a property read on undefined.
  const raw: unknown = response.outcome;
  if (typeof raw !== "object" || raw === null) {
    return false;
  }
  const outcome = raw as AcpRequestPermissionOutcome;
  if (outcome.outcome !== "selected") {
    // `cancelled` — and anything else that is not a selection.
    return false;
  }
  switch (kindOf(outcome.optionId, options)) {
    case "allow_once":
      return true;
    case "allow_always":
      return fingerprint === undefined ? true : { approved: true, fingerprint };
    default:
      // Both rejections, and an `optionId` keryx never offered: a client that
      // answers with a string of its own invention has not selected an allow,
      // so it gets the same answer as a rejection. Never a pass.
      return false;
  }
}

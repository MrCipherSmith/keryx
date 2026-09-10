// Whether an MCP tool call may proceed.
//
// P0 item 6. This does NOT implement an approval policy — it routes into the
// one keryx already has. The integration table for this package says it in as
// many words: "Do not invent a parallel approval function." A second policy
// would drift from the first, and the drift would be discovered by someone
// whose file got written without being asked about.
//
// What this file adds is the per-CALL dimension the static tool definition
// cannot carry: `use_tool` is one tool covering every MCP tool on every
// server, so its declared risk is the worst case, and the actual risk of the
// call depends on which tool was named.

import { resolveApprovalDecision, type PermissionMode } from "../commands/permission-mode";

/** The approval prompt, shaped as `agent.ts` already calls it. */
export type McpApprovalRequest = (
  name: string,
  input: Record<string, unknown>,
  meta: { fingerprint: string; destructive: boolean },
) => Promise<unknown>;

export type McpApprovalDeps = {
  readonly mode: PermissionMode;
  /** Absent means headless. See {@link approveMcpCall}. */
  readonly requestApproval?: McpApprovalRequest | undefined;
  /** Injected so this module does not import `agent.ts`, which imports it. */
  readonly fingerprint: (name: string, input: Record<string, unknown>) => string;
  readonly isApprovalFor: (response: unknown, fingerprint: string) => boolean;
};

export type McpApprovalOutcome =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * Decide, then ask if deciding says to.
 *
 * Three arms, and the third is the one that turns a prompt into a bypass:
 *
 *   ask mode, write-shaped tool   -> the operator is asked
 *   trust mode, destructive       -> the operator is STILL asked
 *   headless (no requestApproval) -> DENIED, never auto-approved
 *
 * The headless arm is fail-closed for the reason the `delegate` branch in
 * `agent.ts` gives for its own: a call that proceeds because nobody was
 * present to object has not been approved, and an approval mechanism that
 * returns "yes" when unattended is not one.
 *
 * The fingerprint is checked, not just the boolean. An affirmative response
 * that belongs to a DIFFERENT call is not consent to this one — which is what
 * `isApprovalFor` exists to establish, and why it is required here rather
 * than optional.
 */
export async function approveMcpCall(
  fqn: string,
  args: Record<string, unknown>,
  risk: "read" | "destructive",
  deps: McpApprovalDeps,
): Promise<McpApprovalOutcome> {
  const decision = resolveApprovalDecision({
    mode: deps.mode,
    risk,
    destructive: risk === "destructive",
    credentials: false,
    sacReviewConfirmation: false,
  });

  if (decision === "auto") {
    return { allowed: true };
  }

  if (deps.requestApproval === undefined) {
    return {
      allowed: false,
      reason: `"${fqn}" needs approval and there is no one to ask (headless). Not called.`,
    };
  }

  const fingerprint = deps.fingerprint(fqn, args);
  const response = await deps.requestApproval(fqn, args, { fingerprint, destructive: risk === "destructive" });
  return deps.isApprovalFor(response, fingerprint)
    ? { allowed: true }
    : { allowed: false, reason: `"${fqn}" was not approved by the operator. Not called.` };
}

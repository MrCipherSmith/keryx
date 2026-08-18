// Permission-mode decision layer for the interactive agent session (TUI +
// headless `keryx shell`). Sits ABOVE `executeCall`'s existing risk gate
// (agent.ts) and `AgentIO.requestApproval` — it decides whether that gate is
// even consulted, never replaces it. Deliberately out of scope: the MCP
// dispatch path (`src/mcp/`) and the formal `harness/policy`/`harness/mutation`
// evidence engine (profiles, `checkApproval`, ADR-0003's frozen
// `override: false`) — both keep their own, stricter, always-ask-or-deny
// posture untouched.
//
// The mode itself must only ever be set by an explicit user action (CLI flag,
// config-dir default, `/mode` command) — never from tool or model output.
// `src/harness/child/quarantine.ts` already treats `permissionMode` /
// `bypassPermissions` appearing in subagent free text as an injection marker;
// this module gives that vocabulary a real, host-only home.

/** The three user-selectable postures for the interactive session. */
export type PermissionMode = "ask" | "trust" | "auto";

export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "trust", "auto"];

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

/** The default posture: unchanged current behavior for anyone who never opts in. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "ask";

/**
 * The risk classes `executeCall` actually reaches this gate for. `write` /
 * `network` / `credential` are declared by {@link ToolRisk} but hard-denied
 * unconditionally today regardless of approver or mode (agent.ts's final
 * `else if (risk !== "read")` branch) — not this layer's concern.
 */
export type GatedToolRisk = "read" | "shell" | "destructive" | "delegate";

export interface ApprovalGateInput {
  mode: PermissionMode;
  risk: GatedToolRisk;
  /**
   * Per-command escalation (`isDestructiveCommand`/tool's own static
   * `risk === "destructive"`) — mirrors `ApprovalMeta.destructive`.
   */
  destructive: boolean;
  /**
   * The action touches the agent's own credential/permission files
   * (`touchesAgentCredentials`) — mirrors `ApprovalMeta.credentials`.
   */
  credentials: boolean;
  /**
   * The action touches SAC's proposal-review/confirm-token family
   * (`touchesSacConfirmReview`, `src/lib/command-risk.ts`) — accepting a
   * proposal requires a human to answer a real approval prompt for
   * `keryx workspace confirm-review`; that guarantee lives entirely in the
   * prompt firing, so this is a second, independent hard floor alongside
   * `credentials`, not a variant of it.
   */
  sacReviewConfirmation: boolean;
}

export type ApprovalGateDecision = "auto" | "ask";

/**
 * Decide whether an action proceeds without prompting, or still needs
 * `AgentIO.requestApproval`.
 *
 * `credentials` and `sacReviewConfirmation` are hard floors that no mode
 * lifts — `ApprovalMeta`'s own docstring already commits to this for the
 * existing shell "remember" path ("never auto-approved and never
 * remembered, whatever the user picks"); an action that can hand the agent
 * authority it did not have, or that exists specifically to prove a human
 * is present, gets the same floor here, including under `auto`. Every other
 * axis follows the mode:
 *
 *   - `ask`   — unchanged today's behavior; only `read` skips the prompt.
 *   - `trust` — auto-approve unless the action is `destructive` (static risk
 *     or per-command escalation); a destructive action still asks.
 *   - `auto`  — bypass the prompt for everything except `credentials`. This
 *     is the deliberately dangerous mode (mirrors Claude Code's
 *     `bypassPermissions` / grok-build's yolo mode) — the caller is
 *     responsible for the one-time confirmation + persistent banner before
 *     any action is skipped under it.
 */
export function resolveApprovalDecision(input: ApprovalGateInput): ApprovalGateDecision {
  const { mode, risk, destructive, credentials, sacReviewConfirmation } = input;

  if (risk === "read") {
    return "auto";
  }

  if (credentials || sacReviewConfirmation) {
    return "ask";
  }

  if (mode === "auto") {
    return "auto";
  }

  if (mode === "trust") {
    const isDestructive = risk === "destructive" || destructive;
    return isDestructive ? "ask" : "auto";
  }

  return "ask";
}

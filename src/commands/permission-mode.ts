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
 * The risk classes `executeCall` actually reaches this gate for. `network` /
 * `credential` are declared by {@link ToolRisk} but hard-denied
 * unconditionally today regardless of approver or mode (agent.ts's final
 * `else if (risk !== "read")` branch) — not this layer's concern. `write`
 * joined this gate in ADR-0010 (`apply_patch`): it is approval-gated exactly
 * like `shell`/`destructive`, with its own escalation classifier
 * (`src/lib/patch-risk.ts`) supplying `destructive`/`credentials`.
 */
export type GatedToolRisk = "read" | "shell" | "destructive" | "delegate" | "write";

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
 *     or per-action escalation — per-command for `shell`/`destructive`,
 *     per-patch-target for `write`); a destructive action still asks.
 *   - `auto`  — bypass the prompt for everything except `credentials`. This
 *     is the deliberately dangerous mode (mirrors Claude Code's
 *     `bypassPermissions` / grok-build's yolo mode) — the caller is
 *     responsible for the one-time confirmation + persistent banner before
 *     any action is skipped under it.
 */
/**
 * Who answers a question the MODEL asks the human (`ask_user`)?
 *
 * A SEPARATE axis from {@link resolveApprovalDecision}, deliberately, and not a
 * variant of it. That function decides whether a mutating action may run; this
 * one decides who answers a question about what to DO. Merging them would put
 * questions under the security gate and let `auto` self-approve destructive
 * actions as a side effect — the two are different authorities and the whole
 * reason `ask_user` is `risk: "read"` is that asking is not acting.
 *
 * The three modes map as:
 *
 *   - `ask`   — the human answers. Unchanged.
 *   - `trust` — the human answers. `trust` is a statement about ACTIONS
 *     ("do not interrupt me for a command I would have approved"), never about
 *     judgement ("decide for me what to build"). Letting it answer design
 *     questions is the failure this axis exists to name.
 *   - `auto`  — the MODEL answers. This is the mode that already declared it
 *     will act without being asked, so a question put to an absent human is the
 *     one thing left to resolve; it answers and SAYS SO (see
 *     `AgentIO.onQuestionSelfAnswered` — a self-answer the user cannot notice is
 *     a self-answer they cannot object to).
 *
 * The reference implementations agree on the separation: Codex gates
 * `request_user_input` by COLLABORATION mode and refuses it outright in `exec`
 * (`allows_request_user_input`), and OpenCode's `--auto` replies only to
 * `permission.asked` while `question.asked` still waits for a human.
 */
export type QuestionAnswerer = "human" | "self";

/** Resolve {@link QuestionAnswerer} for a mode. Pure; no host inspection. */
export function resolveQuestionAnswerer(mode: PermissionMode): QuestionAnswerer {
  return mode === "auto" ? "self" : "human";
}

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

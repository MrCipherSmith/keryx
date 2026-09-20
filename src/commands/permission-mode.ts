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
// `bypassPermissions` (and, alongside them, `readOnly`/`/plan`) appearing in
// subagent free text as an injection marker; this module gives that
// vocabulary a real, host-only home.

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
  /**
   * Whether the session is in read-only ("plan") mode. This is an axis
   * orthogonal to {@link PermissionMode} — not a 4th mode value. `mode`
   * governs how much confirmation a reachable action needs; `readOnly`
   * governs whether a mutating action is reachable at all. Both are
   * independently settable (e.g. `trust` + `readOnly` together). Set via the
   * `/plan` command; always `false` unless a caller opts in.
   */
  readOnly: boolean;
  /**
   * A `git-publish` pause lease (agent bus, specification §4.3, §4.4) applies
   * to this shell_exec command: `isPublishCommand(command) &&
   * busLeases.appliesToMe("git-publish")`, computed at the `executeCall`
   * shell-branch call site (`src/commands/agent.ts`), never here. A third hard
   * floor alongside {@link credentials} and {@link sacReviewConfirmation}: it
   * forces `ask` in every mode, `auto` included, and never denies on its own
   * (ADR-0009 — a classifier miss never counts as a grant, only ever escalates
   * to a prompt). Optional so every existing `ApprovalGateInput` literal
   * (agent.ts's three call sites, `supervise-mcp.ts`) still compiles
   * unchanged; `undefined` behaves exactly like `false`.
   */
  publishLease?: boolean;
}

export type ApprovalGateDecision = "auto" | "ask" | "deny";

/**
 * Decide whether an action proceeds without prompting, still needs
 * `AgentIO.requestApproval`, or is refused outright.
 *
 * `readOnly` is a hard floor above everything else except `read` risk itself:
 * when the session is read-only, every non-`read` action is denied
 * regardless of `mode`, `destructive`, `credentials`, or
 * `sacReviewConfirmation` — including combinations that would otherwise
 * auto-approve under `trust`/`auto`. This mirrors the same "no mode lifts
 * this" shape `credentials`/`sacReviewConfirmation` already use, just for a
 * different (session-scoped, user-toggled) reason.
 *
 * `credentials`, `sacReviewConfirmation` and `publishLease` are hard floors
 * that no mode lifts — `ApprovalMeta`'s own docstring already commits to this
 * for the existing shell "remember" path ("never auto-approved and never
 * remembered, whatever the user picks"); an action that can hand the agent
 * authority it did not have, that exists specifically to prove a human is
 * present, or that a peer has asked this shell to hold off on publishing,
 * gets the same floor here, including under `auto`. Every other axis follows
 * the mode:
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
export function resolveApprovalDecision(input: ApprovalGateInput): ApprovalGateDecision {
  const { mode, risk, destructive, credentials, sacReviewConfirmation, readOnly, publishLease } = input;

  if (risk === "read") {
    return "auto";
  }

  if (readOnly) {
    return "deny";
  }

  if (credentials || sacReviewConfirmation || publishLease) {
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

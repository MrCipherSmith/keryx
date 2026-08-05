// Unattended posture for the interactive agent (flow 136 / P1.2, defect D2).
//
// `keryx shell` had no way to declare, at launch, that nobody is watching. Every
// mutating tool call went to a human prompt, so a scripted run stalled forever —
// the benchmark completed 0 of 5 cases for this reason alone.
//
// This module supplies the missing declaration WITHOUT supplying a new authority.
// It is deliberately NOT an "approve everything" switch: an unattended run is one
// where the approver is the frozen policy engine instead of a person, evaluated
// with `interactive: false`. That single substitution gives the posture the four
// properties the specification requires, and it gives them by construction rather
// than by a list of special cases:
//
//   | Condition                          | Result                                  |
//   |------------------------------------|-----------------------------------------|
//   | risk pre-declared `allow` in the profile | executes, recorded as unattended   |
//   | `ask` with no approver             | `deny` (engine's headless fail-closed)  |
//   | `deny`                             | terminal, exactly as with no flag       |
//   | destructive / credential class     | refused regardless of the profile       |
//
// The last row is enforced twice on purpose. `decide` already cannot auto-allow a
// destructive action non-interactively (`baseOutcomeFor` never returns `allow`
// for the destructive/credential classes, and `interactive: false` turns the
// resulting `ask` into `deny`), but that is a property of two other functions. A
// future profile edit could quietly change it, and the one property the C1
// benchmark pair demonstrated — keryx stopping before deleting the graph index
// where the same model on an unwrapped agent did not — would be gone with no test
// failing. So the refusal is also asserted here, at the seam the flag introduced.
//
// Pure and deterministic: clock/ids arrive via `PolicyDeps`, nothing is read from
// the filesystem or environment, and no `commands/` module is imported (the
// approver's return type is structural, so the driver's `ApprovalResponse`
// accepts it without this module depending on the driver).

import { decide } from "./engine";
import { isLocalProfileName, type LocalProfileName, resolveLocalProfile } from "./profiles";
import type { PolicyDecision, PolicyDeps } from "./types";
import type { ToolRisk } from "../tool/types";

/** The launch-time flag that declares an unattended run. */
export const UNATTENDED_FLAG = "--unattended";

/**
 * The posture a bare `--unattended` selects.
 *
 * `read-only-review` and not something looser: the flag's job is to stop a
 * scripted read-only run from stalling on a prompt, and read-only is exactly
 * that much authority. Anything that mutates has to be asked for by name
 * (`--unattended=monitored-trusted-local`), because a default nobody typed is a
 * default nobody chose.
 */
export const DEFAULT_UNATTENDED_PROFILE: LocalProfileName = "read-only-review";

/** A declared unattended run and the profile that bounds it. */
export interface UnattendedPosture {
  profile: LocalProfileName;
}

/** Parse outcome: a posture, nothing (flag absent), or a refusal to guess. */
export type UnattendedFlagResult =
  | { kind: "absent" }
  | { kind: "posture"; posture: UnattendedPosture }
  | { kind: "error"; message: string };

/**
 * Parse `--unattended` / `--unattended=<profile>` out of an argv slice.
 *
 * An unknown profile name is an ERROR, never a fallback to the default. Falling
 * back would run a typo'd `--unattended=monitored-trusted-locl` under whatever
 * profile the fallback names, which is the one thing an operator declaring a
 * posture must be able to rely on not happening.
 */
export function parseUnattendedFlag(args: readonly string[]): UnattendedFlagResult {
  let found: string | undefined;
  for (const arg of args) {
    if (arg === UNATTENDED_FLAG) {
      found = "";
    } else if (arg.startsWith(`${UNATTENDED_FLAG}=`)) {
      found = arg.slice(UNATTENDED_FLAG.length + 1);
    }
  }
  if (found === undefined) {
    return { kind: "absent" };
  }
  if (found.length === 0) {
    return { kind: "posture", posture: { profile: DEFAULT_UNATTENDED_PROFILE } };
  }
  if (!isLocalProfileName(found)) {
    return {
      kind: "error",
      message:
        `Unknown ${UNATTENDED_FLAG} profile: ${found}. ` +
        "Use read-only-review, monitored-trusted-local, or unattended-untrusted.",
    };
  }
  return { kind: "posture", posture: { profile: found } };
}

/** The action an unattended approver is asked about. */
export interface UnattendedAction {
  /** The tool's static risk class. */
  risk: ToolRisk;
  /** Per-command escalation: the command reads as destructive. */
  destructive?: boolean;
  /** Per-command escalation: the command touches the agent's own credentials. */
  credentials?: boolean;
  /** Identity of the exact action (tool name + canonical input). */
  actionFingerprint: string;
  /** Path the action targets, for the managed-flow-state guard. */
  targetPath?: string;
}

/**
 * Resolve one unattended action through the frozen policy engine.
 *
 * The escalation is one-way: a destructive or credential-touching command is
 * evaluated as the `destructive`/`credential` class even when the tool's static
 * risk is only `shell`, and the result is forced to `deny` if the engine ever
 * says otherwise.
 */
export function decideUnattended(
  posture: UnattendedPosture,
  action: UnattendedAction,
  deps: PolicyDeps,
): PolicyDecision {
  const escalated: ToolRisk =
    action.credentials === true
      ? "credential"
      : action.destructive === true
        ? "destructive"
        : action.risk;

  const decision = decide(
    { toolCallId: action.actionFingerprint, risk: escalated },
    {
      profile: resolveLocalProfile(posture.profile),
      interactive: false,
      // No approvals: an unattended run has no approver, so there is nobody to
      // have granted one. An `ask` therefore hits the engine's headless
      // fail-closed branch and becomes `deny`.
      approvals: [],
      actionFingerprint: action.actionFingerprint,
      ...(action.targetPath !== undefined ? { targetPath: action.targetPath } : {}),
    },
    deps,
  );

  if (decision.decision === "allow" && (action.destructive === true || action.credentials === true)) {
    return {
      ...decision,
      decision: "deny",
      matchedRules: [...decision.matchedRules, "unattended:destructive-never-auto-approved"],
      reason:
        "A destructive or credential-touching action is never auto-approved under " +
        `${UNATTENDED_FLAG}, whatever the profile allows.`,
    };
  }

  return decision;
}

/**
 * The refusal text handed back to the model when an unattended run declines an
 * action. It names the posture and the reason so the model can change approach
 * instead of retrying the same call into the same wall.
 */
export function unattendedRefusal(posture: UnattendedPosture, decision: PolicyDecision): string {
  return (
    `refused under ${UNATTENDED_FLAG}=${posture.profile}: ${decision.reason ?? "policy denied"} ` +
    "(no operator is present to approve; do not retry — use a read-only tool or report what you need)"
  );
}

/** What an unattended approver answers, matching the driver's object form. */
export interface UnattendedApprovalResponse {
  approved: boolean;
  fingerprint: string;
  /**
   * Why, on a refusal. The driver hands this to the model in place of the generic
   * "not approved by the user" line, because under this posture there was no user
   * — and a model told the wrong reason retries the wrong thing.
   */
  reason?: string;
}

/** Observability hook: every unattended decision, allowed or refused. */
export type UnattendedDecisionSink = (event: {
  tool: string;
  decision: PolicyDecision;
  posture: UnattendedPosture;
}) => void;

/**
 * Build the approver an unattended run installs in place of the human prompt.
 *
 * The returned function has the driver's approver signature, so the driver's
 * default-deny gate, fingerprint binding, and per-command destructive
 * classification all keep working exactly as they do with a person answering —
 * the only thing that changed is who answers.
 */
export function createUnattendedApprover(
  posture: UnattendedPosture,
  deps: PolicyDeps,
  onDecision?: UnattendedDecisionSink,
): (
  tool: string,
  input: string,
  meta?: { fingerprint: string; destructive: boolean; credentials?: boolean; risk?: ToolRisk },
) => Promise<UnattendedApprovalResponse> {
  return async (tool, _input, meta) => {
    // No meta means the caller could not identify the action. An approver that
    // cannot tell what it is approving approves nothing.
    if (meta === undefined) {
      return { approved: false, fingerprint: "" };
    }
    const decision = decideUnattended(
      posture,
      {
        risk: meta.risk ?? "shell",
        destructive: meta.destructive,
        ...(meta.credentials !== undefined ? { credentials: meta.credentials } : {}),
        actionFingerprint: meta.fingerprint,
      },
      deps,
    );
    onDecision?.({ tool, decision, posture });
    const approved = decision.decision === "allow";
    return {
      approved,
      fingerprint: meta.fingerprint,
      ...(approved ? {} : { reason: unattendedRefusal(posture, decision) }),
    };
  };
}

/**
 * The message `ask_user` fails with under an unattended run.
 *
 * `ask_user` is `risk: "read"` — it mutates nothing — so the risk gate lets it
 * through, and it would then block the turn forever waiting for a person. It is
 * an `ask` with no approver by another route, and it resolves the same way.
 */
export const UNATTENDED_ASK_USER_REFUSAL =
  `no operator is present under ${UNATTENDED_FLAG}; ask_user cannot be answered. ` +
  "State the assumption you are making and continue, or stop and report what you needed to ask.";

/** An `ask_user` host for unattended runs: always refuses, never blocks. */
export function unattendedAskUserHost(): Promise<string> {
  return Promise.reject(new Error(UNATTENDED_ASK_USER_REFUSAL));
}

/**
 * The posture label for a surface header (readline and TUI alike).
 * `undefined` — a supervised run — renders nothing: the absence of the marker is
 * the normal case, and a header that labels every run says less than one that
 * labels the unusual one.
 */
export function unattendedHeaderLabel(posture: UnattendedPosture | undefined): string {
  return posture === undefined ? "" : `unattended(${posture.profile})`;
}

/**
 * The posture value stamped into the durable run record (the session summary),
 * so a reader of the evidence can tell an unattended run from a supervised one
 * after the fact. Always present, including for supervised runs — "the field is
 * missing" and "the field says supervised" are not the same claim.
 */
export function postureRecord(posture: UnattendedPosture | undefined): string {
  return posture === undefined ? "supervised" : `unattended:${posture.profile}`;
}

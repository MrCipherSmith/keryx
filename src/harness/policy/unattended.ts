// Unattended posture for the interactive agent (flow 136 / P1.2, defect D2).
//
// `keryx shell` had no way to declare, at launch, that nobody is watching. Every
// mutating tool call went to a human prompt, so a scripted run stalled forever —
// the benchmark completed 0 of 5 cases for this reason alone.
//
// This module supplies the missing declaration WITHOUT supplying a new authority.
// Two independent gates stand between a model's proposal and execution, and a
// command has to pass BOTH:
//
//   1. The frozen policy engine, evaluated with `interactive: false`. That is
//      already the fail-closed path: an `ask` with no approver becomes `deny`, a
//      hard deny stays terminal, and the destructive/credential classes have no
//      `allow` to fall into.
//
//   2. An ALLOWLIST the operator supplies per run (`--unattended-allow`). Nothing
//      runs unless a pattern recognises it.
//
// Gate 2 is the one this module exists for, and the first version of this flow
// did not have it. Without it, `--unattended=monitored-trusted-local` selected a
// profile whose `shell` default is `allow`, and the only thing left between that
// and execution was `isDestructiveCommand()` — a blocklist whose own module
// header says it is NOT a security boundary and must never be used to decide that
// a command is safe. A review ran it and deleted `.metaproject/data/gdgraph` with
// nobody asked; `git clean -fdx` (benchmark case C1, the case keryx was praised
// for refusing) sailed straight through. A blocklist is unbounded by
// construction: everything it has not thought of is allowed. So the question is
// inverted here. Only what a pattern RECOGNISES may run, and the classifier
// stays on top of that as an extra refusal rather than as the barrier.
//
// The patterns go through `validateShellPattern` — the same validator that
// refuses over-broad SAVED permissions, which specification.md §P1.2 requires:
// "a rule whose first token does not constrain what runs is not a rule". So
// `--unattended-allow "git *"` is refused at launch, not honoured at run time.
//
// Pure and deterministic: clock/ids arrive via `PolicyDeps`, nothing is read from
// the filesystem or environment, and no `commands/` module is imported (the
// approver's return type is structural, so the driver's `ApprovalResponse`
// accepts it without this module depending on the driver).

import { decide } from "./engine";
import { isLocalProfileName, type LocalProfileName, resolveLocalProfile } from "./profiles";
import type { PolicyDecision, PolicyDeps } from "./types";
import type { ToolRisk } from "../tool/types";
import { isShellCommandAllowed, validateShellPattern } from "../../lib/shell-permissions";

/** The launch-time flag that declares an unattended run. */
export const UNATTENDED_FLAG = "--unattended";

/** The repeatable flag that supplies the argv allowlist for an unattended run. */
export const UNATTENDED_ALLOW_FLAG = "--unattended-allow";

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

/** A declared unattended run: the profile that bounds it and the argv it may run. */
export interface UnattendedPosture {
  profile: LocalProfileName;
  /**
   * Validated argv patterns. EMPTY means no command runs — read tools do not
   * reach the approver at all, so an empty allowlist is a read-only run rather
   * than a broken one.
   */
  allow: readonly string[];
}

/** Parse outcome: a posture, nothing (flag absent), or a refusal to guess. */
export type UnattendedFlagResult =
  | { kind: "absent" }
  | { kind: "posture"; posture: UnattendedPosture }
  | { kind: "error"; message: string };

/**
 * Parse `--unattended[=<profile>]` and every `--unattended-allow <pattern>` out
 * of an argv slice.
 *
 * Every occurrence is inspected, not just the last: `--unattended=nope
 * --unattended` used to return the default and swallow the typo, which is the
 * same "run under a posture nobody chose" failure the strict check exists to
 * prevent. An unknown profile is an error wherever it appears.
 *
 * An allowlist pattern that `validateShellPattern` refuses is an error too, at
 * LAUNCH. Dropping it silently would start a run whose operator believes a
 * command is permitted when it is not — and honouring it would make
 * `--unattended-allow "git *"` a grant of arbitrary execution.
 */
export function parseUnattendedFlag(args: readonly string[]): UnattendedFlagResult {
  let found: string | undefined;
  const allow: string[] = [];
  const allowSeen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === UNATTENDED_FLAG) {
      found = found ?? "";
      continue;
    }
    if (arg.startsWith(`${UNATTENDED_FLAG}=`)) {
      const value = arg.slice(UNATTENDED_FLAG.length + 1);
      if (!isLocalProfileName(value)) {
        return { kind: "error", message: unknownProfileMessage(value) };
      }
      // A second, DIFFERENT profile is a contradiction rather than a refinement.
      if (found !== undefined && found.length > 0 && found !== value) {
        return {
          kind: "error",
          message: `${UNATTENDED_FLAG} given twice with different profiles (${found}, ${value}).`,
        };
      }
      found = value;
      continue;
    }
    if (arg === UNATTENDED_ALLOW_FLAG || arg.startsWith(`${UNATTENDED_ALLOW_FLAG}=`)) {
      const inline = arg.startsWith(`${UNATTENDED_ALLOW_FLAG}=`);
      const pattern = inline ? arg.slice(UNATTENDED_ALLOW_FLAG.length + 1) : (args[++index] ?? "");
      if (pattern.trim().length === 0) {
        return { kind: "error", message: `${UNATTENDED_ALLOW_FLAG} needs a command pattern.` };
      }
      const verdict = validateShellPattern(pattern);
      if (!verdict.ok) {
        return {
          kind: "error",
          message: `${UNATTENDED_ALLOW_FLAG} "${pattern.trim()}" is refused: ${verdict.reason}`,
        };
      }
      const trimmed = pattern.trim();
      if (!allowSeen.has(trimmed)) {
        allowSeen.add(trimmed);
        allow.push(trimmed);
      }
      continue;
    }
  }

  if (found === undefined) {
    if (allow.length > 0) {
      return {
        kind: "error",
        message: `${UNATTENDED_ALLOW_FLAG} has no meaning without ${UNATTENDED_FLAG}.`,
      };
    }
    return { kind: "absent" };
  }
  const profile = found.length === 0 ? DEFAULT_UNATTENDED_PROFILE : found;
  if (!isLocalProfileName(profile)) {
    return { kind: "error", message: unknownProfileMessage(profile) };
  }
  return { kind: "posture", posture: { profile, allow } };
}

function unknownProfileMessage(value: string): string {
  return (
    `Unknown ${UNATTENDED_FLAG} profile: ${value}. ` +
    "Use read-only-review, monitored-trusted-local, or unattended-untrusted."
  );
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
  /**
   * The argv this action will run, when it runs one. An action that reaches the
   * approver with no command cannot be matched against the allowlist, and is
   * therefore refused — see {@link decideUnattended}.
   */
  command?: string;
}

/**
 * Force a decision to `deny`, keeping the engine's record shape.
 *
 * Exported so the never-auto-approve rule can be exercised directly. It is
 * unreachable through `decideUnattended` today — `baseOutcomeFor` never returns
 * `allow` for the destructive/credential classes — and an unreachable guard with
 * no test is a guard that quietly stops working when the thing making it
 * unreachable changes.
 */
export function forceDeny(decision: PolicyDecision, rule: string, reason: string): PolicyDecision {
  if (decision.decision === "deny") {
    return decision;
  }
  return {
    ...decision,
    decision: "deny",
    matchedRules: [...decision.matchedRules, rule],
    reason,
  };
}

/**
 * Resolve one unattended action through the frozen policy engine and the
 * operator's allowlist. Both must say yes.
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
    },
    deps,
  );

  if (decision.decision !== "allow") {
    return decision;
  }

  // Gate 1 said yes. Everything below is gate 2.

  if (action.destructive === true || action.credentials === true) {
    return forceDeny(
      decision,
      "unattended:destructive-never-auto-approved",
      "A destructive or credential-touching action is never auto-approved under " +
        `${UNATTENDED_FLAG}, whatever the profile allows.`,
    );
  }

  // `read` never reaches an approver (the driver's risk gate runs it directly),
  // and it carries no argv, so there is nothing to match. Every other class does
  // run something, and must be recognised before it does.
  if (action.risk === "read") {
    return decision;
  }

  const command = action.command?.trim() ?? "";
  if (command.length === 0) {
    return forceDeny(
      decision,
      "unattended:no-command-to-match",
      `${UNATTENDED_FLAG} allows a ${action.risk} action only when it can be matched against ` +
        `${UNATTENDED_ALLOW_FLAG}, and this action carries no command to match.`,
    );
  }

  if (posture.allow.length === 0) {
    return forceDeny(
      decision,
      "unattended:no-allowlist",
      `${UNATTENDED_FLAG} runs no command unless one is permitted by ${UNATTENDED_ALLOW_FLAG}, ` +
        "and this run supplied none.",
    );
  }

  // `isShellCommandAllowed` also refuses an unquoted shell metacharacter, a
  // destructive command and anything touching the agent's own credentials — so a
  // pattern match can never be the ONLY thing that ran.
  if (!isShellCommandAllowed(command, posture.allow)) {
    return forceDeny(
      decision,
      "unattended:not-allowlisted",
      `no ${UNATTENDED_ALLOW_FLAG} pattern permits this command (and a command containing an ` +
        "unquoted shell metacharacter is never matched).",
    );
  }

  return {
    ...decision,
    matchedRules: [...decision.matchedRules, "unattended:allowlisted"],
  };
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

/** What the driver hands an approver about the action it is asking about. */
export interface UnattendedApprovalMeta {
  fingerprint: string;
  destructive: boolean;
  credentials?: boolean;
  risk?: ToolRisk;
}

/**
 * Extract the command an action will run from the raw tool input JSON.
 *
 * Deliberately narrow: only a top-level string `command` field counts. A tool
 * shaped differently yields `""`, which {@link decideUnattended} refuses — an
 * action whose argv the approver cannot see is an action it cannot allowlist.
 */
export function commandFromToolInput(inputJson: string): string {
  try {
    const parsed: unknown = JSON.parse(inputJson);
    if (parsed !== null && typeof parsed === "object") {
      const command = (parsed as { command?: unknown }).command;
      if (typeof command === "string") {
        return command.trim();
      }
    }
  } catch {
    // Not JSON. A raw string is not a command shape we can reason about.
  }
  return "";
}

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
  meta?: UnattendedApprovalMeta,
) => Promise<UnattendedApprovalResponse> {
  return async (tool, input, meta) => {
    // No meta means the caller could not identify the action. An approver that
    // cannot tell what it is approving approves nothing.
    if (meta === undefined) {
      return { approved: false, fingerprint: "" };
    }
    const command = commandFromToolInput(input);
    const decision = decideUnattended(
      posture,
      {
        risk: meta.risk ?? "shell",
        destructive: meta.destructive,
        ...(meta.credentials !== undefined ? { credentials: meta.credentials } : {}),
        actionFingerprint: meta.fingerprint,
        ...(command.length > 0 ? { command } : {}),
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
 *
 * The allowlist size is part of the label because it is the difference between a
 * run that can execute something and one that cannot.
 */
export function unattendedHeaderLabel(posture: UnattendedPosture | undefined): string {
  if (posture === undefined) {
    return "";
  }
  const allow =
    posture.allow.length === 0 ? "no commands" : `${posture.allow.length} allowed command(s)`;
  return `unattended(${posture.profile}, ${allow})`;
}

/**
 * The posture value stamped into the durable run record (the session summary),
 * so a reader of the evidence can tell an unattended run from a supervised one
 * after the fact. Always present, including for supervised runs — "the field is
 * missing" and "the field says supervised" are not the same claim.
 */
export function postureRecord(posture: UnattendedPosture | undefined): string {
  if (posture === undefined) {
    return "supervised";
  }
  const allow = posture.allow.length === 0 ? "" : `+allow(${posture.allow.length})`;
  return `unattended:${posture.profile}${allow}`;
}

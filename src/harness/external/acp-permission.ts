// The permission bridge for keryx acting as an ACP CLIENT (flow 292, AC2/AC3).
//
// A foreign ACP agent asks `session/request_permission` before a tool call it
// chooses to ask about, and keryx is the one answering. This file turns that
// question into keryx's own decision and back into an ACP answer.
//
// THE ONE DECISION FUNCTION. Every answer goes through `resolveApprovalDecision`
// (`src/commands/permission-mode.ts`) — the same gate every keryx tool call and
// every codex elicitation (`./supervise-mcp.ts`) already uses. There is no second
// policy here, only a mapping onto that one.
//
// WHAT THE AGENT TELLS US IS SELF-REPORTED. The tool call's `kind`, `rawInput` and
// `locations` are the agent's own description of what it is about to do. keryx
// cannot verify them, and a mis-described call is mis-classified. Two
// consequences are built in rather than documented away:
//
//   - The permission mode is LOWERED TO `ask` for every foreign run. `trust` and
//     `auto` are the operator's standing statement about keryx's OWN tools, whose
//     risk keryx classified itself; they do not transfer to a classification a
//     foreign process supplied. The run record says when this happened.
//   - Anything that does not describe itself — `other`, `switch_mode`, a missing
//     kind — is classified as destructive shell, never as something milder.
//
// FAIL CLOSED. Only an explicit `auto` from the gate (an in-worktree read) or a
// human approval that echoes this prompt's fingerprint selects the agent's
// `allow_once` option. keryx never selects `allow_always`: a grant the foreign
// agent remembers is a grant keryx can no longer see or record. Everything else —
// a policy deny, an unattended run, an approver timeout, a human "no", a missing
// `allow_once` option — selects `reject_once`, or answers `cancelled` when the
// agent offered no `reject_once` (the spec reads `cancelled` as "do not run").

import { isDestructiveCommand, touchesAgentCredentials, touchesHumanConfirmation } from "../../lib/command-risk";
import {
  resolveApprovalDecision,
  type ApprovalGateDecision,
  type GatedToolRisk,
  type PermissionMode,
} from "../../commands/permission-mode";
import type { AgentIO, ApprovalResponse } from "../../commands/agent";
import type {
  AcpPermissionOption,
  AcpRequestPermissionOutcome,
  AcpToolCallUpdate,
  AcpToolKind,
} from "../../acp/protocol";
import { confineToRoot } from "../tool/builtin/interactive-tools";
import { isManagedFlowFile } from "../policy/engine";

/** The mode a foreign ACP run actually runs under. Always `ask` — see the header. */
export const ACP_CLIENT_EFFECTIVE_MODE: PermissionMode = "ask";

/** What the requested mode was lowered to, for the run record. */
export interface AcpModeClamp {
  readonly requested: PermissionMode;
  readonly effective: PermissionMode;
  /** True when the requested mode was `trust` or `auto` and was lowered. */
  readonly clamped: boolean;
}

/** Lower any requested mode to `ask` for a foreign agent. Pure. */
export function clampForeignMode(requested: PermissionMode): AcpModeClamp {
  return { requested, effective: ACP_CLIENT_EFFECTIVE_MODE, clamped: requested !== ACP_CLIENT_EFFECTIVE_MODE };
}

/** keryx's reading of one self-described tool call. */
export interface AcpToolCallClassification {
  /** The gated risk, or `"network"` — which keryx hard-denies today. */
  readonly risk: GatedToolRisk | "network";
  readonly destructive: boolean;
  readonly credentials: boolean;
  readonly sacReviewConfirmation: boolean;
  /** A location targets a managed flow-state file — refused regardless of approval. */
  readonly flowFile: boolean;
  /** Some location resolves outside the disposable worktree. */
  readonly outsideWorktree: boolean;
  /** Why, in operator words, for the record and the approval prompt. */
  readonly reasons: readonly string[];
}

/** The command text an `execute` call carries, however the agent spelled it. */
export function commandTextOf(rawInput: unknown): string {
  if (typeof rawInput === "string") return rawInput;
  if (typeof rawInput !== "object" || rawInput === null) return "";
  const input = rawInput as Record<string, unknown>;
  const parts: string[] = [];
  const command = input["command"] ?? input["cmd"];
  if (typeof command === "string") parts.push(command);
  else if (Array.isArray(command)) parts.push(...command.filter((p): p is string => typeof p === "string"));
  const args = input["args"];
  if (Array.isArray(args)) parts.push(...args.filter((p): p is string => typeof p === "string"));
  return parts.join(" ");
}

function locationPaths(toolCall: AcpToolCallUpdate): string[] {
  return (toolCall.locations ?? []).map((location) => location.path).filter((p) => typeof p === "string");
}

/**
 * Map a self-described ACP tool call onto keryx's risk vocabulary. Pure apart
 * from the real-path lookups `confineToRoot` performs.
 *
 *   read / search / think  → read      (escalated to write when a location leaves the worktree)
 *   edit / move            → write
 *   delete                 → destructive
 *   execute                → shell, or destructive when `isDestructiveCommand` matches
 *   fetch                  → network   (denied)
 *   other / switch_mode / missing → shell, destructive
 */
export function classifyAcpToolCall(toolCall: AcpToolCallUpdate, worktree: string): AcpToolCallClassification {
  const kind: AcpToolKind | undefined = toolCall.kind ?? undefined;
  const paths = locationPaths(toolCall);
  const reasons: string[] = [];
  const outside = paths.filter((p) => confineToRoot(worktree, p) === null);
  const outsideWorktree = outside.length > 0;
  if (outsideWorktree) reasons.push(`targets a path outside the disposable worktree: ${outside.join(", ")}`);
  const flowFile = paths.some((p) => isManagedFlowFile(p));
  if (flowFile) reasons.push("targets a managed flow-state file");
  const pathCredentials = paths.length > 0 && touchesAgentCredentials(paths.join(" "));

  const base = { flowFile, outsideWorktree, sacReviewConfirmation: false };
  switch (kind) {
    case "read":
    case "search":
    case "think": {
      if (outsideWorktree) {
        return { ...base, risk: "write", destructive: false, credentials: pathCredentials, reasons };
      }
      return { ...base, risk: "read", destructive: false, credentials: pathCredentials, reasons };
    }
    case "edit":
    case "move":
      if (pathCredentials) reasons.push("touches the agent's own permission/credential files");
      return { ...base, risk: "write", destructive: false, credentials: pathCredentials, reasons };
    case "delete":
      reasons.push("deletes");
      return { ...base, risk: "destructive", destructive: true, credentials: pathCredentials, reasons };
    case "execute": {
      const command = commandTextOf(toolCall.rawInput);
      const destructive = command.length > 0 && isDestructiveCommand(command);
      if (destructive) reasons.push("the command is classified destructive");
      const credentials = pathCredentials || (command.length > 0 && touchesAgentCredentials(command));
      // Flow 299: `flow confirm` shares SAC's confirm-review floor.
      const sacReviewConfirmation = command.length > 0 && touchesHumanConfirmation(command);
      return {
        ...base,
        risk: destructive ? "destructive" : "shell",
        destructive,
        credentials,
        sacReviewConfirmation,
        reasons,
      };
    }
    case "fetch":
      reasons.push("network access (keryx denies network risk)");
      return { ...base, risk: "network", destructive: false, credentials: false, reasons };
    default:
      reasons.push(`the agent did not describe the call's kind (${kind ?? "missing"}); treated as destructive shell`);
      return { ...base, risk: "shell", destructive: true, credentials: pathCredentials, reasons };
  }
}

/**
 * The gate's decision for one classified call under the (clamped) mode.
 * `network` and managed flow files are denied before the gate, exactly as the
 * policy engine (`src/harness/policy/engine.ts`) denies them for keryx's own tools.
 */
export function decideAcpPermission(
  classification: AcpToolCallClassification,
  mode: PermissionMode,
): ApprovalGateDecision {
  if (classification.risk === "network" || classification.flowFile) return "deny";
  return resolveApprovalDecision({
    mode,
    risk: classification.risk,
    destructive: classification.destructive,
    credentials: classification.credentials,
    sacReviewConfirmation: classification.sacReviewConfirmation,
    readOnly: false,
  });
}

/** Why a verdict was reached. */
export type AcpDecisionReason = "policy" | "unattended" | "timeout" | "human" | "no-allow-option";

/** The answer keryx sends, plus which option it chose. */
export interface AcpPermissionAnswer {
  readonly outcome: AcpRequestPermissionOutcome;
  readonly optionId: string | null;
}

/**
 * Build the ACP answer for a verdict.
 *
 * Approve → the agent's `allow_once` option, never `allow_always`. Deny →
 * `reject_once`, or `cancelled` when the agent offered no `reject_once`.
 * The CALLER guarantees an approve verdict only reaches here when an
 * `allow_once` option exists (see {@link answerAcpPermission}).
 */
export function acpPermissionAnswer(
  verdict: "approve" | "deny",
  options: readonly AcpPermissionOption[],
): AcpPermissionAnswer {
  const wanted = verdict === "approve" ? "allow_once" : "reject_once";
  const option = options.find((candidate) => candidate.kind === wanted);
  if (option === undefined) {
    return { outcome: { outcome: "cancelled" }, optionId: null };
  }
  return { outcome: { outcome: "selected", optionId: option.optionId }, optionId: option.optionId };
}

/** One answered `session/request_permission`, for the run record. */
export interface AcpPermissionDecision {
  readonly requestId: string | number | null;
  readonly toolCallId: string | undefined;
  readonly kind: string;
  readonly title: string | undefined;
  readonly risk: AcpToolCallClassification["risk"];
  readonly reasons: readonly string[];
  readonly gateDecision: ApprovalGateDecision;
  readonly verdict: "approve" | "deny";
  readonly reason: AcpDecisionReason;
  readonly timedOut: boolean;
  readonly optionId: string | null;
  readonly outcome: AcpRequestPermissionOutcome["outcome"];
  readonly modeRequested: PermissionMode;
  readonly modeEffective: PermissionMode;
}

/** Default ceiling on one human approval — the same value the codex elicitation path uses. */
export const DEFAULT_ACP_APPROVAL_TIMEOUT_MS = 45_000;

/** What {@link answerAcpPermission} needs about the run. */
export interface AcpPermissionContext {
  readonly worktree: string;
  readonly mode: AcpModeClamp;
  /** No human can be asked: `--unattended`, no TTY, or no approver wired. */
  readonly unattended: boolean;
  readonly requestApproval?: AgentIO["requestApproval"];
  readonly approvalTimeoutMs?: number;
}

/** The question the agent asked, already narrowed from the wire. */
export interface AcpPermissionQuestion {
  readonly requestId: string | number | null;
  readonly toolCall: AcpToolCallUpdate;
  readonly options: readonly AcpPermissionOption[];
}

/** A human approval counts only when it echoes THIS prompt's fingerprint. */
function isEchoedApproval(response: ApprovalResponse, fingerprint: string): boolean {
  return typeof response === "object" && response.approved && response.fingerprint === fingerprint;
}

/**
 * Decide one permission question and build the answer. Never throws for a
 * policy outcome; an approver that throws counts as a human "no".
 */
export async function answerAcpPermission(
  question: AcpPermissionQuestion,
  ctx: AcpPermissionContext,
): Promise<{ readonly answer: AcpPermissionAnswer; readonly decision: AcpPermissionDecision }> {
  const { toolCall, options } = question;
  const classification = classifyAcpToolCall(toolCall, ctx.worktree);
  const gateDecision = decideAcpPermission(classification, ctx.mode.effective);
  const fingerprint = `acp:${String(question.requestId)}:${toolCall.toolCallId}`;

  let verdict: "approve" | "deny";
  let reason: AcpDecisionReason;
  let timedOut = false;
  if (gateDecision === "auto") {
    verdict = "approve";
    reason = "policy";
  } else if (gateDecision === "deny") {
    verdict = "deny";
    reason = "policy";
  } else if (ctx.unattended || ctx.requestApproval === undefined) {
    verdict = "deny";
    reason = "unattended";
  } else {
    const inputJson = JSON.stringify({
      kind: toolCall.kind ?? null,
      title: toolCall.title ?? null,
      rawInput: toolCall.rawInput ?? null,
      locations: locationPaths(toolCall),
      reasons: classification.reasons,
    });
    // Aborted when the timeout wins, so an approver holding a terminal prompt
    // (or any other resource) for this question can release it.
    const abandon = new AbortController();
    const approval = ctx.requestApproval(`acp:${toolCall.title ?? toolCall.kind ?? "tool"}`, inputJson, {
      fingerprint,
      destructive: classification.destructive,
      ...(classification.credentials ? { credentials: true } : {}),
      signal: abandon.signal,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ctx.approvalTimeoutMs ?? DEFAULT_ACP_APPROVAL_TIMEOUT_MS);
    });
    try {
      const settled = await Promise.race([approval.catch((): ApprovalResponse => false), expired]);
      if (settled === "timeout") {
        abandon.abort();
        verdict = "deny";
        reason = "timeout";
        timedOut = true;
      } else {
        verdict = isEchoedApproval(settled, fingerprint) ? "approve" : "deny";
        reason = "human";
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // An approval with nowhere to go: the agent offered no `allow_once`. keryx will
  // not pick `allow_always` instead, so the call is refused and the record says why.
  if (verdict === "approve" && !options.some((option) => option.kind === "allow_once")) {
    verdict = "deny";
    reason = "no-allow-option";
  }

  const answer = acpPermissionAnswer(verdict, options);
  const decision: AcpPermissionDecision = {
    requestId: question.requestId,
    toolCallId: toolCall.toolCallId,
    kind: toolCall.kind ?? "missing",
    title: toolCall.title ?? undefined,
    risk: classification.risk,
    reasons: classification.reasons,
    gateDecision,
    verdict,
    reason,
    timedOut,
    optionId: answer.optionId,
    outcome: answer.outcome.outcome,
    modeRequested: ctx.mode.requested,
    modeEffective: ctx.mode.effective,
  };
  return { answer, decision };
}

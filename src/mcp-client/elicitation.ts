// Elicitation correlation, decision building, and the T9 classifier seam
// (flow 182, T8; AC3, AC5, AC9). Package: docs/requirements/keryx-mcp-client
// specification.md §4, §9; plan.md step 4.
//
// Pure and total, like `wire.ts` — no SDK, no process, no clock. Everything
// here operates on data already extracted from the wire.
import { extractCodexCallId, isExecApprovalRequestEvent } from "./wire";
import { isDestructiveCommand, touchesAgentCredentials } from "../lib/command-risk";
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
 * `vendor.codex_command`, when present and an array of strings — the actual
 * shell argv codex wants to run for an `exec-approval` elicitation (T5 live
 * probe finding). `undefined` for any other shape: absent, not an array, or
 * containing a non-string entry — a different elicitation variant or a
 * future codex version this classifier does not understand yet. Never
 * throws.
 *
 * Exported (not just used by {@link classifyElicitationRisk}) because
 * {@link describeElicitationPrompt} (T12) needs the exact same extraction to
 * render a legible approval prompt — one parser, not two that could drift.
 */
export function extractCodexCommand(vendor: Readonly<Record<string, unknown>>): string[] | undefined {
  const raw = vendor.codex_command;
  if (!Array.isArray(raw)) return undefined;
  return raw.every((entry): entry is string => typeof entry === "string") ? raw : undefined;
}

/**
 * T9's real implementation of the elicitation-payload analog of
 * `classifyPatchRisk` (`src/lib/patch-risk.ts`) — deriving
 * `destructive`/`credentials` from whatever detail codex's elicitation
 * payload carries about the intended action, feeding `resolveApprovalDecision`
 * exactly like `write`'s own escalation classifier does (ADR-0010).
 *
 * Replaces T6-T8's placeholder (which always returned the least-escalated
 * verdict) without touching `supervise-mcp.ts`'s call site — the seam was
 * already real and typed.
 *
 *   - `destructive`: reuses `isDestructiveCommand` (`src/lib/command-risk.ts`)
 *     against `vendor.codex_command`'s argv, joined into a single string —
 *     the same classifier `shell`/`destructive` risk already trusts, not
 *     reinvented here. ALSO escalates unconditionally when
 *     `vendor.codex_elicitation === "patch-approval"`: a patch-approval
 *     elicitation is codex asking to write a patch, the exact same action
 *     `apply_patch`/`write` risk already treats as needing the ADR-0010
 *     escalation posture, but unlike `classifyPatchRisk` this classifier has
 *     no parsed diff hunks to reason about per-target-file — there is no
 *     finer signal available in the vendor payload today — so the whole
 *     elicitation is treated as destructive rather than silently
 *     understating risk for a write this classifier cannot inspect further.
 *   - `credentials`: reuses `touchesAgentCredentials` against the same
 *     joined command string, and separately against `vendor.codex_cwd` when
 *     it is a string — `touchesAgentCredentials` matches on TEXT containing
 *     one of keryx's own credential/permission markers
 *     (`permissions.json`, `auth.json`, `.local/share/keryx`,
 *     `.config/keryx`), so a cwd inside keryx's own state directory is as
 *     strong a signal as the command text itself, and codex's cwd is a real,
 *     always-present field the shell-risk classifier does not have an
 *     analog of.
 *   - Never throws: `vendor.codex_command` missing or not a string array
 *     degrades to no destructive/credentials signal from the command (still
 *     escalated by the `patch-approval` check above, when it applies),
 *     exactly the "different elicitation shape, or a future codex version"
 *     case named in this task — same total-function contract as
 *     `classifyPatchRisk`.
 */
/**
 * The synthetic tool-name prefix `supervise-mcp.ts` gives every elicitation
 * it forwards to `deps.requestApproval` (`${MCP_ELICITATION_TOOL_PREFIX}${requestId}`).
 * Exported so both `supervise-mcp.ts` (the producer) and the two real
 * `requestApproval` renderers — `src/commands/shell.ts` and
 * `src/tui/tui-shell.ts` (T12, specification.md §8) — share one literal
 * rather than two that could drift.
 */
export const MCP_ELICITATION_TOOL_PREFIX = "mcp_elicitation:";

/** What {@link describeElicitationPrompt} extracts for a human-legible approval prompt. */
export interface ElicitationPromptText {
  /** The elicitation's own `message` field, or a safe fallback when absent/blank. */
  readonly message: string;
  /** `vendor.codex_command`, joined into one string, when present. */
  readonly command: string | undefined;
}

/**
 * T12 (specification.md §8): turn one `requestApproval(tool, inputJson, meta)`
 * call for a `mcp_elicitation:*`-named request back into the human-readable
 * `{message, vendor}` it was built from (`supervise-mcp.ts`'s call site),
 * rather than the operator seeing raw escaped JSON.
 *
 * Returns `undefined` when `tool` is not an elicitation request at all — the
 * caller's cue to fall through to its existing generic/shell rendering
 * unchanged. Never throws: `inputJson` that fails to parse, or that parses to
 * something other than `{message, vendor}`, degrades to showing the raw
 * string as the "message" rather than crashing the approval prompt — the
 * same total-function contract every other pure parser in this module keeps
 * (`extractCodexCommand`, `correlateElicitation`).
 */
export function describeElicitationPrompt(tool: string, inputJson: string): ElicitationPromptText | undefined {
  if (!tool.startsWith(MCP_ELICITATION_TOOL_PREFIX)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    return { message: inputJson, command: undefined };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { message: inputJson, command: undefined };
  }

  const obj = parsed as { message?: unknown; vendor?: unknown };
  const message =
    typeof obj.message === "string" && obj.message.trim().length > 0
      ? obj.message
      : "codex is requesting approval for an action";
  const vendor = typeof obj.vendor === "object" && obj.vendor !== null ? (obj.vendor as Record<string, unknown>) : {};
  const command = extractCodexCommand(vendor)?.join(" ");
  return { message, command };
}

export function classifyElicitationRisk(pending: PendingElicitation): ElicitationRiskClassification {
  const reasons: string[] = [];
  let destructive = false;
  let credentials = false;

  const command = extractCodexCommand(pending.vendor);
  const joinedCommand = command === undefined ? undefined : command.join(" ");

  if (joinedCommand !== undefined && isDestructiveCommand(joinedCommand)) {
    destructive = true;
    reasons.push(`underlying command looks destructive: ${joinedCommand}`);
  }

  if (pending.vendor.codex_elicitation === "patch-approval") {
    destructive = true;
    reasons.push("patch-approval elicitation: treated as destructive like apply_patch/write risk (ADR-0010)");
  }

  const cwd = typeof pending.vendor.codex_cwd === "string" ? pending.vendor.codex_cwd : undefined;
  const credentialSignal = [joinedCommand, cwd].filter((v): v is string => v !== undefined).join(" ");
  if (credentialSignal.length > 0 && touchesAgentCredentials(credentialSignal)) {
    credentials = true;
    reasons.push("touches the agent's own permission/credential files");
  }

  return { destructive, credentials, reasons };
}

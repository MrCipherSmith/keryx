// Hook stdin/stdout I/O codec (flow 306, W6, T5).
//
// `buildHookStdin` shapes one event payload into the stdin JSON a hook
// process receives: the W6 camelCase fields plus the Claude-Code-style
// snake_case aliases (D3), so a hook command written against either
// convention runs unmodified. `parseHookResult` is the inverse: it turns a
// completed process's exit code / stdout / stderr into a typed outcome,
// honouring exit-2-as-deny, silent-approve on empty stdout, both native and
// Claude `hookSpecificOutput` decision shapes, and dropping `updatedInput`
// (Design > Non-goals: no input rewriting in v1).
import { MAX_CONTEXT_BYTES } from "../context/manifest";
import { GATE_CAPABLE_EVENTS } from "./types";
import type { HookAnomalyName, HookClass, HookEventName, HookFailureKind } from "./types";
import type { PolicyOutcome } from "../policy/types";

/**
 * One hook's `additionalContext` must not be able to single-handedly consume
 * the whole-session context ceiling (`MAX_CONTEXT_BYTES`, 2 MiB) on its own.
 * Capping at 1% of that ceiling (~20 KiB) leaves room for several hooks to
 * contribute on one turn while still allowing a substantive context blob.
 */
export const HOOK_ADDITIONAL_CONTEXT_MAX_BYTES = Math.floor(MAX_CONTEXT_BYTES / 100);

/** stderr-as-reason (exit 2) and JSON `reason` fields are capped to this many bytes. */
export const HOOK_REASON_MAX_BYTES = 4000;

function capUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { text: value, truncated: false };
  }
  // Truncate by byte length without splitting a multi-byte codepoint: slice by
  // char count first (a safe over-estimate since utf8 chars are >=1 byte each),
  // then trim from the end until the byte length fits.
  let text = value.slice(0, maxBytes);
  while (Buffer.byteLength(text, "utf8") > maxBytes) {
    text = text.slice(0, -1);
  }
  return { text, truncated: true };
}

export interface BuildHookStdinOptions {
  hookId: string;
  timestamp: string;
  /** Defaults to `"1.0.0"`. */
  schemaVersion?: string;
  /** Known project root, aliased to snake_case `cwd`. */
  projectRoot?: string;
}

/**
 * Shape one event's payload fields into the stdin JSON object. `payload` is
 * the event-specific field set (e.g. `{sessionId, runId, toolCallId,
 * toolName, toolInput, risk, policyProfile}` for `PreToolUse`) — the base
 * fields (`schemaVersion`/`timestamp`/`hookId`/`event`) are added here, and a
 * fixed set of snake_case aliases (D3: same hook command runs unmodified
 * under `keryx shell` and a host's Claude-Code-shaped hook installer).
 */
export function buildHookStdin(
  event: HookEventName,
  payload: Record<string, unknown>,
  opts: BuildHookStdinOptions,
): Record<string, unknown> {
  const schemaVersion = opts.schemaVersion ?? "1.0.0";
  const aliases: Record<string, unknown> = { hook_event_name: event };
  if (typeof payload.sessionId === "string") aliases.session_id = payload.sessionId;
  if (opts.projectRoot !== undefined) aliases.cwd = opts.projectRoot;
  if (typeof payload.toolName === "string") aliases.tool_name = payload.toolName;
  if ("toolInput" in payload) aliases.tool_input = payload.toolInput;
  if ("toolOutput" in payload) aliases.tool_response = payload.toolOutput;
  if (typeof payload.prompt === "string") aliases.prompt = payload.prompt;

  return {
    ...payload,
    event,
    schemaVersion,
    timestamp: opts.timestamp,
    hookId: opts.hookId,
    ...aliases,
  };
}

/** Raw process outcome `parseHookResult` classifies (mirrors `runner.ts`'s `HookProcessRunner` result). */
export interface HookProcessOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

export interface ParseHookResultContext {
  cls: HookClass;
  event: HookEventName;
}

export interface HookParsedOk {
  kind: "ok";
  decision?: PolicyOutcome;
  additionalContext?: string;
  reason?: string;
  anomalies: HookAnomalyName[];
}

export interface HookParsedFailure {
  kind: "failure";
  failure: HookFailureKind;
  reason: string;
}

export type HookParseResult = HookParsedOk | HookParsedFailure;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapDecisionString(raw: unknown): PolicyOutcome | undefined | "invalid" {
  if (raw === undefined) return undefined;
  if (raw === "allow" || raw === "ask" || raw === "deny") return raw;
  if (raw === "approve") return "allow"; // legacy alias
  if (raw === "block") return "deny"; // legacy alias
  return "invalid";
}

const POLICY_OUTCOME_RANK: Record<PolicyOutcome, number> = { allow: 0, ask: 1, deny: 2 };

/**
 * The stricter of two decisions (flow 306, W6, fix round 1, finding 8). A
 * hook's stdout can carry BOTH a top-level `decision` and a nested
 * `hookSpecificOutput.permissionDecision` — e.g. a Claude-Code-shaped hook
 * that sets `hookSpecificOutput.permissionDecision: "deny"` but leaves a
 * stale/default top-level `decision: "allow"` from a template. Preferring
 * whichever field happened to be checked first (previously: `parsed.decision
 * ?? hookSpecific?.permissionDecision`, i.e. always the top-level field when
 * present) let the laxer of the two silently win. `undefined` never outranks
 * an actual decision either field DID give.
 */
function mostRestrictiveDecision(a: PolicyOutcome | undefined, b: PolicyOutcome | undefined): PolicyOutcome | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return POLICY_OUTCOME_RANK[a] >= POLICY_OUTCOME_RANK[b] ? a : b;
}

/** Whether a hook's `class`+`event` combination is ever allowed to change the outcome. */
function decisionIsHonored(ctx: ParseHookResultContext): boolean {
  return (ctx.cls === "gate" || ctx.cls === "gate-advisory") && GATE_CAPABLE_EVENTS.includes(ctx.event);
}

/** Apply the shared post-processing every exit path needs: decision-honour + context cap. */
function finalizeOk(
  ctx: ParseHookResultContext,
  rawDecision: PolicyOutcome | undefined,
  rawContext: string | undefined,
  reason: string | undefined,
  anomalies: HookAnomalyName[],
): HookParsedOk {
  let decision = rawDecision;
  if (decision !== undefined && !decisionIsHonored(ctx)) {
    anomalies.push("hook-decision-ignored");
    decision = undefined;
  }
  let additionalContext = rawContext;
  if (additionalContext !== undefined) {
    const capped = capUtf8(additionalContext, HOOK_ADDITIONAL_CONTEXT_MAX_BYTES);
    additionalContext = capped.text;
    if (capped.truncated) {
      anomalies.push("hook-context-truncated");
    }
  }
  return {
    kind: "ok",
    ...(decision !== undefined ? { decision } : {}),
    ...(additionalContext !== undefined ? { additionalContext } : {}),
    ...(reason !== undefined ? { reason } : {}),
    anomalies,
  };
}

/**
 * Classify a completed hook invocation. Exit 0 with empty/whitespace-only
 * stdout is a silent approve (no decision, no anomalies). Exit 2 is an
 * explicit deny with (trimmed, capped) stderr as the reason. Any other
 * non-zero exit, a timeout, or a spawn failure is a crash-class failure.
 */
export function parseHookResult(raw: HookProcessOutcome, ctx: ParseHookResultContext): HookParseResult {
  if (raw.timedOut) {
    return { kind: "failure", failure: "timeout", reason: "Hook exceeded its configured timeout." };
  }
  if (raw.spawnError !== undefined) {
    let failure: HookFailureKind = "crash";
    if (raw.spawnError === "sandbox-unavailable") failure = "sandbox-unavailable";
    else if (raw.spawnError === "refused") failure = "refused";
    return { kind: "failure", failure, reason: raw.spawnError };
  }
  if (raw.exitCode === 2) {
    const { text } = capUtf8(raw.stderr.trim(), HOOK_REASON_MAX_BYTES);
    return finalizeOk(ctx, "deny", undefined, text.length > 0 ? text : undefined, []);
  }
  if (raw.exitCode !== 0) {
    return {
      kind: "failure",
      failure: "crash",
      reason: `Hook exited with code ${String(raw.exitCode)}.`,
    };
  }

  const stdout = raw.stdout.trim();
  if (stdout.length === 0) {
    return finalizeOk(ctx, undefined, undefined, undefined, []);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { kind: "failure", failure: "malformed", reason: "stdout is not valid JSON." };
  }
  if (!isPlainObject(parsed)) {
    return { kind: "failure", failure: "malformed", reason: "stdout JSON must be an object." };
  }

  const anomalies: HookAnomalyName[] = [];
  const hookSpecific = isPlainObject(parsed.hookSpecificOutput) ? parsed.hookSpecificOutput : undefined;

  const topDecision = mapDecisionString(parsed.decision);
  if (topDecision === "invalid") {
    return { kind: "failure", failure: "malformed", reason: `Unrecognised decision "${String(parsed.decision)}".` };
  }
  const hookSpecificDecision = mapDecisionString(hookSpecific?.permissionDecision);
  if (hookSpecificDecision === "invalid") {
    return {
      kind: "failure",
      failure: "malformed",
      reason: `Unrecognised decision "${String(hookSpecific?.permissionDecision)}".`,
    };
  }
  const decisionCandidate = mostRestrictiveDecision(topDecision, hookSpecificDecision);

  const updatedInputPresent = parsed.updatedInput !== undefined || hookSpecific?.updatedInput !== undefined;
  if (updatedInputPresent) {
    anomalies.push("hook-attempted-input-rewrite");
  }

  const additionalContextRaw = parsed.additionalContext ?? hookSpecific?.additionalContext;
  const additionalContext = typeof additionalContextRaw === "string" ? additionalContextRaw : undefined;

  const reasonRaw = parsed.reason ?? hookSpecific?.permissionDecisionReason;
  const reason = typeof reasonRaw === "string" ? reasonRaw : undefined;

  return finalizeOk(ctx, decisionCandidate, additionalContext, reason, anomalies);
}

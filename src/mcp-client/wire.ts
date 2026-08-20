// Raw JSON-RPC message parsing for the MCP client (flow 182, T6, T8; AC2).
//
// Pure and total: every function here operates on `unknown` (an already
// JSON-parsed value, exactly what a transport-level `onmessage` tap receives)
// and never throws. This is what lets it be unit-tested with no SDK, no
// process, and no transport at all — `client.ts` is the only file that wires
// these functions to a real `codex mcp-server` child.
//
// The reason this file exists at all: the SDK's own `ElicitRequestSchema`
// strips codex's vendor fields (`codex_call_id` etc.) via Zod's default
// unknown-key stripping (T5 live probe finding). Reading the request as plain
// JSON, before any Zod schema touches it, is the only way to see them.
import type { RawCodexEventNotification, RawElicitationRequest } from "./types";

/** The one inbound request method this module cares about. */
export const ELICITATION_CREATE_METHOD = "elicitation/create";

/** The one inbound notification method this module cares about. */
export const CODEX_EVENT_METHOD = "codex/event";

/** The `codex/event` `msg.type` that carries the decision vocabulary for an elicitation. */
export const EXEC_APPROVAL_REQUEST_MSG_TYPE = "exec_approval_request";

/**
 * Standard MCP fields on an `elicitation/create` request's `params` — anything
 * else is a vendor field, per the T5 live probe's field list
 * (`codex_call_id`, `codex_elicitation`, `codex_command`, `codex_cwd`,
 * `codex_parsed_cmd`, `codex_mcp_tool_call_id`, `codex_event_id`).
 */
const STANDARD_ELICITATION_PARAM_KEYS: ReadonlySet<string> = new Set(["message", "requestedSchema"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A parsed JSON-RPC request: has `method` (string) and an `id` (string|number). Notifications have no `id`. */
export function isJsonRpcRequestMessage(
  message: unknown,
): message is { method: string; id: string | number; params?: Record<string, unknown> } {
  if (!isRecord(message)) return false;
  if (typeof message.method !== "string") return false;
  return typeof message.id === "string" || typeof message.id === "number";
}

/** A parsed JSON-RPC notification: has `method` (string) and NO `id`. */
export function isJsonRpcNotificationMessage(
  message: unknown,
): message is { method: string; params?: Record<string, unknown> } {
  if (!isRecord(message)) return false;
  if (typeof message.method !== "string") return false;
  return message.id === undefined;
}

/**
 * Parse one raw wire message into an `elicitation/create` request, preserving
 * every vendor field the SDK's own schema would strip. `undefined` for
 * anything else (a different method, a response, a malformed message) —
 * never throws.
 */
export function parseElicitationCreateRequest(message: unknown): RawElicitationRequest | undefined {
  if (!isJsonRpcRequestMessage(message) || message.method !== ELICITATION_CREATE_METHOD) return undefined;
  const params = isRecord(message.params) ? message.params : {};
  const vendor: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!STANDARD_ELICITATION_PARAM_KEYS.has(key)) vendor[key] = value;
  }
  return {
    requestId: message.id,
    message: typeof params.message === "string" ? params.message : undefined,
    requestedSchema: params.requestedSchema,
    vendor,
  };
}

/**
 * Parse one raw wire message into a `codex/event` notification, unpacking
 * `params.msg`. `undefined` for anything else, including a `codex/event`
 * whose `msg` is not an object — never throws.
 */
export function parseCodexEventNotification(message: unknown): RawCodexEventNotification | undefined {
  if (!isJsonRpcNotificationMessage(message) || message.method !== CODEX_EVENT_METHOD) return undefined;
  const params = isRecord(message.params) ? message.params : {};
  const msg = params.msg;
  if (!isRecord(msg)) return undefined;

  const msgType = typeof msg.type === "string" ? msg.type : "";
  const callId = typeof msg.call_id === "string" ? msg.call_id : undefined;
  const availableDecisionsRaw = msg.available_decisions;
  const availableDecisions = Array.isArray(availableDecisionsRaw)
    ? availableDecisionsRaw.filter((entry): entry is string => typeof entry === "string")
    : undefined;

  return { msgType, callId, availableDecisions, raw: msg };
}

/** Whether a parsed `codex/event` is the exec-approval-request variant this module correlates against. */
export function isExecApprovalRequestEvent(event: RawCodexEventNotification): boolean {
  return event.msgType === EXEC_APPROVAL_REQUEST_MSG_TYPE;
}

/** `vendor.codex_call_id`, when present and a string. This is codex's own correlation key. */
export function extractCodexCallId(request: RawElicitationRequest): string | undefined {
  const raw = request.vendor.codex_call_id;
  return typeof raw === "string" ? raw : undefined;
}

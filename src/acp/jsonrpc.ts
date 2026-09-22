// JSON-RPC 2.0 envelopes and errors for the ACP agent server (flow 285, T6).
//
// This file is deliberately ACP-FREE: it knows the JSON-RPC 2.0 spec and the
// numeric error codes ACP reserves, and nothing about ACP methods, versions or
// wire shapes. Those live in `./protocol.ts`, which is the one file a protocol
// version bump has to touch (AC7). Splitting them this way is what makes that
// claim true rather than aspirational — framing and envelopes do not change
// when ACP v2 lands, so they must not sit in the file that does.
//
// Pure: importing this reads nothing and spawns nothing.

/**
 * A JSON-RPC request identifier.
 *
 * ACP's `RequestId` is `string | number | null` (schema `$defs.RequestId`),
 * which is JSON-RPC 2.0's set minus the omitted-id case that marks a
 * notification. `null` is legal on the wire and is what a reply to an
 * unparseable request must carry, because there was no id to echo.
 */
export type JsonRpcId = string | number | null;

/** The only `jsonrpc` value ACP accepts. */
export const JSONRPC_VERSION = "2.0";

export interface JsonRpcRequestMessage {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotificationMessage {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcSuccessMessage {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcErrorMessage {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: JsonRpcErrorObject;
}

export type JsonRpcResponseMessage = JsonRpcSuccessMessage | JsonRpcErrorMessage;

export type JsonRpcMessage =
  | JsonRpcRequestMessage
  | JsonRpcNotificationMessage
  | JsonRpcResponseMessage;

/**
 * Every error code ACP names, from schema `$defs.ErrorCode`.
 *
 * The first five are JSON-RPC 2.0's own. The rest occupy the implementation-
 * defined range the spec reserves, and ACP assigns them specific meanings — so
 * they are pinned here rather than invented per call site. `requestCancelled`
 * in particular is load-bearing: a request killed by `$/cancel_request` MUST be
 * answered with `-32800` and not simply dropped, or the peer waits forever.
 */
export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** ACP: execution aborted by a cancellation request, shutdown or resource limits. */
  requestCancelled: -32800,
  /** ACP: authentication required before this operation. */
  authRequired: -32000,
  /** ACP: a named resource, such as a file, was not found. */
  resourceNotFound: -32002,
} as const;

export type JsonRpcErrorCode = (typeof JSON_RPC_ERROR_CODES)[keyof typeof JSON_RPC_ERROR_CODES];

/**
 * An error a handler raises to answer its request with a specific JSON-RPC
 * error instead of an opaque internal one.
 *
 * Anything else a handler throws becomes `internalError` with the thrown
 * message and no stack, because a stack on the wire is an information leak to
 * whatever process launched us.
 */
export class AcpError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpError";
    this.code = code;
    this.data = data;
  }

  toErrorObject(): JsonRpcErrorObject {
    return jsonRpcError(this.code, this.message, this.data);
  }

  static from(code: number, message: string, data?: unknown): AcpError {
    return new AcpError(code, message, data);
  }
}

/** Builds an error object, omitting `data` entirely when there is none. */
export function jsonRpcError(code: number, message: string, data?: unknown): JsonRpcErrorObject {
  return data === undefined ? { code, message } : { code, message, data };
}

export function parseError(data?: unknown): JsonRpcErrorObject {
  return jsonRpcError(JSON_RPC_ERROR_CODES.parseError, "Parse error", data);
}

export function invalidRequest(data?: unknown): JsonRpcErrorObject {
  return jsonRpcError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid request", data);
}

export function methodNotFound(method: string, data?: unknown): JsonRpcErrorObject {
  return jsonRpcError(JSON_RPC_ERROR_CODES.methodNotFound, `Method not found: ${method}`, data);
}

export function invalidParams(message: string, data?: unknown): JsonRpcErrorObject {
  return jsonRpcError(JSON_RPC_ERROR_CODES.invalidParams, message, data);
}

export function internalError(message: string, data?: unknown): JsonRpcErrorObject {
  return jsonRpcError(JSON_RPC_ERROR_CODES.internalError, message, data);
}

export function requestCancelled(message = "Request cancelled", data?: unknown): JsonRpcErrorObject {
  return jsonRpcError(JSON_RPC_ERROR_CODES.requestCancelled, message, data);
}

export function successResponse(id: JsonRpcId, result: unknown): JsonRpcSuccessMessage {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function errorResponse(id: JsonRpcId, error: JsonRpcErrorObject): JsonRpcErrorMessage {
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

export function requestMessage(
  id: JsonRpcId,
  method: string,
  params?: unknown,
): JsonRpcRequestMessage {
  return params === undefined
    ? { jsonrpc: JSONRPC_VERSION, id, method }
    : { jsonrpc: JSONRPC_VERSION, id, method, params };
}

export function notificationMessage(
  method: string,
  params?: unknown,
): JsonRpcNotificationMessage {
  return params === undefined
    ? { jsonrpc: JSONRPC_VERSION, method }
    : { jsonrpc: JSONRPC_VERSION, method, params };
}

/**
 * What one decoded JSON value turns out to be.
 *
 * `invalid` carries the id it could recover (or `null`) so the caller can still
 * answer a malformed request rather than drop it. Dropping is the failure mode
 * that hangs an editor: the client is blocked on a response that never comes,
 * and there is nothing in its log to say why.
 */
export type ClassifiedJsonRpcMessage =
  | { readonly kind: "request"; readonly message: JsonRpcRequestMessage }
  | { readonly kind: "notification"; readonly message: JsonRpcNotificationMessage }
  | { readonly kind: "response"; readonly message: JsonRpcResponseMessage }
  | { readonly kind: "invalid"; readonly id: JsonRpcId; readonly error: JsonRpcErrorObject };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || typeof value === "number";
}

/** The id of a malformed message when it is recoverable, `null` when it is not. */
function recoverId(value: unknown): JsonRpcId {
  if (!isPlainObject(value)) {
    return null;
  }
  const id = value["id"];
  return isJsonRpcId(id) ? id : null;
}

/**
 * Classifies a decoded JSON value as request, notification, response or junk.
 *
 * A notification is distinguished from a request by the ABSENCE of the `id`
 * key, not by its value: `{"id": null, "method": "x"}` is a request whose reply
 * carries `id: null`, and treating it as a notification would silently swallow
 * it. That distinction is JSON-RPC 2.0 §4.1 and it is the one an `in`-check
 * gets right and a truthiness check gets wrong.
 */
export function classifyJsonRpcMessage(value: unknown): ClassifiedJsonRpcMessage {
  if (!isPlainObject(value)) {
    return {
      kind: "invalid",
      id: null,
      error: invalidRequest({ reason: "message is not a JSON object" }),
    };
  }

  if (value["jsonrpc"] !== JSONRPC_VERSION) {
    return {
      kind: "invalid",
      id: recoverId(value),
      error: invalidRequest({
        reason: `jsonrpc must be "${JSONRPC_VERSION}"`,
        received: value["jsonrpc"],
      }),
    };
  }

  const hasMethod = "method" in value;
  const hasResult = "result" in value;
  const hasError = "error" in value;

  if (hasMethod) {
    const method = value["method"];
    if (typeof method !== "string") {
      return {
        kind: "invalid",
        id: recoverId(value),
        error: invalidRequest({ reason: "method must be a string", received: method }),
      };
    }

    if (!("id" in value)) {
      const notification: JsonRpcNotificationMessage =
        "params" in value
          ? { jsonrpc: JSONRPC_VERSION, method, params: value["params"] }
          : { jsonrpc: JSONRPC_VERSION, method };
      return { kind: "notification", message: notification };
    }

    const id = value["id"];
    if (!isJsonRpcId(id)) {
      return {
        kind: "invalid",
        id: null,
        error: invalidRequest({ reason: "id must be a string, number or null", received: id }),
      };
    }

    const request: JsonRpcRequestMessage =
      "params" in value
        ? { jsonrpc: JSONRPC_VERSION, id, method, params: value["params"] }
        : { jsonrpc: JSONRPC_VERSION, id, method };
    return { kind: "request", message: request };
  }

  if (hasResult || hasError) {
    const id = value["id"];
    if (!isJsonRpcId(id)) {
      return {
        kind: "invalid",
        id: null,
        error: invalidRequest({ reason: "response id must be a string, number or null" }),
      };
    }
    if (hasError) {
      const raw = value["error"];
      const code = isPlainObject(raw) ? raw["code"] : undefined;
      const message = isPlainObject(raw) ? raw["message"] : undefined;
      if (typeof code !== "number" || typeof message !== "string") {
        return {
          kind: "invalid",
          id,
          error: invalidRequest({ reason: "error must carry a numeric code and a string message" }),
        };
      }
      const data = isPlainObject(raw) ? raw["data"] : undefined;
      return { kind: "response", message: errorResponse(id, jsonRpcError(code, message, data)) };
    }
    return { kind: "response", message: successResponse(id, value["result"]) };
  }

  return {
    kind: "invalid",
    id: recoverId(value),
    error: invalidRequest({ reason: "message carries neither method, result nor error" }),
  };
}

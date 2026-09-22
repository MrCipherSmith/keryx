// The Agent Client Protocol wire surface keryx pins (flow 285, T5 + T6).
//
// THIS IS THE ONE FILE A PROTOCOL VERSION BUMP TOUCHES (AC7). Everything that
// is true of ACP v1 and could stop being true of ACP v2 lives here: the version
// constant, the method names, the capability shapes, and every request,
// response and notification payload. `./jsonrpc.ts` (envelopes), `./framing.ts`
// (newline framing) and `./dispatch.ts` (routing) are version-agnostic by
// construction and must stay that way — if a change to ACP forces an edit
// outside this file, that is the signal that the split has decayed, and
// `./protocol.test.ts` is what states the claim so it can fail.
//
// SOURCE OF TRUTH
//
// Transcribed from the published v1 JSON Schema
// (https://raw.githubusercontent.com/zed-industries/agent-client-protocol/main/schema/v1/schema.json,
// fetched 2026-09-22) cross-read against https://agentclientprotocol.com/protocol/v1/.
// Where the prose docs and the schema disagree, the schema wins: the prose's
// `session/request_permission` example shows a bare `toolCallId` and an
// `outcome` of `"granted" | "denied"`, and BOTH are wrong — the schema carries
// a full `ToolCallUpdate` and a tagged `{ outcome: "selected", optionId }`.
//
// ACP v2 exists in draft (https://agentclientprotocol.com/protocol/v2/). keryx
// pins v1 because v1 is what shipping clients speak; v2 is explicitly a draft
// at the time of writing.
//
// Pure: importing this reads nothing and spawns nothing.

import {
  AcpError,
  JSON_RPC_ERROR_CODES,
  invalidParams,
  methodNotFound,
  type JsonRpcErrorObject,
} from "./jsonrpc";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * The single ACP MAJOR version keryx implements.
 *
 * ACP's `protocolVersion` is one integer (`uint16`), bumped only for breaking
 * changes; everything non-breaking arrives as a capability. So there is one
 * number here and not a semver string, and a client that sends `"1"` is sending
 * the wrong type, not a spelling variant.
 */
export const ACP_PROTOCOL_VERSION = 1;

/** Every version keryx can serve, newest last. */
export const ACP_SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [ACP_PROTOCOL_VERSION];

/** Provenance of every shape in this file, quoted in the version-pin test. */
export const ACP_SCHEMA_SOURCE =
  "agent-client-protocol schema/v1/schema.json @ 2026-09-22";

export type AcpProtocolVersion = number;

// ---------------------------------------------------------------------------
// Method names
// ---------------------------------------------------------------------------

/** Methods a client calls ON the agent. Values are the schema's `x-method`. */
export const ACP_AGENT_METHODS = {
  initialize: "initialize",
  authenticate: "authenticate",
  logout: "logout",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionResume: "session/resume",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionClose: "session/close",
  sessionDelete: "session/delete",
  sessionList: "session/list",
  sessionSetMode: "session/set_mode",
  sessionSetConfigOption: "session/set_config_option",
} as const;

/** Methods the agent calls ON the client. */
export const ACP_CLIENT_METHODS = {
  fsReadTextFile: "fs/read_text_file",
  fsWriteTextFile: "fs/write_text_file",
  sessionRequestPermission: "session/request_permission",
  sessionUpdate: "session/update",
  elicitationCreate: "elicitation/create",
  elicitationComplete: "elicitation/complete",
  terminalCreate: "terminal/create",
  terminalOutput: "terminal/output",
  terminalKill: "terminal/kill",
  terminalRelease: "terminal/release",
  terminalWaitForExit: "terminal/wait_for_exit",
} as const;

/** Bidirectional: either side may cancel an in-flight request it issued. */
export const ACP_CANCEL_REQUEST_METHOD = "$/cancel_request";

/**
 * The agent methods keryx answers in flow 285.
 *
 * `authenticate` is absent on purpose and not by omission: keryx advertises an
 * empty `authMethods`, and the spec only permits `authenticate` against an
 * advertised method. See `ACP_REFUSED_AGENT_METHODS`.
 */
export const ACP_IMPLEMENTED_AGENT_METHODS: readonly string[] = [
  ACP_AGENT_METHODS.initialize,
  ACP_AGENT_METHODS.sessionNew,
  ACP_AGENT_METHODS.sessionLoad,
  ACP_AGENT_METHODS.sessionList,
  ACP_AGENT_METHODS.sessionPrompt,
  ACP_AGENT_METHODS.sessionCancel,
];

export interface AcpMethodRefusal {
  /** The JSON-RPC code returned when a client calls it anyway. */
  readonly code: number;
  /** Why, in one line, for the error's `data.reason`. */
  readonly reason: string;
}

/**
 * Agent methods keryx knows about and deliberately does not answer.
 *
 * All of them refuse with `-32601 Method not found`, which is the spec's own
 * answer for an unadvertised capability: a client is supposed to read
 * `agentCapabilities` and not call these at all, and a client that calls one
 * regardless has a bug that a specific code will not fix. What the specific
 * `reason` does fix is the log line a human reads afterwards — "keryx has not
 * implemented it" and "your client ignored the capability" are different bugs
 * and a bare method-not-found conflates them.
 */
export const ACP_REFUSED_AGENT_METHODS: ReadonlyMap<string, AcpMethodRefusal> = new Map([
  [
    ACP_AGENT_METHODS.authenticate,
    {
      code: JSON_RPC_ERROR_CODES.methodNotFound,
      reason: "keryx advertises no authMethods; there is nothing to authenticate against",
    },
  ],
  [
    ACP_AGENT_METHODS.logout,
    {
      code: JSON_RPC_ERROR_CODES.methodNotFound,
      reason: "keryx does not advertise agentCapabilities.auth.logout",
    },
  ],
  [
    ACP_AGENT_METHODS.sessionResume,
    {
      code: JSON_RPC_ERROR_CODES.methodNotFound,
      reason:
        "keryx does not advertise sessionCapabilities.resume; use session/load, which replays history",
    },
  ],
  [
    ACP_AGENT_METHODS.sessionClose,
    {
      code: JSON_RPC_ERROR_CODES.methodNotFound,
      reason: "keryx does not advertise sessionCapabilities.close; sessions are durable on disk",
    },
  ],
  [
    ACP_AGENT_METHODS.sessionDelete,
    {
      code: JSON_RPC_ERROR_CODES.methodNotFound,
      reason:
        "keryx does not advertise sessionCapabilities.delete; session retention is an operator decision, not a client one",
    },
  ],
  [
    ACP_AGENT_METHODS.sessionSetMode,
    {
      code: JSON_RPC_ERROR_CODES.methodNotFound,
      reason: "keryx returns no modes from session/new, so there is no mode to set",
    },
  ],
  [
    ACP_AGENT_METHODS.sessionSetConfigOption,
    {
      code: JSON_RPC_ERROR_CODES.methodNotFound,
      reason: "keryx returns no configOptions from session/new, so there is no option to set",
    },
  ],
]);

/** The refusal for `method`, or `undefined` when it is not a refused ACP method. */
export function refusalFor(method: string): AcpMethodRefusal | undefined {
  return ACP_REFUSED_AGENT_METHODS.get(method);
}

/**
 * The error a refused-but-known ACP method answers with.
 *
 * Returns `undefined` for a method that is simply unknown, so the caller can
 * tell "ACP defines this and keryx declines it" from "nobody defines this" and
 * answer each honestly.
 */
export function refusalError(method: string): JsonRpcErrorObject | undefined {
  const refusal = ACP_REFUSED_AGENT_METHODS.get(method);
  if (refusal === undefined) {
    return undefined;
  }
  return methodNotFound(method, {
    reason: refusal.reason,
    protocolVersion: ACP_PROTOCOL_VERSION,
    implemented: ACP_IMPLEMENTED_AGENT_METHODS,
  });
}

// ---------------------------------------------------------------------------
// Version negotiation
// ---------------------------------------------------------------------------

/**
 * What `initialize` should do with the version a client asked for.
 *
 * Three outcomes, and the middle one is the subtle one:
 *
 *   - `exact`    — the client asked for a version keryx serves. Answer with it.
 *   - `offer`    — the client asked for a NEWER version. ACP v1 initialization
 *                  says the agent "MUST respond with the latest version it
 *                  supports" and the client then decides whether to proceed or
 *                  close the connection. So this is not keryx downgrading the
 *                  session behind the client's back; it is keryx stating its
 *                  ceiling and handing the decision to the peer, which is the
 *                  conformant behaviour and the only one a v2 client can
 *                  recover from.
 *   - `refuse`   — the request is not a version at all (missing, wrong type,
 *                  fractional, out of `uint16` range) or is below keryx's floor.
 *                  There is no conformant number to answer with, so it is a
 *                  JSON-RPC error rather than a guess.
 *
 * NOTE FOR THE FLOW (AC1): AC1 reads "a request naming an unsupported protocol
 * version is refused with a JSON-RPC error rather than a crash or a silent
 * downgrade". Taken literally that would make the `offer` case an error too,
 * which contradicts the spec's MUST. This function implements the spec and
 * keeps the error for the cases where the spec offers no answer; see the flow's
 * `context.md` §Findings.
 */
export type AcpVersionNegotiation =
  | { readonly kind: "exact"; readonly version: AcpProtocolVersion }
  | { readonly kind: "offer"; readonly version: AcpProtocolVersion; readonly requested: number }
  | { readonly kind: "refuse"; readonly error: JsonRpcErrorObject };

function unsupportedVersionError(requested: unknown, reason: string): JsonRpcErrorObject {
  return invalidParams(`Unsupported ACP protocol version: ${reason}`, {
    requested,
    supported: ACP_SUPPORTED_PROTOCOL_VERSIONS,
    latest: ACP_PROTOCOL_VERSION,
  });
}

/** Classifies the `protocolVersion` of an `initialize` request. */
export function negotiateProtocolVersion(requested: unknown): AcpVersionNegotiation {
  if (typeof requested !== "number" || !Number.isInteger(requested)) {
    return {
      kind: "refuse",
      error: unsupportedVersionError(requested, "protocolVersion must be an integer"),
    };
  }
  if (requested < 0 || requested > 65_535) {
    return {
      kind: "refuse",
      error: unsupportedVersionError(requested, "protocolVersion is outside the uint16 range"),
    };
  }
  if (ACP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return { kind: "exact", version: requested };
  }
  if (requested > ACP_PROTOCOL_VERSION) {
    return { kind: "offer", version: ACP_PROTOCOL_VERSION, requested };
  }
  return {
    kind: "refuse",
    error: unsupportedVersionError(
      requested,
      `keryx serves ${ACP_SUPPORTED_PROTOCOL_VERSIONS.join(", ")} and cannot speak anything older`,
    ),
  };
}

/** The same refusal as an `AcpError`, for a handler that throws rather than returns. */
export function unsupportedProtocolVersion(requested: unknown, reason: string): AcpError {
  const error = unsupportedVersionError(requested, reason);
  return new AcpError(error.code, error.message, error.data);
}

// ---------------------------------------------------------------------------
// Shared scalars
// ---------------------------------------------------------------------------

export type AcpSessionId = string;
export type AcpToolCallId = string;
export type AcpMessageId = string;
export type AcpTerminalId = string;
export type AcpPermissionOptionId = string;
export type AcpAuthMethodId = string;
export type AcpSessionModeId = string;

/** ACP's open `_meta` escape hatch, present on nearly every object. */
export type AcpMeta = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface AcpAnnotations {
  readonly audience?: readonly ("assistant" | "user")[];
  readonly lastModified?: string;
  readonly priority?: number;
  readonly _meta?: AcpMeta;
}

export interface AcpTextContent {
  readonly type: "text";
  readonly text: string;
  readonly annotations?: AcpAnnotations;
  readonly _meta?: AcpMeta;
}

export interface AcpImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
  readonly uri?: string;
  readonly annotations?: AcpAnnotations;
  readonly _meta?: AcpMeta;
}

export interface AcpAudioContent {
  readonly type: "audio";
  readonly data: string;
  readonly mimeType: string;
  readonly annotations?: AcpAnnotations;
  readonly _meta?: AcpMeta;
}

export interface AcpResourceLink {
  readonly type: "resource_link";
  readonly name: string;
  readonly uri: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly title?: string;
  readonly annotations?: AcpAnnotations;
  readonly _meta?: AcpMeta;
}

export interface AcpTextResourceContents {
  readonly uri: string;
  readonly text: string;
  readonly mimeType?: string;
  readonly _meta?: AcpMeta;
}

export interface AcpBlobResourceContents {
  readonly uri: string;
  readonly blob: string;
  readonly mimeType?: string;
  readonly _meta?: AcpMeta;
}

export interface AcpEmbeddedResource {
  readonly type: "resource";
  readonly resource: AcpTextResourceContents | AcpBlobResourceContents;
  readonly annotations?: AcpAnnotations;
  readonly _meta?: AcpMeta;
}

export type AcpContentBlock =
  | AcpTextContent
  | AcpImageContent
  | AcpAudioContent
  | AcpResourceLink
  | AcpEmbeddedResource;

/** Convenience constructor for the one content type keryx emits today. */
export function textBlock(text: string): AcpTextContent {
  return { type: "text", text };
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface AcpFileSystemCapabilities {
  readonly readTextFile?: boolean;
  readonly writeTextFile?: boolean;
  readonly _meta?: AcpMeta;
}

export interface AcpAuthCapabilities {
  readonly terminal?: boolean;
  readonly _meta?: AcpMeta;
}

export interface AcpClientSessionCapabilities {
  readonly configOptions?: { readonly _meta?: AcpMeta } | null;
  readonly _meta?: AcpMeta;
}

export interface AcpElicitationCapabilities {
  readonly form?: unknown;
  readonly url?: unknown;
  readonly _meta?: AcpMeta;
}

export interface AcpClientCapabilities {
  readonly fs?: AcpFileSystemCapabilities;
  readonly terminal?: boolean;
  readonly session?: AcpClientSessionCapabilities | null;
  readonly auth?: AcpAuthCapabilities;
  readonly elicitation?: AcpElicitationCapabilities | null;
  readonly _meta?: AcpMeta;
}

export interface AcpPromptCapabilities {
  readonly image?: boolean;
  readonly audio?: boolean;
  readonly embeddedContext?: boolean;
  readonly _meta?: AcpMeta;
}

export interface AcpMcpCapabilities {
  readonly http?: boolean;
  readonly sse?: boolean;
  readonly _meta?: AcpMeta;
}

/**
 * ACP marks each session sub-capability by PRESENCE of an (empty) object, not
 * by a boolean. `{ list: {} }` advertises listing; `{ list: null }` and an
 * absent `list` both do not. A boolean here would be a different wire shape.
 */
export interface AcpSessionCapabilities {
  readonly list?: { readonly _meta?: AcpMeta } | null;
  readonly delete?: { readonly _meta?: AcpMeta } | null;
  readonly additionalDirectories?: { readonly _meta?: AcpMeta } | null;
  readonly resume?: { readonly _meta?: AcpMeta } | null;
  readonly close?: { readonly _meta?: AcpMeta } | null;
  readonly _meta?: AcpMeta;
}

export interface AcpAgentAuthCapabilities {
  readonly logout?: { readonly _meta?: AcpMeta } | null;
  readonly _meta?: AcpMeta;
}

export interface AcpAgentCapabilities {
  readonly loadSession?: boolean;
  readonly promptCapabilities?: AcpPromptCapabilities;
  readonly mcpCapabilities?: AcpMcpCapabilities;
  readonly sessionCapabilities?: AcpSessionCapabilities;
  readonly auth?: AcpAgentAuthCapabilities;
  readonly _meta?: AcpMeta;
}

export interface AcpImplementation {
  readonly name: string;
  readonly version: string;
  readonly title?: string;
  readonly _meta?: AcpMeta;
}

export type AcpAuthMethod =
  | { readonly type: "terminal"; readonly id: AcpAuthMethodId; readonly name: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>>; readonly _meta?: AcpMeta }
  | { readonly id: AcpAuthMethodId; readonly name: string; readonly _meta?: AcpMeta };

/**
 * Exactly what `keryx acp` advertises in its `initialize` response.
 *
 * Every `false` and every omission here is a PROMISE, not a placeholder, and
 * the rest of the flow depends on it:
 *
 *   - `loadSession: true` — keryx sessions are durable per project, so
 *     `session/load` can replay one (AC5).
 *   - `sessionCapabilities: { list: {} }` and nothing else — listing is a
 *     surface over `listSessions()`; resume/close/delete are refused above.
 *   - `mcpCapabilities: { http: false, sse: false }` — keryx starts a client's
 *     STDIO servers for the session that names them (flow 287,
 *     `./session-mcp.ts`) and does not connect URL-based ones, so it does not
 *     invite a client to send them. The stdio variant needs no capability
 *     flag; an http/sse entry a client sends anyway is not started and is
 *     reported to it by name, never dropped silently.
 *   - `promptCapabilities` without `image`/`audio` — the prompt path takes text
 *     and embedded text resources; accepting a base64 image it would then throw
 *     away is worse than declining it.
 *   - `auth: {}` with an empty `authMethods` — keryx authenticates to model
 *     providers out of band, through its own credential store, and never over
 *     this wire.
 */
export const KERYX_AGENT_CAPABILITIES: AcpAgentCapabilities = Object.freeze({
  loadSession: true,
  promptCapabilities: Object.freeze({ image: false, audio: false, embeddedContext: true }),
  mcpCapabilities: Object.freeze({ http: false, sse: false }),
  sessionCapabilities: Object.freeze({ list: Object.freeze({}) }),
  auth: Object.freeze({}),
});

/** keryx advertises no auth methods; `authenticate` is refused accordingly. */
export const KERYX_AUTH_METHODS: readonly AcpAuthMethod[] = Object.freeze([]);

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export interface AcpInitializeRequest {
  readonly protocolVersion: AcpProtocolVersion;
  readonly clientCapabilities?: AcpClientCapabilities;
  readonly clientInfo?: AcpImplementation | null;
  readonly _meta?: AcpMeta;
}

export interface AcpInitializeResponse {
  readonly protocolVersion: AcpProtocolVersion;
  readonly agentCapabilities?: AcpAgentCapabilities;
  readonly authMethods?: readonly AcpAuthMethod[];
  readonly agentInfo?: AcpImplementation | null;
  readonly _meta?: AcpMeta;
}

// ---------------------------------------------------------------------------
// MCP servers (session/new, session/load)
// ---------------------------------------------------------------------------

export interface AcpEnvVariable {
  readonly name: string;
  readonly value: string;
  readonly _meta?: AcpMeta;
}

export interface AcpHttpHeader {
  readonly name: string;
  readonly value: string;
  readonly _meta?: AcpMeta;
}

export interface AcpMcpServerStdio {
  readonly type?: "stdio";
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly AcpEnvVariable[];
  readonly _meta?: AcpMeta;
}

export interface AcpMcpServerHttp {
  readonly type: "http";
  readonly name: string;
  readonly url: string;
  readonly headers?: readonly AcpHttpHeader[];
  readonly _meta?: AcpMeta;
}

export interface AcpMcpServerSse {
  readonly type: "sse";
  readonly name: string;
  readonly url: string;
  readonly headers?: readonly AcpHttpHeader[];
  readonly _meta?: AcpMeta;
}

export type AcpMcpServer = AcpMcpServerStdio | AcpMcpServerHttp | AcpMcpServerSse;

// ---------------------------------------------------------------------------
// session/new, session/load, session/list
// ---------------------------------------------------------------------------

export interface AcpNewSessionRequest {
  readonly cwd: string;
  readonly mcpServers: readonly AcpMcpServer[];
  readonly additionalDirectories?: readonly string[];
  readonly _meta?: AcpMeta;
}

export interface AcpSessionMode {
  readonly id: AcpSessionModeId;
  readonly name: string;
  readonly _meta?: AcpMeta;
}

export interface AcpSessionModeState {
  readonly currentModeId: AcpSessionModeId;
  readonly availableModes: readonly AcpSessionMode[];
  readonly _meta?: AcpMeta;
}

export interface AcpNewSessionResponse {
  readonly sessionId: AcpSessionId;
  readonly modes?: AcpSessionModeState | null;
  readonly configOptions?: readonly unknown[] | null;
  readonly _meta?: AcpMeta;
}

export interface AcpLoadSessionRequest {
  readonly sessionId: AcpSessionId;
  readonly cwd: string;
  readonly mcpServers: readonly AcpMcpServer[];
  readonly additionalDirectories?: readonly string[];
  readonly _meta?: AcpMeta;
}

export interface AcpLoadSessionResponse {
  readonly modes?: AcpSessionModeState | null;
  readonly configOptions?: readonly unknown[] | null;
  readonly _meta?: AcpMeta;
}

export interface AcpListSessionsRequest {
  readonly cwd?: string | null;
  readonly cursor?: string | null;
  readonly _meta?: AcpMeta;
}

export interface AcpSessionInfo {
  readonly sessionId: AcpSessionId;
  readonly cwd: string;
  readonly title?: string | null;
  readonly updatedAt?: string | null;
  readonly additionalDirectories?: readonly string[];
  readonly _meta?: AcpMeta;
}

export interface AcpListSessionsResponse {
  readonly sessions: readonly AcpSessionInfo[];
  readonly nextCursor?: string | null;
  readonly _meta?: AcpMeta;
}

// ---------------------------------------------------------------------------
// session/prompt and session/cancel
// ---------------------------------------------------------------------------

export interface AcpPromptRequest {
  readonly sessionId: AcpSessionId;
  readonly prompt: readonly AcpContentBlock[];
  readonly _meta?: AcpMeta;
}

/**
 * Why a turn stopped.
 *
 * `cancelled` is a MUST: the spec requires a prompt interrupted by
 * `session/cancel` to resolve with this value rather than with an error, so the
 * client can tell "you stopped me" from "I broke".
 */
export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export const ACP_STOP_REASONS: readonly AcpStopReason[] = [
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
];

export interface AcpPromptResponse {
  readonly stopReason: AcpStopReason;
  readonly _meta?: AcpMeta;
}

export interface AcpCancelNotification {
  readonly sessionId: AcpSessionId;
  readonly _meta?: AcpMeta;
}

export interface AcpCancelRequestNotification {
  readonly requestId: string | number | null;
  readonly _meta?: AcpMeta;
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export type AcpToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export interface AcpToolCallLocation {
  readonly path: string;
  readonly line?: number;
  readonly _meta?: AcpMeta;
}

export interface AcpDiff {
  readonly path: string;
  readonly newText: string;
  readonly oldText?: string | null;
  readonly _meta?: AcpMeta;
}

export type AcpToolCallContent =
  | { readonly type: "content"; readonly content: AcpContentBlock; readonly _meta?: AcpMeta }
  | ({ readonly type: "diff" } & AcpDiff)
  | { readonly type: "terminal"; readonly terminalId: AcpTerminalId; readonly _meta?: AcpMeta };

export interface AcpToolCall {
  readonly toolCallId: AcpToolCallId;
  readonly title: string;
  readonly name?: string | null;
  readonly kind?: AcpToolKind;
  readonly status?: AcpToolCallStatus;
  readonly content?: readonly AcpToolCallContent[];
  readonly locations?: readonly AcpToolCallLocation[];
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly _meta?: AcpMeta;
}

export interface AcpToolCallUpdate {
  readonly toolCallId: AcpToolCallId;
  readonly title?: string | null;
  readonly name?: string | null;
  readonly kind?: AcpToolKind | null;
  readonly status?: AcpToolCallStatus | null;
  readonly content?: readonly AcpToolCallContent[] | null;
  readonly locations?: readonly AcpToolCallLocation[] | null;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly _meta?: AcpMeta;
}

// ---------------------------------------------------------------------------
// session/request_permission
// ---------------------------------------------------------------------------

export type AcpPermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export interface AcpPermissionOption {
  readonly optionId: AcpPermissionOptionId;
  readonly name: string;
  readonly kind: AcpPermissionOptionKind;
  readonly _meta?: AcpMeta;
}

/**
 * The permission request carries a whole `ToolCallUpdate`, not a bare id.
 *
 * Consequence for keryx, recorded here because it constrains the later
 * dispatch: the adapter must already have minted a `toolCallId` and emitted a
 * `tool_call` update for this call BEFORE it asks, or the client is being asked
 * to authorise something it has never been shown.
 */
export interface AcpRequestPermissionRequest {
  readonly sessionId: AcpSessionId;
  readonly toolCall: AcpToolCallUpdate;
  readonly options: readonly AcpPermissionOption[];
  readonly _meta?: AcpMeta;
}

/**
 * The client's answer.
 *
 * There is no `"denied"` outcome. A denial is `selected` with an option whose
 * `kind` is `reject_once` or `reject_always`; `cancelled` means the turn itself
 * was cancelled while the question was open, which is not an answer at all.
 * Anything that maps this to a boolean has to decide what `cancelled` means,
 * and the only safe answer is "do not run the tool".
 */
export type AcpRequestPermissionOutcome =
  | { readonly outcome: "cancelled"; readonly _meta?: AcpMeta }
  | { readonly outcome: "selected"; readonly optionId: AcpPermissionOptionId; readonly _meta?: AcpMeta };

export interface AcpRequestPermissionResponse {
  readonly outcome: AcpRequestPermissionOutcome;
  readonly _meta?: AcpMeta;
}

/** `true` only for an explicit allow; `cancelled` and every reject are `false`. */
export function permissionGranted(
  response: AcpRequestPermissionResponse,
  options: readonly AcpPermissionOption[],
): boolean {
  const outcome = response.outcome;
  if (outcome.outcome !== "selected") {
    return false;
  }
  const chosen = options.find((option) => option.optionId === outcome.optionId);
  return chosen?.kind === "allow_once" || chosen?.kind === "allow_always";
}

// ---------------------------------------------------------------------------
// session/update
// ---------------------------------------------------------------------------

export interface AcpPlanEntry {
  readonly content: string;
  readonly priority: "high" | "medium" | "low";
  readonly status: "pending" | "in_progress" | "completed";
  readonly _meta?: AcpMeta;
}

export interface AcpUsageCost {
  readonly amount: number;
  readonly currency: string;
  readonly _meta?: AcpMeta;
}

export type AcpSessionUpdate =
  | {
      readonly sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
      readonly content: AcpContentBlock;
      readonly messageId?: AcpMessageId | null;
      readonly _meta?: AcpMeta;
    }
  | ({ readonly sessionUpdate: "tool_call" } & AcpToolCall)
  | ({ readonly sessionUpdate: "tool_call_update" } & AcpToolCallUpdate)
  | { readonly sessionUpdate: "plan"; readonly entries: readonly AcpPlanEntry[]; readonly _meta?: AcpMeta }
  | {
      readonly sessionUpdate: "available_commands_update";
      readonly availableCommands: readonly unknown[];
      readonly _meta?: AcpMeta;
    }
  | {
      readonly sessionUpdate: "current_mode_update";
      readonly currentModeId: AcpSessionModeId;
      readonly _meta?: AcpMeta;
    }
  | { readonly sessionUpdate: "config_option_update"; readonly _meta?: AcpMeta }
  | {
      readonly sessionUpdate: "session_info_update";
      readonly title?: string | null;
      readonly updatedAt?: string | null;
      readonly _meta?: AcpMeta;
    }
  | {
      readonly sessionUpdate: "usage_update";
      readonly used: number;
      readonly size: number;
      readonly cost?: AcpUsageCost | null;
      readonly _meta?: AcpMeta;
    };

export interface AcpSessionNotification {
  readonly sessionId: AcpSessionId;
  readonly update: AcpSessionUpdate;
  readonly _meta?: AcpMeta;
}

// ---------------------------------------------------------------------------
// fs/* and terminal/*
// ---------------------------------------------------------------------------

export interface AcpReadTextFileRequest {
  readonly sessionId: AcpSessionId;
  readonly path: string;
  readonly line?: number | null;
  readonly limit?: number | null;
  readonly _meta?: AcpMeta;
}

export interface AcpReadTextFileResponse {
  readonly content: string;
  readonly _meta?: AcpMeta;
}

export interface AcpWriteTextFileRequest {
  readonly sessionId: AcpSessionId;
  readonly path: string;
  readonly content: string;
  readonly _meta?: AcpMeta;
}

export interface AcpWriteTextFileResponse {
  readonly _meta?: AcpMeta;
}

export interface AcpCreateTerminalRequest {
  readonly sessionId: AcpSessionId;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: readonly AcpEnvVariable[];
  readonly cwd?: string | null;
  readonly outputByteLimit?: number | null;
  readonly _meta?: AcpMeta;
}

export interface AcpCreateTerminalResponse {
  readonly terminalId: AcpTerminalId;
  readonly _meta?: AcpMeta;
}

export interface AcpTerminalExitStatus {
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly _meta?: AcpMeta;
}

export interface AcpTerminalHandleRequest {
  readonly sessionId: AcpSessionId;
  readonly terminalId: AcpTerminalId;
  readonly _meta?: AcpMeta;
}

export interface AcpTerminalOutputResponse {
  readonly output: string;
  readonly truncated: boolean;
  readonly exitStatus?: AcpTerminalExitStatus | null;
  readonly _meta?: AcpMeta;
}

// ---------------------------------------------------------------------------
// Params helpers
// ---------------------------------------------------------------------------

/**
 * Narrows `params` to an object or throws `invalid params`.
 *
 * Per-method validation belongs to each handler; this is the one check every
 * handler would otherwise repeat, and skipping it turns a client bug into a
 * `TypeError` that surfaces as `internalError` — the wrong code and the wrong
 * blame.
 */
export function requireObjectParams(params: unknown, method: string): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    const error = invalidParams(`${method}: params must be an object`, { received: params });
    throw new AcpError(error.code, error.message, error.data);
  }
  return params as Record<string, unknown>;
}

/** Narrows a required string field or throws `invalid params`. */
export function requireStringField(
  params: Record<string, unknown>,
  field: string,
  method: string,
): string {
  const value = params[field];
  if (typeof value !== "string" || value === "") {
    const error = invalidParams(`${method}: ${field} must be a non-empty string`, {
      field,
      received: value,
    });
    throw new AcpError(error.code, error.message, error.data);
  }
  return value;
}

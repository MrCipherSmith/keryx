// The ACP agent server loop (flow 285, T7/T8): wires the framer + dispatcher
// + keryx session/turn handlers over one stdio connection.
//
// Nothing but protocol frames reaches `options.write` — every diagnostic goes
// through `options.logError` instead, per the transport's own MUST NOT
// (`context.md` §0: "a stray console.log corrupts the stream").
//
// One call to `runAcpServer` is one connection, matching how a real ACP
// client launches the agent: a fresh subprocess per session. `initialized`
// and `clientCapabilities` are therefore connection-scoped local state, never
// module-level globals — two connections in the same test process (or two
// launches of the CLI) never see each other's state.

import { randomUUID } from "node:crypto";
import { buildAgentSystemInstruction, runAgentTurn, type AgentDeps } from "../commands/agent";
import { applyPatchTool } from "../harness/tool/builtin/apply-patch-tool";
import { shellExecTool } from "../harness/tool/builtin/shell-exec-tool";
import { builtinReadOnlyTools, type InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { NormalizedMessage, ProviderPort } from "../harness/provider/types";
import { listSessions, persistHistory } from "../session";
import { createAcpAgentIo, toolKindFor, tryParseJson, type AcpPermissionAsker } from "./agent-io";
import { acpAwareReadFileTool, type AcpFsReader } from "./capability-tools";
import { AcpClientRequests } from "./client-requests";
import { AcpDispatcher, type AcpDispatchOutcome } from "./dispatch";
import { AcpLineFramer, encodeAcpMessage } from "./framing";
import {
  AcpError,
  JSON_RPC_ERROR_CODES,
  invalidParams,
  invalidRequest,
  notificationMessage,
  type JsonRpcErrorObject,
  type JsonRpcNotificationMessage,
  type JsonRpcResponseMessage,
} from "./jsonrpc";
import {
  ACP_AGENT_METHODS,
  ACP_CLIENT_METHODS,
  KERYX_AGENT_CAPABILITIES,
  KERYX_AUTH_METHODS,
  negotiateProtocolVersion,
  requireObjectParams,
  requireStringField,
  textBlock,
  type AcpClientCapabilities,
  type AcpImplementation,
  type AcpInitializeResponse,
  type AcpListSessionsResponse,
  type AcpLoadSessionResponse,
  type AcpNewSessionResponse,
  type AcpPromptResponse,
  type AcpReadTextFileRequest,
  type AcpReadTextFileResponse,
  type AcpRequestPermissionRequest,
  type AcpRequestPermissionResponse,
  type AcpSessionInfo,
  type AcpSessionNotification,
  type AcpSessionUpdate,
  type AcpStopReason,
} from "./protocol";
import { renderAcpPromptContent } from "./prompt-content";
import { AcpSessionRegistry, AcpSessionTranscriptUnreadableError } from "./session";
import {
  acpMcpSetKey,
  parseAcpMcpServers,
  startAcpSessionMcp,
  type AcpMcpServerProblem,
  type AcpSessionMcp,
  type ParsedAcpMcpServers,
} from "./session-mcp";
import type { ConnectFn } from "../mcp-servers/manager";
import type { JsonRpcId } from "./jsonrpc";

export interface AcpServerOptions {
  readonly input: AsyncIterable<Uint8Array | string>;
  readonly write: (chunk: string) => void;
  readonly logError: (line: string) => void;
  /**
   * The provider every turn runs against. Absent only together with
   * `providerUnavailable` (flow 287, AC2): the connection still initialises,
   * and every `session/new`/`session/load` is refused with that message —
   * never answered by a stand-in.
   */
  readonly provider?: ProviderPort;
  /** Why there is no provider, naming what to configure and how. Sent as the refusal. */
  readonly providerUnavailable?: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly agentInfo?: AcpImplementation;
  readonly dataDir?: string;
  readonly idSeq?: () => string;
  /** Test seam: how a client-supplied MCP server is dialled. The shared dial procedure otherwise. */
  readonly mcpConnect?: ConnectFn;
  /** Parent environment for client-supplied MCP servers (secrets stripped). `process.env` otherwise. */
  readonly mcpEnv?: Record<string, string | undefined>;
  /**
   * The per-turn settings `keryx shell` would apply to this provider
   * (`resolveAcpTurnSettings` in `../commands/acp.ts`). Empty = the agent's
   * own defaults.
   */
  readonly turnSettings?: AcpTurnSettings;
  /**
   * Aborted to stop the connection now (SIGTERM/SIGINT in the CLI): input is
   * no longer awaited, running turns are aborted, and every client MCP server
   * is stopped before `runAcpServer` resolves.
   */
  readonly shutdown?: AbortSignal;
}

/** The subset of `AgentDeps` `keryx shell` resolves per provider at launch. */
export type AcpTurnSettings = Pick<AgentDeps, "modelParams" | "maxOutputTokens" | "reasoningEffort">;

const DEFAULT_AGENT_INFO: AcpImplementation = { name: "keryx", version: "0" };

function finishReasonToStopReason(
  finishReason: "budget" | "tool-call-budget" | "no-progress" | undefined,
): AcpStopReason {
  switch (finishReason) {
    case "budget":
      return "max_tokens";
    case "tool-call-budget":
      return "max_turn_requests";
    case "no-progress":
    case undefined:
      return "end_turn";
  }
}

function refuse(error: JsonRpcErrorObject): never {
  throw new AcpError(error.code, error.message, error.data);
}

/** Runs one ACP agent-server connection to completion (until `input` ends). */
export async function runAcpServer(options: AcpServerOptions): Promise<void> {
  let initialized = false;
  let clientCapabilities: AcpClientCapabilities | undefined;
  const idSeq = options.idSeq ?? (() => randomUUID());
  const registry = new AcpSessionRegistry({
    providerId: options.providerId,
    modelId: options.modelId,
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
  });

  const writeMessage = (message: JsonRpcResponseMessage | JsonRpcNotificationMessage): void => {
    options.write(encodeAcpMessage(message));
  };

  /**
   * Work to run right AFTER the reply to one request id has been written.
   *
   * A `session/update` for a session is only meaningful to a client that has
   * been told the session exists, i.e. after `session/new`'s response. The
   * MCP start-up report below is the one notification keryx emits outside a
   * turn, so it is ordered by this hook rather than by a timer.
   */
  const afterReply = new Map<string, () => void>();
  const replyKey = (id: JsonRpcId): string => JSON.stringify(id);

  /**
   * Client-supplied MCP servers (flow 287, AC3), SHARED per connection.
   *
   * Zed keeps one agent process and sends its whole `mcpServers` list with
   * every `session/new` — every new thread. Starting a set per session would
   * hold N threads × M servers child processes until stdin closed. So a
   * running set is keyed by the CONTENT of the list it was started from
   * (`acpMcpSetKey`: every entry's name, command, args, env and working
   * directory, hashed), and every session that sends the same list binds to
   * the one set.
   *
   * Reference-counted by binding rather than kept for the whole connection:
   * ACP gives a session no end (keryx advertises no `session/close`), so the
   * only unbind is `session/load` rebinding a session to a different list —
   * and when that leaves a set with no session, it is stopped then instead of
   * lingering. Everything still running is stopped when the connection ends.
   */
  interface SharedMcpSet {
    readonly key: string;
    readonly mcp: AcpSessionMcp;
    readonly sessions: Set<string>;
  }
  const mcpSets = new Map<string, SharedMcpSet>();
  const sessionMcp = new Map<string, SharedMcpSet>();
  /** Closes started by an unbind, awaited at connection close with the rest. */
  const retiring: Promise<void>[] = [];

  const sendUpdate = (sessionId: string, update: AcpSessionUpdate): void => {
    const notification: AcpSessionNotification = { sessionId, update };
    writeMessage(notificationMessage(ACP_CLIENT_METHODS.sessionUpdate, notification));
  };

  const clientRequests = new AcpClientRequests({
    send: (message) => {
      options.write(encodeAcpMessage(message));
    },
    idSeq,
  });

  /**
   * Set false the first time this client proves it cannot answer a permission
   * request (it refused the method, or answered something that is not an
   * answer).
   *
   * ACP v1 has NO client capability for permissions — `ClientCapabilities` is
   * `fs`, `terminal`, `session`, `auth`, `elicitation` and nothing else, and
   * the spec simply requires every client to implement
   * `session/request_permission`. So "this client cannot be asked" is not
   * something keryx can read off `initialize`; it is something it DISCOVERS,
   * once, from the first answer. After that every gated call is denied
   * locally: asking again would flood a client that already said it has no
   * such method, and — the part that matters for AC3 — a call nobody can
   * authorise must not run. Denied, never approved-by-default.
   */
  let clientAnswersPermissions = true;

  /**
   * One `session/prompt` in flight for one session (flow 285, T10 — AC4).
   *
   * `controller` is the `AbortSignal` source `runAgentTurn` runs with — the
   * SAME mechanism a local UI hard-stop uses (`RunAgentTurnOptions.signal`,
   * `context.md` §"the mapping"). `cancelled` is what makes the outcome
   * distinguishable from an ordinary finish: F-5 of context.md is that
   * `RunAgentTurnResult.finishReason` is `undefined` on EVERY abort path,
   * identical to a clean toolless finish at the return-value level — the
   * adapter has to remember the abort itself rather than read it off the
   * result. `permissionRequestIds` is the live set of this turn's own
   * `session/request_permission` requests (usually 0 or 1; never another
   * session's) — F-14's seam for settling only THIS turn's pending ask on
   * cancel, not every question on the connection (`AcpClientRequests.close`
   * would do that, and is reserved for stdin actually ending).
   */
  interface AcpActiveTurn {
    readonly controller: AbortController;
    cancelled: boolean;
    readonly permissionRequestIds: Set<string>;
  }
  const activeTurns = new Map<string, AcpActiveTurn>();

  /**
   * ONE turn per session, at a time (flow 285, T16).
   *
   * A session's `history` array is mutated IN PLACE by `runAgentTurn` for the
   * session's whole lifetime (`session.ts`, `AcpSessionState.history`), so two
   * overlapping turns on one session id do not run "in parallel": they
   * interleave writes into the same transcript, persist each other's partial
   * state, and leave `activeTurns` holding one `AcpActiveTurn` where two are
   * live — which `session/cancel` could then only ever reach the newer of
   * (and whose `finally` would delete the other turn's slot). `session/load`
   * is the same hazard from the other side: it REPLACES the registry entry,
   * and therefore the history array a turn already running against the old
   * entry keeps writing to.
   *
   * Refused rather than queued: a client that sent a second prompt has not
   * been told the first one finished, and silently serialising would look like
   * a hung request. `invalidRequest` is the code this file already uses for a
   * request that is well-formed but not legal in the connection's current
   * state (`requireInitialized`), as opposed to `invalidParams` for a
   * malformed field or `resourceNotFound` for a session that does not exist.
   */
  function refuseIfBusy(method: string, sessionId: string): void {
    if (!activeTurns.has(sessionId)) {
      return;
    }
    refuse(
      invalidRequest({
        // The remedy names WAITING, not just cancelling: `session/cancel`
        // aborts the turn but does not free the slot by itself — the turn's own
        // `finally` does that once it observes the abort, which for a turn
        // parked in a long tool call is not immediate. A client told merely to
        // "cancel first" would re-prompt straight away and be refused again.
        reason:
          `${method}: a turn is already running for session ${sessionId}; ` +
          "wait for its session/prompt response — send session/cancel first if you do not want to wait for it to finish, " +
          "then prompt again once the cancelled turn has replied",
        method,
        sessionId,
        condition: "session-busy",
      }),
    );
  }

  /** Shapes, sends and interprets one `session/request_permission`. `undefined` = could not be asked. */
  const askPermissionFor = (sessionId: string, turn: AcpActiveTurn): AcpPermissionAsker => {
    return async (ask): Promise<AcpRequestPermissionResponse | undefined> => {
      if (!clientAnswersPermissions) {
        options.logError(
          `acp: ${ACP_CLIENT_METHODS.sessionRequestPermission} not asked for ${ask.toolCall.name ?? "a tool call"}: ` +
            "this client already refused the method; the call is denied",
        );
        return undefined;
      }
      const params: AcpRequestPermissionRequest = {
        sessionId,
        toolCall: ask.toolCall,
        options: [...ask.options],
      };
      let requestId: string | undefined;
      const outcome = await clientRequests.request(
        ACP_CLIENT_METHODS.sessionRequestPermission,
        params,
        (id) => {
          requestId = id;
          turn.permissionRequestIds.add(id);
        },
      );
      if (requestId !== undefined) {
        // Settled one way or another (answered, errored, closed, or — F-14 —
        // cancelled out from under it by `handleSessionCancel`): it is no
        // longer a request `session/cancel` needs to reach.
        turn.permissionRequestIds.delete(requestId);
      }
      if (outcome.kind === "error") {
        // `-32601` here is a client with no permission surface at all; any
        // other error is a client that failed to answer this one. Both are
        // "not authorised", and both latch: a client that errors on the method
        // will error on the next one too.
        clientAnswersPermissions = false;
        options.logError(
          `acp: ${ACP_CLIENT_METHODS.sessionRequestPermission} refused by the client ` +
            `(${outcome.error.code}: ${outcome.error.message}); the call is denied`,
        );
        return undefined;
      }
      if (outcome.kind === "closed") {
        options.logError(
          `acp: ${ACP_CLIENT_METHODS.sessionRequestPermission} went unanswered (${outcome.reason}); the call is denied`,
        );
        return undefined;
      }
      const result = outcome.result;
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        options.logError(
          `acp: ${ACP_CLIENT_METHODS.sessionRequestPermission} answered with a non-object result; the call is denied`,
        );
        return undefined;
      }
      // The outcome's own shape is validated where it is interpreted
      // (`approvalFromPermissionResponse`), which denies anything that is not
      // an explicit allow — including a missing or malformed `outcome`.
      return result as AcpRequestPermissionResponse;
    };
  };

  /**
   * Flow 287, AC2: with no usable provider, a session is refused — with the
   * message that says what to configure — rather than created and then
   * answered by a stand-in. `initialize` is untouched: a client that cannot
   * initialise shows the operator nothing at all, not even this message.
   */
  function requireProvider(method: string): ProviderPort {
    if (options.provider === undefined) {
      // The remedy goes in `message`, not only in `data`: `message` is the
      // field every client shows a person (Zed prints it in the thread), and
      // `invalidRequest`'s own message is a fixed "Invalid request".
      refuse({
        code: JSON_RPC_ERROR_CODES.invalidRequest,
        message: options.providerUnavailable ?? `${method}: keryx acp has no provider configured`,
        data: { method, condition: "provider-not-configured" },
      });
    }
    return options.provider;
  }

  /**
   * Tell the client which of this session's MCP servers are not running, and
   * why (flow 287, AC5).
   *
   * THE CHANNEL: an `agent_message_chunk` `session/update`, plus a stderr line.
   * ACP v1 has no notification for MCP server status and no field for it in
   * the `session/new`/`session/load` response (only `_meta`, which no client
   * shows a person). An agent message is the one channel every client renders
   * in the thread the operator is looking at — Zed included — so it is the
   * most visible honest answer: the operator reads "server X was not started:
   * reason" where they would otherwise wonder why its tools never appear.
   * stderr carries the same line for the client's agent log.
   */
  function reportMcpProblems(sessionId: string, problems: readonly AcpMcpServerProblem[]): void {
    for (const problem of problems) {
      options.logError(`acp: MCP server "${problem.name}" for session ${sessionId}: ${problem.reason}`);
      sendUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: textBlock(`keryx: MCP server "${problem.name}" ${problem.reason}\n`),
      });
    }
  }

  /** Drop `sessionId`'s binding; stop the set if no session uses it any more. */
  function unbindSessionMcp(sessionId: string): void {
    const previous = sessionMcp.get(sessionId);
    if (previous === undefined) return;
    sessionMcp.delete(sessionId);
    previous.sessions.delete(sessionId);
    if (previous.sessions.size === 0 && mcpSets.get(previous.key) === previous) {
      mcpSets.delete(previous.key);
      retiring.push(previous.mcp.close());
    }
  }

  /**
   * Bind `sessionId` to the running set for `parsed` (starting it if no
   * session on this connection runs that list yet), releasing whatever it was
   * bound to before, and report the set's problems to THIS session once the
   * reply to `requestId` is on the wire — a second thread is told about a
   * failed server as the first was.
   */
  function bindSessionMcp(sessionId: string, requestId: JsonRpcId, parsed: ParsedAcpMcpServers, resolvedRoot: string): void {
    if (parsed.stdio.length === 0 && parsed.refused.length === 0) {
      unbindSessionMcp(sessionId);
      return;
    }
    const rooted: ParsedAcpMcpServers = {
      ...parsed,
      // Each server runs in the session's resolved project root.
      stdio: parsed.stdio.map((server) => ({ ...server, cwd: resolvedRoot })),
    };
    const key = acpMcpSetKey(rooted);
    let set = mcpSets.get(key);
    if (set === undefined) {
      set = {
        key,
        mcp: startAcpSessionMcp(rooted, {
          ...(options.mcpEnv !== undefined ? { env: options.mcpEnv } : {}),
          ...(options.mcpConnect !== undefined ? { connect: options.mcpConnect } : {}),
        }),
        sessions: new Set(),
      };
      mcpSets.set(key, set);
    }
    // Take the new reference BEFORE releasing the old one, so rebinding a
    // session to the list it already had never stops and restarts the set.
    set.sessions.add(sessionId);
    if (sessionMcp.get(sessionId) !== set) {
      unbindSessionMcp(sessionId);
      sessionMcp.set(sessionId, set);
    }
    const bound = set;
    afterReply.set(replyKey(requestId), () => {
      reportMcpProblems(sessionId, bound.mcp.refused);
      void bound.mcp.ready.then(() => {
        // A session rebound before its servers settled reports nothing: the
        // client has already been told about the set that replaced it.
        if (sessionMcp.get(sessionId) === bound) {
          reportMcpProblems(sessionId, bound.mcp.failed());
        }
      });
    });
  }

  /**
   * Stop every client MCP server this connection started. Idempotent; used by
   * the normal end of input, by a read loop that throws, and by `shutdown`.
   */
  let closingAll: Promise<void> | undefined;
  const closeAllMcp = (): Promise<void> =>
    (closingAll ??= (async () => {
      const running = [...mcpSets.values()].map((set) => set.mcp.close());
      mcpSets.clear();
      sessionMcp.clear();
      await Promise.allSettled([...running, ...retiring]);
    })());

  /** AC1 / spec: a request before `initialize` is refused, not served. */
  function requireInitialized(method: string): void {
    if (!initialized) {
      refuse(invalidRequest({ reason: `${method}: call initialize before any other request`, method }));
    }
  }

  function handleInitialize(params: unknown): AcpInitializeResponse {
    const obj = requireObjectParams(params, ACP_AGENT_METHODS.initialize);
    const negotiation = negotiateProtocolVersion(obj["protocolVersion"]);
    if (negotiation.kind === "refuse") {
      refuse(negotiation.error);
    }
    initialized = true;
    const rawCaps = obj["clientCapabilities"];
    clientCapabilities =
      typeof rawCaps === "object" && rawCaps !== null && !Array.isArray(rawCaps)
        ? (rawCaps as AcpClientCapabilities)
        : undefined;
    return {
      protocolVersion: negotiation.version,
      agentCapabilities: KERYX_AGENT_CAPABILITIES,
      authMethods: KERYX_AUTH_METHODS,
      agentInfo: options.agentInfo ?? DEFAULT_AGENT_INFO,
    };
  }

  function handleSessionNew(params: unknown, requestId: JsonRpcId): AcpNewSessionResponse {
    requireInitialized(ACP_AGENT_METHODS.sessionNew);
    requireProvider(ACP_AGENT_METHODS.sessionNew);
    const obj = requireObjectParams(params, ACP_AGENT_METHODS.sessionNew);
    const cwd = requireStringField(obj, "cwd", ACP_AGENT_METHODS.sessionNew);
    // Validated BEFORE the session exists, so a malformed list creates nothing.
    // Well-formed entries keryx will not start are refused per entry and
    // reported, not refused for the whole call (see `parseAcpMcpServers`).
    const parsed = parseAcpMcpServers(ACP_AGENT_METHODS.sessionNew, obj["mcpServers"]);
    const state = registry.create(cwd, clientCapabilities);
    // Started in the background: `session/new` stays synchronous end to end
    // (the read loop relies on it, see `dispatch` below) and answers at once;
    // the session's first prompt waits for the dials to settle instead.
    bindSessionMcp(state.sessionId, requestId, parsed, state.resolvedRoot);
    return { sessionId: state.sessionId };
  }

  async function handleSessionPrompt(params: unknown): Promise<AcpPromptResponse> {
    requireInitialized(ACP_AGENT_METHODS.sessionPrompt);
    const obj = requireObjectParams(params, ACP_AGENT_METHODS.sessionPrompt);
    const sessionId = requireStringField(obj, "sessionId", ACP_AGENT_METHODS.sessionPrompt);
    const promptField = obj["prompt"];
    if (!Array.isArray(promptField)) {
      refuse(invalidParams(`${ACP_AGENT_METHODS.sessionPrompt}: prompt must be an array of content blocks`, {
        received: promptField,
      }));
    }
    const state = registry.get(sessionId);
    if (state === undefined) {
      refuse({
        code: JSON_RPC_ERROR_CODES.resourceNotFound,
        message: `Unknown ACP session: ${sessionId}`,
        data: { sessionId },
      });
    }
    // Before anything mutates `state.history` (see `refuseIfBusy`). Safe to
    // check synchronously here: `dispatch` starts every handler in wire order
    // and this whole prologue — including the `activeTurns.set` below — runs
    // before the first `await`, so no second prompt can slip between the check
    // and the registration.
    refuseIfBusy(ACP_AGENT_METHODS.sessionPrompt, sessionId);
    const provider = requireProvider(ACP_AGENT_METHODS.sessionPrompt);

    const userLine = renderAcpPromptContent(promptField);
    // THE ROSTER IS EXACTLY WHAT THE PERMISSION PATH COVERS (context.md F-4).
    //
    // T7/T8 offered `builtinReadOnlyTools` alone, because a tool that needs
    // approval with no approver wired is not "safe", it is UNREACHABLE — every
    // call silently refused by `AgentIO`'s default-deny floor. T9 wires the
    // approver, so the two tools whose entire gate is that approver join:
    //
    //   `shell_exec`  risk `shell`  — `executeCall`'s shell branch, which asks
    //                 before every command and escalates a destructive one
    //                 (never offered an "always" answer, see
    //                 `permissionOptionsFor`).
    //   `apply_patch` risk `write`  — ADR-0010's branch, same shape; every
    //                 target path is confined to the project root before git
    //                 ever runs.
    //
    // Both are bound to `state.resolvedRoot`, and NEITHER can run without an
    // explicit allow from the client for that exact call: the fingerprint is
    // bound (`isApprovalFor`), a rejection, a `cancelled`, an unknown option
    // id, a client that cannot be asked and a closed connection are all
    // denials. Beyond the client's own MCP servers (flow 287, last entry
    // below), nothing else is added: `spawn_subagent`, the metaproject tools,
    // keryx's configured MCP servers and bus tools need ports this server does
    // not construct, and
    // `ask_user` needs an interactive host seam that does not exist over this
    // wire — offering any of them would put back exactly the unreachable-call
    // state this widening removes.
    // Capability-aware read (T11, AC6): `read_file` routes through the
    // client's `fs/read_text_file` when — and only when — THIS session's
    // client advertised `fs.readTextFile`. See `capability-tools.ts` for the
    // read/write/terminal decisions in full; the write and terminal halves of
    // that decision are simpler still — `apply_patch` and `shell_exec` below
    // are handed through unwrapped, and never call `fs/write_text_file` or
    // any `terminal/*` method regardless of what the client advertised.
    const readViaClient: AcpFsReader = async (path, line) => {
      const params: AcpReadTextFileRequest = {
        sessionId,
        path,
        ...(line !== undefined ? { line } : {}),
      };
      const outcome = await clientRequests.request(ACP_CLIENT_METHODS.fsReadTextFile, params);
      if (outcome.kind !== "result") {
        return undefined;
      }
      const result = outcome.result;
      if (typeof result !== "object" || result === null) {
        return undefined;
      }
      const content = (result as Partial<AcpReadTextFileResponse>).content;
      return typeof content === "string" ? content : undefined;
    };
    const tools: InteractiveTool[] = [
      ...builtinReadOnlyTools(state.resolvedRoot).map((tool) =>
        tool.definition.name === "read_file"
          ? acpAwareReadFileTool(tool, state.resolvedRoot, state.clientCapabilities, readViaClient)
          : tool,
      ),
      shellExecTool(state.resolvedRoot),
      applyPatchTool(state.resolvedRoot),
      // Flow 287 (AC3/AC4): the client's own MCP servers for THIS session,
      // through the shell's `search_tool`/`use_tool` pair — offered only when
      // the session has any. `use_tool` is `risk: "destructive"`, so every
      // call is asked through `session/request_permission` below and a denial
      // ends it exactly as a local one does. Never auto-approved: this server
      // sets no permission mode, so the agent's default (`ask`) applies.
      ...(sessionMcp.get(sessionId)?.mcp.tools ?? []),
    ];
    const toolNames = tools.map((tool) => tool.definition.name);
    const deps: AgentDeps = {
      ...options.turnSettings,
      provider,
      providerId: options.providerId,
      modelId: options.modelId,
      tools,
      systemInstruction: buildAgentSystemInstruction(undefined, {
        providerId: options.providerId,
        modelId: options.modelId,
        toolNames,
      }),
      idSeq,
      // Deliberately NOT `unattended: true` (context.md F-4; AC3 groundwork
      // for T9). `keryx shell` never sets it either — an operator is present
      // at a real terminal there, and an ACP client is that same operator
      // here, just over a different transport. Setting `unattended: true`
      // would intercept `ask_user` and turn budget exhaustion into a silent
      // TerminalState instead of a question the client could ever be asked.
      // `requestApproval` IS now set on the `AgentIO` this turn runs with (T9,
      // below): it forwards to `session/request_permission`. `unattended` must
      // stay unset for that to mean anything — the two undo each other exactly
      // as F-4 warned, since `unattended` intercepts the very questions this
      // wire exists to carry.
    };

    // AC4 / F-5, F-12, F-14 (context.md): one `AbortController` per in-flight
    // turn, keyed by session id, so `session/cancel` — a NOTIFICATION that can
    // arrive on any later line while this handler is still suspended (F-12: the
    // read loop never awaits a handler before reading the next line) — has
    // something to reach. `RunAgentTurnResult.finishReason` never distinguishes
    // an abort from a clean toolless finish (both are `undefined`), so
    // `turn.cancelled` is the ONLY record of "this exact turn was cancelled" and
    // it is set by `handleSessionCancel`, never inferred from the result below.
    const turn: AcpActiveTurn = {
      controller: new AbortController(),
      cancelled: false,
      permissionRequestIds: new Set(),
    };
    activeTurns.set(sessionId, turn);
    try {
      // The dials `session/new`/`session/load` started — bounded by each
      // server's handshake budget — must have settled before the turn, or the
      // first turn would search an empty catalog. Awaited only AFTER the slot
      // is taken, so the busy guard above still holds while this waits.
      await sessionMcp.get(sessionId)?.mcp.ready;
      const io = createAcpAgentIo(sessionId, sendUpdate, askPermissionFor(sessionId, turn));
      const result = await runAgentTurn(io, deps, state.history, userLine, { signal: turn.controller.signal });
      const updatedHandle = persistHistory(state.handle, state.history, {
        provider: options.providerId,
        model: options.modelId,
      });
      registry.updateHandle(sessionId, updatedHandle);
      // `turn.cancelled` wins over whatever `finishReason` came back: a turn
      // `session/cancel` interrupted reports `cancelled` even though
      // `runAgentTurn`'s abort paths all return `finishReason: undefined` —
      // the SAME value an ordinary toolless finish returns (F-5) — which
      // `finishReasonToStopReason` alone would read as `end_turn`.
      return { stopReason: turn.cancelled ? "cancelled" : finishReasonToStopReason(result.finishReason) };
    } finally {
      // Released on EVERY exit path — a normal finish, a thrown error, and a
      // cancelled turn alike — or the session would stay "busy" for the rest
      // of the connection and every later prompt would be refused.
      //
      // No further `session/cancel` for this turn is meaningful once it has
      // finished (there is nothing left running to stop, and nothing left
      // pending to settle — `askPermissionFor` already removes its own
      // request id from `turn.permissionRequestIds` as each ask settles).
      // Only THIS turn's own slot is released: deleting by id alone would, if
      // the busy guard above ever regressed, hand a later turn's slot away.
      if (activeTurns.get(sessionId) === turn) {
        activeTurns.delete(sessionId);
      }
    }
  }

  /**
   * `session/cancel` (flow 285, T10 — AC4). A NOTIFICATION: no reply, ever —
   * the turn's eventual `session/prompt` response IS the acknowledgement, and
   * it carries `stopReason: "cancelled"` because this handler set
   * `turn.cancelled` before that response was computed.
   *
   * Two effects, both synchronous with respect to THIS line's dispatch (F-12:
   * this handler itself never awaits anything that could let another line's
   * dispatch interleave before both have run):
   *
   *   1. `turn.controller.abort()` — the same `AbortSignal` a local hard-stop
   *      uses. Every `isAborted()` check inside `runAgentTurn` (`commands/
   *      agent.ts`) starts returning true from here on, so no FURTHER
   *      `session/update` for this turn is emitted once the turn's current
   *      unit of work (a streaming round, or an already-dispatched tool call)
   *      finishes — exactly the local-abort shape AC4 asks to match.
   *   2. F-14: settles every one of THIS turn's own outstanding
   *      `session/request_permission` requests as a local denial
   *      (`AcpClientRequests.cancel`, scoped to this turn's own request ids —
   *      never `close()`, which would also deny every OTHER session's live
   *      questions). `askPermissionFor` already treats a "closed" outcome as
   *      a denial, so the pending `requestApproval` call this unblocks
   *      resolves `false` — the tool does not run — and the turn then stops
   *      at its next `isAborted()` check via effect 1. Per context.md F-14,
   *      keryx sends no `$/cancel_request` to the client for the request it
   *      is abandoning; a client that wants out of answering it can itself
   *      answer `cancelled`, which is already mapped to the same denial.
   *
   * An unknown or already-finished `sessionId` is not an error — the turn it
   * would have cancelled is simply not running any more (or never was), which
   * is not distinguishable from "cancel arrived one tick too late" and is
   * logged, not refused (this is a notification; there is nothing to refuse
   * TO).
   */
  function handleSessionCancel(params: unknown): void {
    const obj = requireObjectParams(params, ACP_AGENT_METHODS.sessionCancel);
    const sessionId = requireStringField(obj, "sessionId", ACP_AGENT_METHODS.sessionCancel);
    const turn = activeTurns.get(sessionId);
    if (turn === undefined) {
      options.logError(
        `acp: ${ACP_AGENT_METHODS.sessionCancel} for ${sessionId}: no turn is currently running for this session`,
      );
      return;
    }
    turn.cancelled = true;
    turn.controller.abort();
    for (const requestId of turn.permissionRequestIds) {
      clientRequests.cancel(requestId, "the turn was cancelled by session/cancel");
    }
    turn.permissionRequestIds.clear();
  }

  /**
   * `session/list` (flow 285, T10 — AC5). `listSessions()`'s own store is the
   * one `keryx shell`, `keryx sessions` and `session/new`/`session/load` all
   * share — a session created through any of them is visible here.
   *
   * F-7 (context.md): ACP's `cwd` is an optional FILTER ("omit it and get
   * every session"), but `listSessions(cwd, ...)` is project-isolated by
   * construction and keryx has no cross-project listing to fall back to.
   * Recommended reading, applied here: an omitted `cwd` lists the sessions of
   * the ACP PROCESS's own project root (`resolveProjectRoot(process.cwd())`)
   * rather than refusing an optional parameter, which is its own conformance
   * break. `cursor`/pagination has no keryx equivalent either — every call
   * answers a single page and never sets `nextCursor`, which the spec allows.
   */
  function handleSessionList(params: unknown): AcpListSessionsResponse {
    requireInitialized(ACP_AGENT_METHODS.sessionList);
    const obj = requireObjectParams(params, ACP_AGENT_METHODS.sessionList);
    const rawCwd = obj["cwd"];
    if (rawCwd !== undefined && rawCwd !== null && typeof rawCwd !== "string") {
      refuse(invalidParams(`${ACP_AGENT_METHODS.sessionList}: cwd must be a string, null or omitted`, { received: rawCwd }));
    }
    const cwd = typeof rawCwd === "string" && rawCwd.length > 0 ? rawCwd : process.cwd();
    const summaries = listSessions(cwd, options.dataDir);
    const sessions: AcpSessionInfo[] = summaries.map((summary) => ({
      sessionId: summary.id,
      // F-6: the RESOLVED project root the session is actually bound to
      // (`summary.projectPath`), never a requested cwd this listing did not
      // even take per-session — honest, and consistent with what
      // `session/load`'s own cwd check compares against.
      cwd: summary.projectPath,
      title: summary.title,
      updatedAt: summary.updatedAt,
    }));
    return { sessions };
  }

  /**
   * Replays one durable session's history as `session/update` notifications,
   * in order, BEFORE `session/load` responds (the spec requires the replay to
   * precede the response). Flow 285, T10 — AC5, F-9.
   *
   * The role mapping F-9 asks every implementation to decide explicitly:
   *
   *   `user`      -> `user_message_chunk` (skipped when the content is empty —
   *                  mirrors `AgentIO.write`/`onSystem`'s own "nothing to
   *                  say" no-op below).
   *   `assistant` -> `agent_message_chunk` for the text (if any), followed by
   *                  one `tool_call` per `NormalizedToolCall` the round made
   *                  — using the SAME `toolKindFor`/`tryParseJson` a LIVE
   *                  turn's `onToolCall` uses (`agent-io.ts`), so a replayed
   *                  call and a live one look identical on the wire. Status
   *                  `pending` until the matching `tool` message (below)
   *                  updates it — it is never left there if one exists.
   *   `tool`      -> `tool_call_update` for the call it answers
   *                  (`toolCallId`), status `completed`. A `NormalizedMessage`
   *                  keeps no separate success/failure marker once persisted
   *                  (only the text content, which may itself say "not
   *                  executed" or similar) — `completed` is the honest
   *                  approximation available from stored history; a message
   *                  with no matching prior `tool_call` (a transcript hand-
   *                  edited or from a schema this replay does not expect)
   *                  still gets a fresh `tool_call`/`tool_call_update` pair
   *                  rather than being dropped.
   *   `system`    -> DROPPED. F-9: system has no ACP chunk home at all, and
   *                  replaying it as a `user_message_chunk` or
   *                  `agent_message_chunk` would misattribute it as something
   *                  the human or the model said. The drop is explicit (this
   *                  comment, and `capability-tools.ts`-style documentation)
   *                  rather than an accidental fallthrough.
   */
  function replayHistory(sessionId: string, history: readonly NormalizedMessage[]): void {
    for (const message of history) {
      if (message.role === "system") {
        continue;
      }
      if (message.role === "user") {
        if (message.content.length > 0) {
          sendUpdate(sessionId, { sessionUpdate: "user_message_chunk", content: textBlock(message.content) });
        }
        continue;
      }
      if (message.role === "assistant") {
        if (message.content.length > 0) {
          sendUpdate(sessionId, { sessionUpdate: "agent_message_chunk", content: textBlock(message.content) });
        }
        for (const call of message.toolCalls ?? []) {
          sendUpdate(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId: call.id,
            title: call.name,
            name: call.name,
            kind: toolKindFor(call.name),
            status: "pending",
            rawInput: tryParseJson(call.arguments),
          });
        }
        continue;
      }
      // message.role === "tool"
      const toolCallId = message.toolCallId ?? randomUUID();
      sendUpdate(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [{ type: "content", content: textBlock(message.content) }],
        rawOutput: message.content,
      });
    }
  }

  /**
   * `session/load` (flow 285, T10 — AC5). Loads a durable session created
   * through ANY entry point into that store (`keryx shell`, `keryx sessions`,
   * an earlier `session/new`) and replays it before responding.
   */
  function handleSessionLoad(params: unknown, requestId: JsonRpcId): AcpLoadSessionResponse {
    requireInitialized(ACP_AGENT_METHODS.sessionLoad);
    requireProvider(ACP_AGENT_METHODS.sessionLoad);
    const obj = requireObjectParams(params, ACP_AGENT_METHODS.sessionLoad);
    const sessionId = requireStringField(obj, "sessionId", ACP_AGENT_METHODS.sessionLoad);
    const cwd = requireStringField(obj, "cwd", ACP_AGENT_METHODS.sessionLoad);
    // Validated up front (same split as `session/new`); nothing is STARTED
    // until the load has succeeded, so a refused load spawns nothing.
    const parsedMcp = parseAcpMcpServers(ACP_AGENT_METHODS.sessionLoad, obj["mcpServers"]);
    // A load REPLACES the registry entry, and with it the `history` array a
    // turn in flight is still writing into — refused for the same reason a
    // second prompt is (`refuseIfBusy`), and before `registry.load` does any
    // work.
    refuseIfBusy(ACP_AGENT_METHODS.sessionLoad, sessionId);
    let state: ReturnType<typeof registry.load>;
    try {
      state = registry.load(sessionId, cwd, clientCapabilities);
    } catch (cause) {
      if (!(cause instanceof AcpSessionTranscriptUnreadableError)) {
        throw cause;
      }
      // The session exists but its transcript could not be read — a distinct,
      // actionable answer, not `resourceNotFound` (that would say "no such
      // session", which is false) and not a silent resume into an empty
      // history (the one thing `TranscriptUnreadableError` exists to prevent).
      refuse({
        code: JSON_RPC_ERROR_CODES.internalError,
        message: `Cannot load session ${sessionId}: ${cause.cause.message}`,
        data: { sessionId, cwd, file: cause.cause.file, reason: cause.cause.reason },
      });
    }
    if (state === undefined) {
      refuse({
        code: JSON_RPC_ERROR_CODES.resourceNotFound,
        message: `Unknown ACP session: ${sessionId}`,
        data: { sessionId, cwd },
      });
    }
    // Replay BEFORE responding — the spec's own ordering requirement.
    replayHistory(sessionId, state.history);
    // The load REPLACES the session's entry, so it replaces its MCP servers
    // too: whatever an earlier `session/new`/`session/load` on this connection
    // started for this id is stopped, and this request's list is started.
    bindSessionMcp(sessionId, requestId, parsedMcp, state.resolvedRoot);
    return {};
  }

  const dispatcher = new AcpDispatcher(
    {
      requests: {
        [ACP_AGENT_METHODS.initialize]: (params) => handleInitialize(params),
        [ACP_AGENT_METHODS.sessionNew]: (params, context) => handleSessionNew(params, context.id),
        [ACP_AGENT_METHODS.sessionPrompt]: (params) => handleSessionPrompt(params),
        [ACP_AGENT_METHODS.sessionList]: (params) => handleSessionList(params),
        [ACP_AGENT_METHODS.sessionLoad]: (params, context) => handleSessionLoad(params, context.id),
      },
      notifications: {
        [ACP_AGENT_METHODS.sessionCancel]: (params) => handleSessionCancel(params),
      },
    },
    {
      onUnhandledNotification: (method) => options.logError(`acp: unhandled notification ${method}`),
      onHandlerError: (method, error) =>
        options.logError(`acp: ${method} failed: ${error instanceof Error ? error.message : String(error)}`),
    },
  );

  const handleOutcome = (outcome: AcpDispatchOutcome): void => {
    if (outcome.kind === "reply") {
      writeMessage(outcome.message);
      const key = replyKey(outcome.message.id);
      const after = afterReply.get(key);
      if (after !== undefined) {
        afterReply.delete(key);
        // Only a SUCCESS reply has a session to report on. (The hook is
        // registered only once a handler has succeeded, so this is a floor.)
        if (!("error" in outcome.message)) {
          after();
        }
      }
      return;
    }
    if (outcome.kind === "incoming-response") {
      // A `session/request_permission` answer arrives here. The pending table
      // owns it; anything it does not claim is unsolicited or duplicate and is
      // reported rather than dropped.
      if (!clientRequests.resolve(outcome.message)) {
        options.logError(`acp: unexpected response with no pending request: ${JSON.stringify(outcome.message)}`);
      }
    }
  };

  /**
   * Lines are STARTED in order and AWAITED separately.
   *
   * This loop used to `await` each line's dispatch before reading the next
   * one, which was fine while every handler answered out of its own state. It
   * deadlocks the moment keryx asks the client something: `session/prompt`
   * blocks on `session/request_permission`, whose answer is the NEXT LINE ON
   * STDIN — a line a loop parked inside the prompt handler will never read.
   *
   * Not awaiting does not reorder anything that matters. `handleLine` runs
   * synchronously into the handler body (through `handleMessage` ->
   * `handleRequest` -> `handler(...)`), so handlers still START in wire order,
   * and `session/new` — which is synchronous end to end — has finished
   * registering its session before the next line is even decoded. What changes
   * is only that a handler which SUSPENDS no longer suspends the reader with
   * it. JSON-RPC ids carry the correlation, so replies may land in completion
   * order.
   */
  const inflight = new Set<Promise<unknown>>();
  const dispatch = (line: string): void => {
    const task = dispatcher.handleLine(line).then(handleOutcome, (error: unknown) => {
      // `handleLine` is documented as total, so this is a floor, not a path.
      options.logError(`acp: dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    inflight.add(task);
    void task.finally(() => {
      inflight.delete(task);
    });
  };

  const framer = new AcpLineFramer();
  const readLoop = async (): Promise<void> => {
    for await (const chunk of options.input) {
      let lines: string[];
      try {
        lines = framer.push(chunk);
      } catch (error) {
        options.logError(`acp: framing error: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      for (const line of lines) {
        dispatch(line);
      }
    }
    for (const line of framer.flush()) {
      dispatch(line);
    }
  };

  // `shutdown` (flow 287): the CLI aborts it on SIGTERM/SIGINT — editors stop
  // an agent by signalling it far more often than by closing its stdin. A
  // pending `for await` over stdin cannot be interrupted, so the loop is RACED
  // against the abort instead of waiting for a line that will never come.
  const shutdown = options.shutdown;
  const shutdownRequested = new Promise<"shutdown">((resolve) => {
    if (shutdown === undefined) return;
    if (shutdown.aborted) resolve("shutdown");
    else shutdown.addEventListener("abort", () => resolve("shutdown"), { once: true });
  });

  try {
    const ended = await Promise.race([readLoop().then(() => "eof" as const), shutdownRequested]);

    // Input has ended (or the process is being stopped): no answer can arrive
    // any more. Every question still open settles as a denial NOW rather than
    // waiting on a pipe that is closed — that is the difference between a turn
    // that finishes refusing a tool call and a process that hangs holding one.
    clientRequests.close("the client closed the connection before answering");
    if (ended === "shutdown") {
      // Stopping: every running turn is aborted the way `session/cancel`
      // aborts one, and not waited for — the process is about to exit.
      for (const turn of activeTurns.values()) {
        turn.cancelled = true;
        turn.controller.abort();
      }
    } else {
      // A turn started before the close still has a response to write, and the
      // stream it writes to is still open. Draining is what makes the denial
      // observable to the client instead of dying with the process.
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
    }
  } finally {
    // Flow 287, AC3: every MCP server process this connection started is
    // stopped, and AWAITED — on a clean end of input, on a read loop that
    // throws, and on `shutdown`. Returning first would orphan the children.
    await closeAllMcp();
  }
}

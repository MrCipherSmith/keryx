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
import { AcpSessionRegistry } from "./session";

export interface AcpServerOptions {
  readonly input: AsyncIterable<Uint8Array | string>;
  readonly write: (chunk: string) => void;
  readonly logError: (line: string) => void;
  readonly provider: ProviderPort;
  readonly providerId: string;
  readonly modelId: string;
  readonly agentInfo?: AcpImplementation;
  readonly dataDir?: string;
  readonly idSeq?: () => string;
}

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

  function handleSessionNew(params: unknown): AcpNewSessionResponse {
    requireInitialized(ACP_AGENT_METHODS.sessionNew);
    const obj = requireObjectParams(params, ACP_AGENT_METHODS.sessionNew);
    const cwd = requireStringField(obj, "cwd", ACP_AGENT_METHODS.sessionNew);
    const mcpServers = obj["mcpServers"];
    if (mcpServers !== undefined && !Array.isArray(mcpServers)) {
      refuse(invalidParams(`${ACP_AGENT_METHODS.sessionNew}: mcpServers must be an array`, { received: mcpServers }));
    }
    if (Array.isArray(mcpServers) && mcpServers.length > 0) {
      // F-8 (context.md §5): no in-memory MCP registration seam exists for a
      // single session — an honest refusal, not a silent drop that would
      // leave the client believing tools are connected that are not.
      refuse(
        invalidParams(
          `${ACP_AGENT_METHODS.sessionNew}: keryx has no in-memory MCP server registration seam for a single ` +
            "session; configure servers with `keryx mcp`/`keryx integrate` (project-wide) and omit mcpServers, " +
            "or send an empty list",
          { requestedServers: mcpServers.length },
        ),
      );
    }
    const state = registry.create(cwd, clientCapabilities);
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
    // denials. Nothing else is added: `spawn_subagent`, the metaproject tools,
    // MCP and bus tools need ports this server does not construct, and
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
    ];
    const toolNames = tools.map((tool) => tool.definition.name);
    const deps: AgentDeps = {
      provider: options.provider,
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
      // No further `session/cancel` for this turn is meaningful once it has
      // finished (there is nothing left running to stop, and nothing left
      // pending to settle — `askPermissionFor` already removes its own
      // request id from `turn.permissionRequestIds` as each ask settles).
      activeTurns.delete(sessionId);
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
  function handleSessionLoad(params: unknown): AcpLoadSessionResponse {
    requireInitialized(ACP_AGENT_METHODS.sessionLoad);
    const obj = requireObjectParams(params, ACP_AGENT_METHODS.sessionLoad);
    const sessionId = requireStringField(obj, "sessionId", ACP_AGENT_METHODS.sessionLoad);
    const cwd = requireStringField(obj, "cwd", ACP_AGENT_METHODS.sessionLoad);
    const mcpServers = obj["mcpServers"];
    if (mcpServers !== undefined && !Array.isArray(mcpServers)) {
      refuse(invalidParams(`${ACP_AGENT_METHODS.sessionLoad}: mcpServers must be an array`, { received: mcpServers }));
    }
    if (Array.isArray(mcpServers) && mcpServers.length > 0) {
      // Same F-8 reasoning as `session/new`: no in-memory MCP registration
      // seam exists for a single session.
      refuse(
        invalidParams(
          `${ACP_AGENT_METHODS.sessionLoad}: keryx has no in-memory MCP server registration seam for a single ` +
            "session; configure servers with `keryx mcp`/`keryx integrate` (project-wide) and omit mcpServers, " +
            "or send an empty list",
          { requestedServers: mcpServers.length },
        ),
      );
    }
    const state = registry.load(sessionId, cwd, clientCapabilities);
    if (state === undefined) {
      refuse({
        code: JSON_RPC_ERROR_CODES.resourceNotFound,
        message: `Unknown ACP session: ${sessionId}`,
        data: { sessionId, cwd },
      });
    }
    // Replay BEFORE responding — the spec's own ordering requirement.
    replayHistory(sessionId, state.history);
    return {};
  }

  const dispatcher = new AcpDispatcher(
    {
      requests: {
        [ACP_AGENT_METHODS.initialize]: (params) => handleInitialize(params),
        [ACP_AGENT_METHODS.sessionNew]: (params) => handleSessionNew(params),
        [ACP_AGENT_METHODS.sessionPrompt]: (params) => handleSessionPrompt(params),
        [ACP_AGENT_METHODS.sessionList]: (params) => handleSessionList(params),
        [ACP_AGENT_METHODS.sessionLoad]: (params) => handleSessionLoad(params),
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

  // Input has ended: no answer can arrive any more. Every question still open
  // settles as a denial NOW rather than waiting on a pipe that is closed —
  // that is the difference between a turn that finishes refusing a tool call
  // and a process that hangs holding one.
  clientRequests.close("the client closed the connection before answering");
  // A turn started before the close still has a response to write, and the
  // stream it writes to is still open. Draining is what makes the denial
  // observable to the client instead of dying with the process.
  while (inflight.size > 0) {
    await Promise.allSettled([...inflight]);
  }
}

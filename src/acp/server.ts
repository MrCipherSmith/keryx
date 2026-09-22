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
import type { ProviderPort } from "../harness/provider/types";
import { persistHistory } from "../session";
import { createAcpAgentIo, type AcpPermissionAsker } from "./agent-io";
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
  type AcpClientCapabilities,
  type AcpImplementation,
  type AcpInitializeResponse,
  type AcpNewSessionResponse,
  type AcpPromptResponse,
  type AcpRequestPermissionRequest,
  type AcpRequestPermissionResponse,
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

  /** Shapes, sends and interprets one `session/request_permission`. `undefined` = could not be asked. */
  const askPermissionFor = (sessionId: string): AcpPermissionAsker => {
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
      const outcome = await clientRequests.request(ACP_CLIENT_METHODS.sessionRequestPermission, params);
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
    const tools: InteractiveTool[] = [
      ...builtinReadOnlyTools(state.resolvedRoot),
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

    const io = createAcpAgentIo(sessionId, sendUpdate, askPermissionFor(sessionId));
    const result = await runAgentTurn(io, deps, state.history, userLine, {});
    const updatedHandle = persistHistory(state.handle, state.history, {
      provider: options.providerId,
      model: options.modelId,
    });
    registry.updateHandle(sessionId, updatedHandle);
    return { stopReason: finishReasonToStopReason(result.finishReason) };
  }

  const dispatcher = new AcpDispatcher(
    {
      requests: {
        [ACP_AGENT_METHODS.initialize]: (params) => handleInitialize(params),
        [ACP_AGENT_METHODS.sessionNew]: (params) => handleSessionNew(params),
        [ACP_AGENT_METHODS.sessionPrompt]: (params) => handleSessionPrompt(params),
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

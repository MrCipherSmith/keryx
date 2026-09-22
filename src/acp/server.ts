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
import { builtinReadOnlyTools, type InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { ProviderPort } from "../harness/provider/types";
import { persistHistory } from "../session";
import { createAcpAgentIo } from "./agent-io";
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
    const tools: InteractiveTool[] = builtinReadOnlyTools(state.resolvedRoot);
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
      // `requestApproval` is still unset on the `AgentIO` this turn runs with
      // (T9's scope) — until it lands, `AgentIO`'s own documented
      // default-deny floor (independent of `unattended`) is what keeps a
      // shell/destructive tool call from running unapproved, never a policy
      // context this dispatch would otherwise have to fake.
    };

    const io = createAcpAgentIo(sessionId, sendUpdate);
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
      // This connection never SENDS a request to the client in T7/T8 (no
      // `session/request_permission`, `fs/*`, `terminal/*` calls yet — later
      // dispatches of this flow add those), so a response arriving here is
      // unexpected. Logged, not dropped silently.
      options.logError(`acp: unexpected response with no pending request: ${JSON.stringify(outcome.message)}`);
    }
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
      handleOutcome(await dispatcher.handleLine(line));
    }
  }
  for (const line of framer.flush()) {
    handleOutcome(await dispatcher.handleLine(line));
  }
}

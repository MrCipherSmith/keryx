// keryx as an ACP CLIENT: the supervisor for one foreign ACP agent run
// (flow 292, T5-T7). Package: docs/requirements/keryx-external-agent-runtime.
//
// THE THIRD SUPERVISION PATH. `superviseExternalRun` (`./supervise.ts`) reads a
// one-way stdout through a pure codec; `superviseCodexMcpRun`
// (`./supervise-mcp.ts`) drives `codex mcp-server`. An ACP agent fits neither: it
// is a two-way JSON-RPC peer that calls BACK into keryx — to ask permission, to
// read and write files — and blocks until keryx answers. No codec can answer.
//
// It reuses the one impure seam the other paths share: `ExternalSpawnPort`
// (`./supervise.ts`), which already hands over stdout as complete lines plus a
// stdin writer — exactly ACP's newline-delimited framing. The wire layer is the
// one `keryx acp` (keryx as an ACP AGENT) already ships: `protocol.ts` types,
// `jsonrpc.ts` envelopes, `framing.ts` encoding, `dispatch.ts` routing and
// `client-requests.ts`' settle-exactly-once pending table.
//
// What keryx advertises (`clientCapabilities`) is exactly what it serves:
// `fs.readTextFile`, `fs.writeTextFile` only on a `--write` run, never
// `terminal`, never `elicitation`. Anything else the agent calls is answered with
// a named error and recorded. What the agent does through its OWN tools never
// reaches this wire — see `./acp-fs.ts`'s header and the docs page.
//
// The output is the same `ExternalEvent` vocabulary every external child folds
// onto, plus side records (permission decisions, fs requests, usage/cost) that
// the runtime persists — the same "decisions are records, not events" split
// `supervise-mcp.ts` makes for elicitations.

import { AcpClientRequests, type AcpClientRequestOutcome } from "../../acp/client-requests";
import { AcpDispatcher } from "../../acp/dispatch";
import { encodeAcpMessage } from "../../acp/framing";
import {
  AcpError,
  JSON_RPC_ERROR_CODES,
  methodNotFound,
  notificationMessage,
  type JsonRpcMessage,
} from "../../acp/jsonrpc";
import {
  ACP_AGENT_METHODS,
  ACP_CLIENT_METHODS,
  ACP_PROTOCOL_VERSION,
  ACP_SUPPORTED_PROTOCOL_VERSIONS,
  requireObjectParams,
  type AcpAgentCapabilities,
  type AcpClientCapabilities,
  type AcpContentBlock,
  type AcpImplementation,
  type AcpMcpServer,
  type AcpPermissionOption,
  type AcpSessionUpdate,
  type AcpStopReason,
  type AcpToolCallUpdate,
} from "../../acp/protocol";
import type { AgentIO } from "../../commands/agent";
import {
  answerAcpPermission,
  type AcpModeClamp,
  type AcpPermissionDecision,
} from "./acp-permission";
import {
  ACP_REFUSED_CLIENT_METHODS,
  confineAcpPath,
  readTextFileInWorktree,
  refusedMethodError,
  writeTextFileInWorktree,
  type AcpFsRequestRecord,
} from "./acp-fs";
import type { ExternalSpawnPort } from "./supervise";
import type { ExternalEvent } from "./types";

/** Grace given to the agent after `session/cancel`, and to its exit after a kill. */
export const DEFAULT_ACP_KILL_GRACE_MS = 2_000;

/** The capabilities keryx advertises. Exactly what it serves — see the header. */
export function acpClientCapabilities(write: boolean): AcpClientCapabilities {
  return { fs: { readTextFile: true, writeTextFile: write }, terminal: false };
}

/** A text resource offered as embedded context. */
export interface AcpEmbeddedResource {
  readonly uri: string;
  readonly text: string;
  readonly mimeType?: string;
}

export interface SuperviseAcpInput {
  /** The agent's argv — binary plus its ACP-mode flags. */
  readonly argv: readonly string[];
  /** Absolute path of the disposable worktree: the process cwd AND `session/new.cwd`. */
  readonly cwd: string;
  /** The stripped child environment (`buildExternalChildEnv`). */
  readonly env: Record<string, string>;
  /** The first prompt's text (`buildExternalPrompt`). */
  readonly prompt: string;
  /** Context attached as `resource` blocks when the agent advertises `embeddedContext`, inlined as text otherwise. */
  readonly embeddedResources?: readonly AcpEmbeddedResource[];
  /** `session/new.mcpServers` — keryx's own read-only MCP server, or nothing. */
  readonly mcpServers: readonly AcpMcpServer[];
  /** Advertise and serve `fs/write_text_file` (a `--write` run). */
  readonly write: boolean;
  /** Wall-clock ceiling for the whole run. */
  readonly timeoutMs: number;
  readonly killGraceMs?: number;
  readonly clientInfo?: AcpImplementation;
  readonly permission: {
    readonly mode: AcpModeClamp;
    readonly unattended: boolean;
    readonly approvalTimeoutMs?: number;
  };
}

export interface SuperviseAcpDeps {
  readonly spawn: ExternalSpawnPort;
  /** The session's approver. Absent means every question that needs a human is refused. */
  readonly requestApproval?: AgentIO["requestApproval"];
  readonly onEvent?: (event: ExternalEvent) => void;
  readonly onDecision?: (decision: AcpPermissionDecision) => void;
  readonly onFsRequest?: (record: AcpFsRequestRecord) => void;
  /** Request-id source; injectable for deterministic tests. */
  readonly idSeq?: () => string;
}

/** Token usage as `usage_update` reported it. */
export interface AcpUsage {
  readonly used: number;
  readonly size: number;
}

/** Cost exactly as reported — never converted, never defaulted. */
export interface AcpCost {
  readonly amount: number;
  readonly currency: string;
}

/** One tool call the agent announced, as last updated. */
export interface AcpToolCallRecord {
  readonly toolCallId: string;
  readonly title?: string;
  readonly kind?: string;
  readonly status?: string;
}

export interface SuperviseAcpOutcome {
  readonly status: "completed" | "failed" | "timeout";
  /** Why the run did not complete, in operator words. */
  readonly failure?: string;
  readonly stopReason?: AcpStopReason;
  readonly events: readonly ExternalEvent[];
  readonly decisions: readonly AcpPermissionDecision[];
  readonly fsRequests: readonly AcpFsRequestRecord[];
  readonly toolCalls: readonly AcpToolCallRecord[];
  /** Everything the agent said, concatenated in arrival order. */
  readonly assistantText: string;
  readonly protocolVersion?: number;
  readonly agentInfo?: AcpImplementation;
  readonly agentCapabilities?: AcpAgentCapabilities;
  readonly clientCapabilities: AcpClientCapabilities;
  readonly sessionId?: string;
  /** Whether context went as `resource` blocks (the agent advertised `embeddedContext`). */
  readonly embeddedContextSent: boolean;
  readonly usage?: AcpUsage;
  readonly cost?: AcpCost;
  readonly cancelSent: boolean;
  readonly killed: boolean;
  readonly exitCode?: number;
  readonly stderr: string;
}

const TIMEOUT = Symbol("timeout");

function afterMs(ms: number): { readonly promise: Promise<typeof TIMEOUT>; readonly cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<typeof TIMEOUT>((resolve) => {
    handle = setTimeout(() => resolve(TIMEOUT), Math.max(0, ms));
  });
  return { promise, cancel: () => handle !== undefined && clearTimeout(handle) };
}

function describeOutcome(outcome: AcpClientRequestOutcome): string {
  if (outcome.kind === "error") return `${outcome.error.message} (code ${outcome.error.code})`;
  if (outcome.kind === "closed") return outcome.reason;
  return "an unexpected result";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function short(value: unknown, max = 500): string {
  const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function readOptions(raw: unknown): AcpPermissionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (option): option is AcpPermissionOption =>
      isObject(option) && typeof option["optionId"] === "string" && typeof option["kind"] === "string",
  );
}

/** Options keryx offers itself when it gates a write the agent asked for over `fs/write_text_file`. */
const WRITE_GATE_OPTIONS: readonly AcpPermissionOption[] = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];

/**
 * Run one foreign ACP agent: spawn, `initialize`, `session/new`,
 * `session/prompt`, answer every call it makes back, and return what happened.
 *
 * Never throws for a failed run. `deps.spawn.spawn` may throw — a port that
 * cannot create a process is broken — and that propagates to the runtime, which
 * cleans up the worktree on every path.
 */
export async function superviseAcpRun(input: SuperviseAcpInput, deps: SuperviseAcpDeps): Promise<SuperviseAcpOutcome> {
  const clientCapabilities = acpClientCapabilities(input.write);
  const graceMs = input.killGraceMs ?? DEFAULT_ACP_KILL_GRACE_MS;
  const child = deps.spawn.spawn(input.argv, { cwd: input.cwd, env: input.env, stdin: "pipe" });

  const events: ExternalEvent[] = [];
  const decisions: AcpPermissionDecision[] = [];
  const fsRequests: AcpFsRequestRecord[] = [];
  const toolCalls = new Map<string, AcpToolCallRecord>();
  const stderr: string[] = [];
  let assistantText = "";
  let usage: AcpUsage | undefined;
  let cost: AcpCost | undefined;
  let killed = false;
  let exitCode: number | undefined;

  const emit = (event: ExternalEvent): void => {
    events.push(event);
    deps.onEvent?.(event);
  };
  const recordFs = (record: AcpFsRequestRecord): void => {
    fsRequests.push(record);
    deps.onFsRequest?.(record);
  };
  const recordDecision = (decision: AcpPermissionDecision): void => {
    decisions.push(decision);
    deps.onDecision?.(decision);
  };
  const send = (message: JsonRpcMessage): void => {
    try {
      child.writeStdin(encodeAcpMessage(message));
    } catch (error) {
      stderr.push(`[keryx] write to the agent failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  let seq = 0;
  const requests = new AcpClientRequests({
    send,
    idSeq: deps.idSeq ?? (() => String((seq += 1))),
    idPrefix: "keryx-client-",
  });

  const permissionContext = {
    worktree: input.cwd,
    mode: input.permission.mode,
    unattended: input.permission.unattended,
    ...(deps.requestApproval === undefined ? {} : { requestApproval: deps.requestApproval }),
    ...(input.permission.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: input.permission.approvalTimeoutMs }),
  };

  const served = [
    ACP_CLIENT_METHODS.sessionRequestPermission,
    ACP_CLIENT_METHODS.fsReadTextFile,
    ...(input.write ? [ACP_CLIENT_METHODS.fsWriteTextFile] : []),
  ];
  const dispatcher = new AcpDispatcher(
    {},
    {
      unknownMethodError: (method) => {
        recordFs({ method, outcome: "refused", reason: "keryx as an ACP client does not serve this method" });
        return methodNotFound(method, { reason: "keryx as an ACP client does not serve this method", served });
      },
      onUnhandledNotification: (method) => stderr.push(`[keryx] unhandled notification from the agent: ${method}`),
      onHandlerError: (method, error) => {
        if (!(error instanceof AcpError)) {
          stderr.push(`[keryx] ${method} handler failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    },
  );

  // session/request_permission — the policy bridge.
  dispatcher.onRequest(ACP_CLIENT_METHODS.sessionRequestPermission, async (params, context) => {
    const p = isObject(params) ? params : {};
    const rawToolCall = p["toolCall"];
    const toolCall: AcpToolCallUpdate =
      isObject(rawToolCall) && typeof rawToolCall["toolCallId"] === "string"
        ? (rawToolCall as unknown as AcpToolCallUpdate)
        : { toolCallId: "unidentified" };
    const { answer, decision } = await answerAcpPermission(
      { requestId: context.id, toolCall, options: readOptions(p["options"]) },
      permissionContext,
    );
    recordDecision(decision);
    return { outcome: answer.outcome };
  });

  // fs/read_text_file — served from the worktree only.
  dispatcher.onRequest(ACP_CLIENT_METHODS.fsReadTextFile, async (params) => {
    const method = ACP_CLIENT_METHODS.fsReadTextFile;
    const p = isObject(params) ? params : {};
    try {
      const { content } = await readTextFileInWorktree(input.cwd, p);
      recordFs({ method, path: String(p["path"]), outcome: "served", bytes: Buffer.byteLength(content, "utf8") });
      return { content };
    } catch (error) {
      recordFs({ method, path: String(p["path"]), outcome: "refused", reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  // fs/write_text_file — refused unless advertised; then confined AND gated.
  dispatcher.onRequest(ACP_CLIENT_METHODS.fsWriteTextFile, async (params, context) => {
    const method = ACP_CLIENT_METHODS.fsWriteTextFile;
    const p = isObject(params) ? params : {};
    const requested = typeof p["path"] === "string" ? p["path"] : String(p["path"]);
    if (!input.write) {
      const reason = "keryx did not advertise fs.writeTextFile (a read-only run)";
      recordFs({ method, path: requested, outcome: "refused", reason });
      throw refusedMethodError(method, reason);
    }
    try {
      requireObjectParams(params, method);
      if (typeof p["content"] !== "string") {
        throw new AcpError(JSON_RPC_ERROR_CODES.invalidParams, `${method} requires a string "content"`);
      }
      const target = confineAcpPath(input.cwd, method, p["path"]);
      const { decision } = await answerAcpPermission(
        {
          requestId: context.id,
          toolCall: {
            toolCallId: `fs-write:${String(context.id)}`,
            kind: "edit",
            title: `write ${requested}`,
            locations: [{ path: target }],
          },
          options: WRITE_GATE_OPTIONS,
        },
        permissionContext,
      );
      recordDecision(decision);
      if (decision.verdict !== "approve") {
        throw new AcpError(
          JSON_RPC_ERROR_CODES.invalidRequest,
          `${method} refused: the write was not approved (${decision.reason})`,
          { reason: "permission-denied", decision: decision.reason },
        );
      }
      await writeTextFileInWorktree(target, p["content"], requested);
      recordFs({ method, path: requested, outcome: "served", bytes: Buffer.byteLength(p["content"], "utf8") });
      return {};
    } catch (error) {
      recordFs({ method, path: requested, outcome: "refused", reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  // terminal/* and elicitation/create — never advertised, answered by name.
  for (const [method, reason] of ACP_REFUSED_CLIENT_METHODS) {
    dispatcher.onRequest(method, (params) => {
      const p = isObject(params) ? params : {};
      recordFs({
        method,
        ...(typeof p["command"] === "string" ? { path: p["command"] } : {}),
        outcome: "refused",
        reason,
      });
      throw refusedMethodError(method, reason);
    });
  }
  dispatcher.onNotification(ACP_CLIENT_METHODS.elicitationComplete, () => undefined);

  // session/update — folded into ExternalEvents and the side records.
  dispatcher.onNotification(ACP_CLIENT_METHODS.sessionUpdate, (params) => {
    if (!isObject(params) || !isObject(params["update"])) return;
    foldUpdate(params["update"] as unknown as AcpSessionUpdate);
  });

  const foldUpdate = (update: AcpSessionUpdate): void => {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "user_message_chunk":
      case "agent_thought_chunk": {
        const content = update.content as AcpContentBlock | undefined;
        const text = content !== undefined && content.type === "text" ? content.text : "";
        if (text.length === 0) return;
        if (update.sessionUpdate === "agent_message_chunk") {
          assistantText += text;
          emit({ kind: "assistant_text", text });
        } else if (update.sessionUpdate === "agent_thought_chunk") {
          emit({ kind: "thinking", text });
        } else {
          emit({ kind: "user_message", text });
        }
        return;
      }
      case "tool_call": {
        toolCalls.set(update.toolCallId, {
          toolCallId: update.toolCallId,
          title: update.title,
          ...(update.kind === undefined ? {} : { kind: update.kind }),
          ...(update.status === undefined ? {} : { status: update.status }),
        });
        emit({
          kind: "tool_call",
          name: update.title,
          detail: short({ kind: update.kind ?? null, locations: update.locations ?? [], rawInput: update.rawInput ?? null }),
        });
        return;
      }
      case "tool_call_update": {
        const previous = toolCalls.get(update.toolCallId);
        const status = update.status ?? previous?.status;
        toolCalls.set(update.toolCallId, {
          toolCallId: update.toolCallId,
          ...(previous?.title === undefined && (update.title === undefined || update.title === null)
            ? {}
            : { title: update.title ?? previous?.title ?? "" }),
          ...(update.kind === undefined || update.kind === null ? (previous?.kind === undefined ? {} : { kind: previous.kind }) : { kind: update.kind }),
          ...(status === undefined || status === null ? {} : { status }),
        });
        if (update.status === "completed" || update.status === "failed") {
          emit({ kind: "tool_result", detail: `${update.status}: ${short(update.rawOutput)}` });
        }
        return;
      }
      case "usage_update": {
        if (typeof update.used === "number" && typeof update.size === "number") {
          usage = { used: update.used, size: update.size };
        }
        const reported = update.cost;
        if (isObject(reported) && typeof reported["amount"] === "number" && typeof reported["currency"] === "string") {
          cost = { amount: reported["amount"], currency: reported["currency"] };
        }
        // `costUnits` is a USD figure elsewhere in the runtime; any other currency
        // stays in the raw record only, never converted.
        emit(cost !== undefined && cost.currency === "USD" ? { kind: "usage", costUnits: cost.amount } : { kind: "usage" });
        return;
      }
      default:
        // plan, available_commands_update, current_mode_update,
        // config_option_update, session_info_update: record-only facts that
        // carry nothing the run's outcome depends on.
        return;
    }
  };

  // ---- the pumps -----------------------------------------------------------
  const inflight = new Set<Promise<void>>();
  const onLine = (line: string): void => {
    if (line.trim().length === 0) return;
    // Not awaited: a permission question may wait on a human, and the agent's
    // other messages must keep flowing meanwhile. Notifications are folded
    // synchronously inside `handleLine`, so arrival order is preserved.
    const handled = dispatcher
      .handleLine(line)
      .then((outcome) => {
        if (outcome.kind === "reply") send(outcome.message);
        else if (outcome.kind === "incoming-response" && !requests.resolve(outcome.message)) {
          stderr.push(`[keryx] unsolicited response from the agent: ${short(outcome.message, 200)}`);
        }
      })
      .catch((error: unknown) => {
        stderr.push(`[keryx] failed to handle a line from the agent: ${error instanceof Error ? error.message : String(error)}`);
      });
    inflight.add(handled);
    void handled.finally(() => inflight.delete(handled));
  };
  const stdoutDone = (async (): Promise<void> => {
    try {
      for await (const line of child.stdout) onLine(line);
    } catch (error) {
      stderr.push(`[keryx] stdout read failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      requests.close("the agent closed its stdout before answering");
    }
  })();
  void (async (): Promise<void> => {
    try {
      for await (const line of child.stderr) stderr.push(line);
    } catch {
      // A stderr read failure loses diagnostics, never the run.
    }
  })();
  const exited = child.exited.then(
    (code) => {
      exitCode = code;
      return code;
    },
    () => undefined,
  );

  const deadline = afterMs(input.timeoutMs);
  const withDeadline = <T>(promise: Promise<T>): Promise<T | typeof TIMEOUT> => Promise.race([promise, deadline.promise]);

  let protocolVersion: number | undefined;
  let agentInfo: AcpImplementation | undefined;
  let agentCapabilities: AcpAgentCapabilities | undefined;
  let sessionId: string | undefined;
  let stopReason: AcpStopReason | undefined;
  let embeddedContextSent = false;
  let cancelSent = false;
  let status: SuperviseAcpOutcome["status"] = "failed";
  let failure: string | undefined;

  const stop = async (): Promise<void> => {
    killed = true;
    child.kill();
    const grace = afterMs(graceMs);
    await Promise.race([exited, grace.promise]);
    grace.cancel();
  };

  try {
    // 1. initialize
    const init = await withDeadline(
      requests.request(ACP_AGENT_METHODS.initialize, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities,
        clientInfo: input.clientInfo ?? { name: "keryx", version: "0" },
      }),
    );
    if (init === TIMEOUT) {
      status = "timeout";
      failure = `the agent did not answer initialize within ${input.timeoutMs}ms`;
      return await finish();
    }
    if (init.kind !== "result" || !isObject(init.result)) {
      failure = `the agent did not answer initialize: ${describeOutcome(init)}`;
      return await finish();
    }
    const initResult = init.result;
    const version = initResult["protocolVersion"];
    protocolVersion = typeof version === "number" ? version : undefined;
    if (isObject(initResult["agentInfo"])) agentInfo = initResult["agentInfo"] as unknown as AcpImplementation;
    if (isObject(initResult["agentCapabilities"])) agentCapabilities = initResult["agentCapabilities"] as AcpAgentCapabilities;
    if (typeof version !== "number" || !ACP_SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      failure =
        `unsupported ACP protocol version: the agent answered initialize with protocolVersion ${JSON.stringify(version)}; ` +
        `keryx speaks ${ACP_SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`;
      return await finish();
    }

    // 2. session/new — cwd is the disposable worktree, mcpServers keryx's own.
    const created = await withDeadline(
      requests.request(ACP_AGENT_METHODS.sessionNew, { cwd: input.cwd, mcpServers: input.mcpServers }),
    );
    if (created === TIMEOUT) {
      status = "timeout";
      failure = `the agent did not answer session/new within ${input.timeoutMs}ms`;
      return await finish();
    }
    if (created.kind !== "result" || !isObject(created.result) || typeof created.result["sessionId"] !== "string") {
      failure = `the agent refused session/new: ${created.kind === "result" ? "no sessionId in the answer" : describeOutcome(created)}`;
      return await finish();
    }
    sessionId = created.result["sessionId"];
    emit({ kind: "child_started", sessionRef: sessionId });

    // 3. session/prompt
    const prompt: AcpContentBlock[] = [{ type: "text", text: input.prompt }];
    const resources = input.embeddedResources ?? [];
    if (resources.length > 0) {
      if (agentCapabilities?.promptCapabilities?.embeddedContext === true) {
        embeddedContextSent = true;
        for (const resource of resources) {
          prompt.push({
            type: "resource",
            resource: { uri: resource.uri, text: resource.text, mimeType: resource.mimeType ?? "text/markdown" },
          });
        }
      } else {
        for (const resource of resources) {
          prompt.push({ type: "text", text: `Context from ${resource.uri}:\n\n${resource.text}` });
        }
      }
    }
    const turn = requests.request(ACP_AGENT_METHODS.sessionPrompt, { sessionId, prompt });
    const answered = await withDeadline(turn);
    if (answered === TIMEOUT) {
      // Ask the agent to stop, give it the grace window to say so, then kill.
      status = "timeout";
      failure = `the run exceeded its ${input.timeoutMs}ms ceiling; session/cancel was sent and the agent was stopped`;
      send(notificationMessage(ACP_AGENT_METHODS.sessionCancel, { sessionId }));
      cancelSent = true;
      const grace = afterMs(graceMs);
      const late = await Promise.race([turn, grace.promise]);
      grace.cancel();
      if (late !== TIMEOUT && late.kind === "result" && isObject(late.result) && typeof late.result["stopReason"] === "string") {
        stopReason = late.result["stopReason"] as AcpStopReason;
      }
      return await finish();
    }
    if (answered.kind !== "result" || !isObject(answered.result)) {
      failure = `session/prompt did not complete: ${describeOutcome(answered)}`;
      return await finish();
    }
    const reason = answered.result["stopReason"];
    stopReason = typeof reason === "string" ? (reason as AcpStopReason) : undefined;
    if (stopReason === "end_turn") {
      status = "completed";
    } else {
      failure = `the agent ended its turn with stopReason ${JSON.stringify(reason ?? null)}`;
    }
    return await finish();
  } finally {
    deadline.cancel();
  }

  async function finish(): Promise<SuperviseAcpOutcome> {
    // Let answers to anything the agent asked in its last breath go out before
    // the process goes away; bounded by the grace window.
    if (inflight.size > 0) {
      const grace = afterMs(graceMs);
      await Promise.race([Promise.allSettled([...inflight]), grace.promise]);
      grace.cancel();
    }
    if (status === "completed") {
      emit({ kind: "child_finished", text: assistantText });
    } else {
      emit({ kind: "child_failed", message: failure ?? "the ACP run failed" });
    }
    // An ACP agent stays alive waiting for the next prompt; this run is over.
    await stop();
    requests.close("the run is over");
    const drained = afterMs(graceMs);
    await Promise.race([stdoutDone, drained.promise]);
    drained.cancel();
    return {
      status,
      ...(failure === undefined ? {} : { failure }),
      ...(stopReason === undefined ? {} : { stopReason }),
      events: [...events],
      decisions: [...decisions],
      fsRequests: [...fsRequests],
      toolCalls: [...toolCalls.values()],
      assistantText,
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
      ...(agentInfo === undefined ? {} : { agentInfo }),
      ...(agentCapabilities === undefined ? {} : { agentCapabilities }),
      clientCapabilities,
      ...(sessionId === undefined ? {} : { sessionId }),
      embeddedContextSent,
      ...(usage === undefined ? {} : { usage }),
      ...(cost === undefined ? {} : { cost }),
      cancelSent,
      killed,
      ...(exitCode === undefined ? {} : { exitCode }),
      stderr: stderr.join("\n"),
    };
  }
}

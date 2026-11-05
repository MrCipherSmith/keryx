import { randomUUID } from "node:crypto";
import { runAgentTurn, type AgentIO } from "../agent";
import type { InteractiveTool } from "../../harness/tool/builtin/interactive-tools";
import type { NormalizedMessage, ProviderPort } from "../../harness/provider/types";
import type { ReviewAgentAdapterRequest, ReviewAgentSpawnInput } from "../../review/agents/types";
import type { ExternalBridgeRequest, ExternalBridgeResponse } from "../../review/agents/external-adapter";

export const KERYX_EXTERNAL_BRIDGE_TOOL_NAMES = [
  "review_agents_bridge_spawn",
  "review_agents_bridge_status",
  "review_agents_bridge_wait",
  "review_agents_bridge_result",
  "review_agents_bridge_cancel",
] as const;

export interface KeryxExternalBridgeClient {
  readonly invoke: (
    request: ExternalBridgeRequest,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<ExternalBridgeResponse>;
}

export interface KeryxExternalWorkerInput {
  readonly request: ReviewAgentAdapterRequest;
  readonly provider: ProviderPort;
  readonly providerId: string;
  readonly modelId: string;
  readonly bridge: KeryxExternalBridgeClient;
  readonly signal: AbortSignal;
  readonly maxOutputTokens?: number;
  readonly id?: () => string;
}

export interface KeryxExternalWorkerResult {
  readonly content: string;
  readonly metadata: {
    readonly harness: "keryx-dedicated-review-agents-worker";
    readonly toolNames: typeof KERYX_EXTERNAL_BRIDGE_TOOL_NAMES;
  };
}

const DISPATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["dispatchId"],
  properties: { dispatchId: { type: "string", minLength: 1 } },
} as const;

function bridgeTool(
  name: typeof KERYX_EXTERNAL_BRIDGE_TOOL_NAMES[number],
  description: string,
  inputSchema: Record<string, unknown>,
  request: (input: Record<string, unknown>) => ExternalBridgeRequest,
  bridge: KeryxExternalBridgeClient,
): InteractiveTool {
  return {
    definition: {
      name,
      description,
      inputSchema,
      // The local operation only spends a scoped host capability. The host
      // controller independently authorizes/admit/cancels every real effect.
      risk: "read",
    },
    async invoke(input, context) {
      const response = await bridge.invoke(request(input), context?.signal === undefined ? undefined : { signal: context.signal });
      return { output: JSON.stringify(response), isError: !response.ok };
    },
  };
}

export function createKeryxExternalBridgeTools(bridge: KeryxExternalBridgeClient): InteractiveTool[] {
  const spawnSchema = {
    type: "object",
    additionalProperties: false,
    required: ["taskId", "attempt", "entity", "role", "adapterId"],
    properties: {
      taskId: { type: "string", minLength: 1 },
      task: { type: "string" },
      attempt: { type: "integer", minimum: 1 },
      idempotencyKey: { type: "string" },
      entity: { type: "string", minLength: 1 },
      role: { type: "string", enum: ["worker", "scout", "validator"] },
      adapterId: { type: "string", minLength: 1 },
      skillRef: { type: "string" },
      scopeIds: { type: "array", items: { type: "string" } },
      waveId: { type: "string" },
      maxRuntimeMs: { type: "integer", minimum: 1 },
    },
  };
  return [
    bridgeTool(
      "review_agents_bridge_spawn",
      "Ask the host-owned Review agents controller to admit one scoped soldier. Returns its dispatch id or a refusal.",
      spawnSchema,
      (input) => ({ operation: "spawn", input: input as unknown as ReviewAgentSpawnInput }),
      bridge,
    ),
    bridgeTool("review_agents_bridge_status", "Read one owned soldier status.", DISPATCH_SCHEMA, (input) => ({
      operation: "status", dispatchId: String(input.dispatchId),
    }), bridge),
    bridgeTool("review_agents_bridge_wait", "Wait for one owned soldier to become terminal.", DISPATCH_SCHEMA, (input) => ({
      operation: "wait", dispatchId: String(input.dispatchId),
    }), bridge),
    bridgeTool("review_agents_bridge_result", "Read one owned soldier durable result.", DISPATCH_SCHEMA, (input) => ({
      operation: "result", dispatchId: String(input.dispatchId),
    }), bridge),
    bridgeTool("review_agents_bridge_cancel", "Ask the host controller to cancel one owned soldier.", {
      type: "object",
      additionalProperties: false,
      required: ["dispatchId", "reason"],
      properties: { dispatchId: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1 } },
    }, (input) => ({ operation: "cancel", dispatchId: String(input.dispatchId), reason: String(input.reason) }), bridge),
  ];
}

function systemInstruction(request: ReviewAgentAdapterRequest): string {
  return [
    "You are a dedicated Keryx Review agents external general.",
    "You have exactly five controller-scoped bridge tools. No shell, filesystem, MCP, web, native subagent, normal Review agents start, or credential tool exists.",
    "Delegate only through review_agents_bridge_spawn. Then wait for and collect every soldier result before consolidating.",
    "The host controller owns authority, budgets, admission, persistence, and cancellation; a refusal is final.",
    `Dispatch: ${request.dispatchId}`,
    `Scope IDs: ${JSON.stringify(request.scopeIds)}`,
    `Maximum child launches: ${request.limits.maxChildLaunches}`,
  ].join("\n");
}

export async function runKeryxExternalWorker(input: KeryxExternalWorkerInput): Promise<KeryxExternalWorkerResult> {
  const tools = createKeryxExternalBridgeTools(input.bridge);
  const history: NormalizedMessage[] = [];
  const io: AgentIO = {
    write: () => undefined,
    permissionMode: () => "auto",
    requestApproval: async () => false,
  };
  const allowed = new Set<string>(KERYX_EXTERNAL_BRIDGE_TOOL_NAMES);
  let lastAttemptEnded = false;
  let lastAttemptFailed = false;
  const monitoredProvider: ProviderPort = {
    ...input.provider,
    describe: () => input.provider.describe(),
    stream: (request, options) => (async function* () {
      lastAttemptEnded = false;
      lastAttemptFailed = false;
      for await (const event of input.provider.stream(request, options)) {
        if (event.kind === "provider_error") lastAttemptFailed = true;
        if (event.kind === "model_end") lastAttemptEnded = true;
        yield event;
      }
    })(),
  };
  const result = await runAgentTurn(io, {
    provider: monitoredProvider,
    providerId: input.providerId,
    modelId: input.modelId,
    tools,
    systemInstruction: systemInstruction(input.request),
    idSeq: input.id ?? randomUUID,
    // The controller-selected effective grant for ordinary dispatches is the
    // role default. The worker must never self-promote to the extension ceiling.
    maxRounds: input.request.limits.modelRoundsDefault,
    maxToolCalls: input.request.limits.toolCallsMax,
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    unattended: true,
    planFollowThrough: false,
    hardDeny: (toolName) => allowed.has(toolName) ? undefined : "tool is outside the dedicated Review agents bridge allowlist",
  }, history, input.request.task, { signal: input.signal, origin: "agent-message" });
  if (lastAttemptFailed || !lastAttemptEnded) throw new Error("dedicated external general provider attempt did not complete cleanly");
  if (result.caughtToolErrors !== undefined && result.caughtToolErrors.length > 0) {
    throw new Error("dedicated external general bridge tool failed");
  }
  if (result.finishReason !== undefined) throw new Error(`dedicated external general stopped: ${result.finishReason}`);
  const content = [...history].reverse().find((message) => message.role === "assistant" && message.content.trim().length > 0)?.content ?? "";
  if (content.length === 0) throw new Error("dedicated external general returned no result");
  return {
    content,
    metadata: { harness: "keryx-dedicated-review-agents-worker", toolNames: KERYX_EXTERNAL_BRIDGE_TOOL_NAMES },
  };
}

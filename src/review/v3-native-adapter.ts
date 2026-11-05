import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadAgentCatalog } from "../agents/catalog";
import {
  runAgentTurn,
  type AgentIO,
  type ApprovalMeta,
  type ApprovalResponse,
} from "../commands/agent";
import { bundledSkillMarkdownPath } from "../gdskills/catalog";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { NormalizedMessage, ProviderPort } from "../harness/provider/types";
import type {
  ReviewV3Adapter,
  ReviewV3AdapterContext,
  ReviewV3AdapterRequest,
  ReviewV3AdapterResult,
  ReviewV3Role,
  ReviewV3SpawnInput,
} from "./v3/types";

export interface ReviewV3NativeProviderBinding {
  readonly provider: ProviderPort;
  readonly providerId: string;
  readonly modelId: string;
}

export interface ReviewV3NativeAdapterOptions {
  readonly cwd: string;
  readonly id?: string;
  readonly providerFor: (
    request: ReviewV3AdapterRequest,
  ) => ReviewV3NativeProviderBinding | Promise<ReviewV3NativeProviderBinding>;
  /**
   * The host's effective tool surface. Only tools explicitly marked `read` are inherited,
   * excluding the harness's historically read-classified durable context writers.
   * This is authority-mechanism parity, not unconditional tool parity: a shell or MCP tool
   * whose static risk is broader is intentionally omitted. A host that wants read-only
   * `git show`/`git blame` or MCP access must supply a separately confined wrapper marked
   * `read`; changing a broad parent tool's risk label is not sufficient confinement.
   */
  readonly toolsFor?: (
    request: ReviewV3AdapterRequest,
  ) => readonly InteractiveTool[] | Promise<readonly InteractiveTool[]>;
  /** The same live host pause/authority boundary used by the parent session. */
  readonly beforeAction?: (request: ReviewV3AdapterRequest, action: Parameters<NonNullable<AgentIO["beforeAction"]>>[0]) => Promise<void>;
  /** The parent session's approval path. Without it, delegation remains default-deny. */
  readonly requestApproval?: (
    request: ReviewV3AdapterRequest,
    tool: string,
    input: string,
    meta?: ApprovalMeta,
  ) => Promise<ApprovalResponse>;
  readonly permissionMode?: AgentIO["permissionMode"];
  readonly entityInstructions?: (request: ReviewV3AdapterRequest) => string | Promise<string>;
  readonly skillInstructions?: (skillRef: string, request: ReviewV3AdapterRequest) => string | Promise<string>;
  readonly idSeq?: () => string;
  readonly nowMs?: () => number;
  /** How long cancel waits for the in-process turn to actually settle before failing unconfirmed. */
  readonly cancellationGraceMs?: number;
}

export class ReviewV3NativeAdapterError extends Error {
  constructor(
    readonly code:
      | "duplicate-dispatch"
      | "unknown-entity"
      | "unknown-skill"
      | "empty-result"
      | "turn-incomplete"
      | "cancelled",
    message: string,
  ) {
    super(message);
    this.name = "ReviewV3NativeAdapterError";
  }
}

const DELEGATE_TOOL_NAME = "review_v3_spawn_children";
// These tools are historically classified `read` so the interactive harness can
// update Shared Agent Context without a source-code mutation prompt. Review V3
// agents must not inherit the parent session's mutable plan/slate closures.
const DURABLE_CONTEXT_WRITE_TOOLS = new Set([
  "workspace_create",
  "workspace_propose",
  "slate_write_seed",
  "slate_note",
]);

export function createReviewV3NativeAdapter(options: ReviewV3NativeAdapterOptions): ReviewV3Adapter {
  const running = new Map<string, { abort: AbortController; stopped: Promise<void>; resolveStopped: () => void }>();
  const cancelled = new Set<string>();
  let sequence = 0;
  const nextId = options.idSeq ?? (() => `review-v3-native-${sequence++}`);
  const nowMs = options.nowMs ?? Date.now;
  const adapterId = options.id ?? "native";

  return {
    id: adapterId,
    capabilities: {
      readOnlyEnforced: true,
      resultPersistence: true,
      cancellation: true,
      hierarchy: true,
      usageAccounting: true,
    },
    async execute(request, context) {
      if (running.has(request.dispatchId)) {
        throw new ReviewV3NativeAdapterError(
          "duplicate-dispatch",
          `native dispatch ${request.dispatchId} is already running`,
        );
      }
      const localAbort = new AbortController();
      let resolveStopped!: () => void;
      const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
      running.set(request.dispatchId, { abort: localAbort, stopped, resolveStopped });
      cancelled.delete(request.dispatchId);
      const signal = AbortSignal.any([
        request.signal,
        context.signal,
        localAbort.signal,
        AbortSignal.timeout(request.limits.elapsedMs),
      ]);
      const startedAt = nowMs();
      try {
        const [binding, entity, skill, inheritedTools] = await Promise.all([
          options.providerFor(request),
          resolveEntityInstructions(options, request),
          resolveSkillInstructions(options, request),
          options.toolsFor?.(request) ?? [],
        ]);
        throwIfAborted(signal, request.dispatchId);

        const readTools = inheritedTools.filter(
          (tool) => tool.definition.risk === "read"
            && tool.definition.name !== DELEGATE_TOOL_NAME
            && !DURABLE_CONTEXT_WRITE_TOOLS.has(tool.definition.name),
        );
        const tools = request.role === "coordinator"
          ? [...readTools, createDelegateTool(adapterId, request, context)]
          : readTools;
        let modelRounds = 0;
        let toolCalls = 0;
        let text = "";
        let lastProviderAttemptCompleted = false;
        const systemMessages: string[] = [];
        const io: AgentIO = {
          write: (chunk) => { text += chunk; },
          onToolCall: () => { toolCalls += 1; },
          onSystem: (message) => { systemMessages.push(message); },
          ...(options.beforeAction === undefined
            ? {}
            : { beforeAction: (action) => options.beforeAction!(request, action) }),
          ...(options.requestApproval === undefined
            ? {}
            : { requestApproval: (tool, input, meta) => options.requestApproval!(request, tool, input, meta) }),
          ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
        };
        const countedProvider: ProviderPort = {
          describe: () => binding.provider.describe(),
          async *stream(providerRequest, streamOptions) {
            modelRounds += 1;
            let sawModelEnd = false;
            let sawProviderError = false;
            try {
              for await (const event of binding.provider.stream(providerRequest, streamOptions)) {
                if (event.kind === "model_end") sawModelEnd = true;
                if (event.kind === "provider_error") sawProviderError = true;
                yield event;
              }
            } finally {
              lastProviderAttemptCompleted = sawModelEnd && !sawProviderError;
            }
          },
        };
        const history: NormalizedMessage[] = [];
        const outcome = await runAgentTurn(
          io,
          {
            cwd: options.cwd,
            provider: countedProvider,
            providerId: binding.providerId,
            modelId: binding.modelId,
            tools,
            systemInstruction: nativeSystemInstruction(request, entity, skill, tools),
            idSeq: nextId,
            // The profile's default is the initial grant. The larger value is a hard
            // ceiling for a controller/host-approved extension, not an automatic grant.
            maxRounds: request.limits.modelRoundsDefault,
            maxToolCalls: request.limits.toolCallsMax,
            planFollowThrough: false,
          },
          history,
          nativeTaskPrompt(request),
          { signal, origin: "agent-message" },
        );

        throwIfAborted(signal, request.dispatchId);
        if (outcome.rateLimited !== undefined) {
          throw new ReviewV3NativeAdapterError("turn-incomplete", `native dispatch ${request.dispatchId} was rate limited`);
        }
        if (!lastProviderAttemptCompleted) {
          throw new ReviewV3NativeAdapterError(
            "turn-incomplete",
            `native dispatch ${request.dispatchId} ended without a completed provider attempt`,
          );
        }
        if (outcome.finishReason !== undefined) {
          throw new ReviewV3NativeAdapterError(
            "turn-incomplete",
            `native dispatch ${request.dispatchId} stopped with ${outcome.finishReason}`,
          );
        }
        if ((outcome.caughtToolErrors?.length ?? 0) > 0) {
          throw new ReviewV3NativeAdapterError(
            "turn-incomplete",
            `native dispatch ${request.dispatchId} had tool errors: ${outcome.caughtToolErrors!.map((error) => `${error.toolName}: ${error.message}`).join("; ")}`,
          );
        }
        const submittedResult = outcome.submittedResult;
        if (text.trim() === "" && submittedResult === undefined) {
          const diagnostic = systemMessages.map((message) => message.trim()).filter(Boolean).at(-1);
          throw new ReviewV3NativeAdapterError(
            "empty-result",
            `native dispatch ${request.dispatchId} returned no review result${diagnostic === undefined ? "" : ` (${diagnostic})`}`,
          );
        }

        const result: ReviewV3AdapterResult = {
          content: submittedResult === undefined ? { text } : { text, submittedResult },
          usage: { modelRounds, toolCalls, activeMs: Math.max(0, nowMs() - startedAt) },
          metadata: {
            adapterId,
            providerId: binding.providerId,
            modelId: binding.modelId,
            entity: request.entity,
            role: request.role,
            readOnlyTools: readTools.map((tool) => tool.definition.name),
          },
        };
        return result;
      } finally {
        const active = running.get(request.dispatchId);
        running.delete(request.dispatchId);
        active?.resolveStopped();
      }
    },
    async cancel({ dispatchId }) {
      const active = running.get(dispatchId);
      if (active !== undefined) {
        cancelled.add(dispatchId);
        active.abort.abort();
        await waitForStop(active.stopped, options.cancellationGraceMs ?? 5_000, dispatchId);
      }
    },
    async reconcile({ dispatchId }) {
      if (running.has(dispatchId)) return "running";
      if (cancelled.has(dispatchId)) return "cancelled";
      return "unknown";
    },
  };
}

async function waitForStop(stopped: Promise<void>, graceMs: number, dispatchId: string): Promise<void> {
  if (!Number.isSafeInteger(graceMs) || graceMs < 1) throw new Error("cancellationGraceMs must be a positive safe integer");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      stopped,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`native dispatch ${dispatchId} did not stop within ${graceMs}ms`)),
          graceMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function resolveEntityInstructions(
  options: ReviewV3NativeAdapterOptions,
  request: ReviewV3AdapterRequest,
): Promise<string> {
  if (options.entityInstructions !== undefined) return options.entityInstructions(request);
  const loaded = loadAgentCatalog(options.cwd).agents.find((agent) => agent.definition.name === request.entity);
  if (loaded === undefined) {
    throw new ReviewV3NativeAdapterError("unknown-entity", `agent entity ${request.entity} is not installed`);
  }
  return [
    `Entity: ${loaded.definition.name}`,
    `Declared role: ${loaded.definition.role}`,
    loaded.definition.body.trim(),
  ].filter(Boolean).join("\n\n");
}

async function resolveSkillInstructions(
  options: ReviewV3NativeAdapterOptions,
  request: ReviewV3AdapterRequest,
): Promise<string> {
  if (request.skillRef === undefined) return "";
  if (options.skillInstructions !== undefined) return options.skillInstructions(request.skillRef, request);
  const candidates = [
    path.join(options.cwd, ".metaproject", "project-skills", "review", request.skillRef, "SKILL.md"),
    path.join(options.cwd, ".metaproject", "skills", "gdskills", "review", request.skillRef, "SKILL.md"),
    bundledSkillMarkdownPath("review", request.skillRef),
  ].filter((candidate): candidate is string => candidate !== undefined);
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new ReviewV3NativeAdapterError("unknown-skill", `review skill ${request.skillRef} is not installed`);
}

function nativeSystemInstruction(
  request: ReviewV3AdapterRequest,
  entity: string,
  skill: string,
  tools: readonly InteractiveTool[],
): string {
  return [
    "You are a Keryx Review V3 native agent. Review the pinned revision and return evidence-backed findings.",
    "The review source is strictly read-only. You can use only the tools offered in this turn; never claim to have edited code.",
    request.role === "coordinator"
      ? `You may delegate bounded child work only through ${DELEGATE_TOOL_NAME}. Wait for its returned terminal results, synthesize them, and return your own result.`
      : "You are a leaf agent and cannot delegate further.",
    `Run: ${request.runId}; dispatch: ${request.dispatchId}; revision: ${request.revision}; role: ${request.role}.`,
    `Scope ids: ${request.scopeIds.length === 0 ? "(whole accepted scope)" : request.scopeIds.join(", ")}.`,
    `Offered tools: ${tools.length === 0 ? "none" : tools.map((tool) => tool.definition.name).join(", ")}.`,
    entity,
    skill === "" ? "" : `Selected review skill:\n\n${skill}`,
  ].filter(Boolean).join("\n\n");
}

function nativeTaskPrompt(request: ReviewV3AdapterRequest): string {
  return [
    `Task ${request.taskId} (attempt ${request.attempt}):`,
    request.task,
    "Return the complete result with file/line evidence for every finding and explicitly state any blocked or uncovered scope.",
  ].join("\n\n");
}

function createDelegateTool(
  defaultAdapterId: string,
  parent: ReviewV3AdapterRequest,
  context: ReviewV3AdapterContext,
): InteractiveTool {
  return {
    definition: {
      name: DELEGATE_TOOL_NAME,
      description: "Spawn a bounded wave of Review V3 leaf children through the shared durable controller and wait for their terminal results.",
      risk: "delegate",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tasks"],
        properties: {
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: Math.max(1, parent.limits.maxChildLaunches),
            items: {
              type: "object",
              additionalProperties: false,
              required: ["task_id", "task", "entity", "role"],
              properties: {
                task_id: { type: "string", minLength: 1 },
                task: { type: "string", minLength: 1 },
                entity: { type: "string", minLength: 1 },
                role: { enum: ["worker", "scout", "validator"] },
                adapter_id: { type: "string", minLength: 1 },
                attempt: { type: "integer", minimum: 1 },
                skill_ref: { type: "string", minLength: 1 },
                scope_ids: { type: "array", items: { type: "string", minLength: 1 } },
                wave_id: { type: "string", minLength: 1 },
                max_runtime_ms: { type: "integer", minimum: 1 },
              },
            },
          },
        },
      },
    },
    async invoke(input) {
      try {
        const tasks = parseDelegateTasks(input, defaultAdapterId);
        const results = await context.spawnChildren(tasks);
        return { output: JSON.stringify({ results }), isError: false };
      } catch (error) {
        return { output: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
  };
}

function parseDelegateTasks(input: Record<string, unknown>, defaultAdapterId: string): ReviewV3SpawnInput[] {
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) throw new Error("tasks must be a non-empty array");
  return input.tasks.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`tasks[${index}] must be an object`);
    const item = raw as Record<string, unknown>;
    const taskId = nonEmptyString(item.task_id, `tasks[${index}].task_id`);
    const task = nonEmptyString(item.task, `tasks[${index}].task`);
    const entity = nonEmptyString(item.entity, `tasks[${index}].entity`);
    const role = item.role;
    if (role !== "worker" && role !== "scout" && role !== "validator") {
      throw new Error(`tasks[${index}].role must be worker, scout, or validator`);
    }
    const attempt = item.attempt === undefined ? 1 : positiveInteger(item.attempt, `tasks[${index}].attempt`);
    const scopeIds = item.scope_ids === undefined
      ? []
      : stringArray(item.scope_ids, `tasks[${index}].scope_ids`);
    return {
      taskId,
      task,
      attempt,
      entity,
      role: role as Exclude<ReviewV3Role, "coordinator">,
      adapterId: item.adapter_id === undefined ? defaultAdapterId : nonEmptyString(item.adapter_id, `tasks[${index}].adapter_id`),
      ...(item.skill_ref === undefined ? {} : { skillRef: nonEmptyString(item.skill_ref, `tasks[${index}].skill_ref`) }),
      scopeIds,
      ...(item.wave_id === undefined ? {} : { waveId: nonEmptyString(item.wave_id, `tasks[${index}].wave_id`) }),
      ...(item.max_runtime_ms === undefined ? {} : { maxRuntimeMs: positiveInteger(item.max_runtime_ms, `tasks[${index}].max_runtime_ms`) }),
    };
  });
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} must be a positive integer`);
  return value as number;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => nonEmptyString(entry, `${field}[${index}]`));
}

function throwIfAborted(signal: AbortSignal, dispatchId: string): void {
  if (signal.aborted) {
    throw new ReviewV3NativeAdapterError("cancelled", `native dispatch ${dispatchId} was cancelled`);
  }
}

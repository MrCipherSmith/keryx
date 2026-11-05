import { describe, expect, test } from "bun:test";
import { callRound, okReply, scriptedProvider } from "../commands/agent.test-helpers";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { ReviewV3AdapterContext, ReviewV3AdapterRequest, ReviewV3TerminalResult } from "./v3/types";
import { createReviewV3NativeAdapter, ReviewV3NativeAdapterError } from "./v3-native-adapter";

const limits = {
  elapsedMs: 1_000,
  modelRoundsDefault: 8,
  modelRoundsMax: 12,
  toolCallsMax: 20,
  maxChildLaunches: 8,
} as const;

function request(overrides: Partial<ReviewV3AdapterRequest> = {}): ReviewV3AdapterRequest {
  return {
    runId: "run-1",
    dispatchId: "dispatch-1",
    taskId: "task-1",
    task: "Review the assigned scope",
    attempt: 1,
    revision: "abc123",
    entity: "review-worker",
    role: "worker",
    scopeIds: ["src/a.ts"],
    depth: 1,
    limits,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function context(overrides: Partial<ReviewV3AdapterContext> = {}): ReviewV3AdapterContext {
  return {
    signal: new AbortController().signal,
    controller: {} as ReviewV3AdapterContext["controller"],
    spawnChild: async () => terminal("child"),
    spawnChildren: async (children) => children.map((child) => terminal(child.taskId)),
    ...overrides,
  };
}

function terminal(dispatchId: string): ReviewV3TerminalResult {
  return { dispatchId, status: "completed", resultId: `result-${dispatchId}` };
}

function tool(name: string, risk: string): InteractiveTool {
  return {
    definition: { name, risk, inputSchema: { type: "object" } },
    invoke: async () => ({ output: "ok", isError: false }),
  };
}

describe("Review V3 native adapter", () => {
  test("inherits only read tools and returns the complete native result with usage", async () => {
    const scripted = scriptedProvider([[{ kind: "text_delta", text: "x".repeat(40_000) }, { kind: "model_end" }]]);
    let clock = 10;
    const adapter = createReviewV3NativeAdapter({
      cwd: process.cwd(),
      providerFor: () => ({ provider: scripted.provider, providerId: "scripted", modelId: "test" }),
      toolsFor: () => [
        tool("read_file", "read"),
        tool("slate_note", "read"),
        tool("apply_patch", "write"),
        tool("shell_exec", "shell"),
      ],
      entityInstructions: () => "Worker instructions",
      nowMs: () => (clock += 5),
    });

    const result = await adapter.execute(request(), context());

    expect(scripted.requests).toHaveLength(1);
    expect(scripted.requests[0]?.tools?.map((entry) => entry.name)).toEqual(["read_file"]);
    expect((result.content as { text: string }).text).toHaveLength(40_000);
    expect(result.usage).toEqual({ modelRounds: 1, toolCalls: 0, activeMs: 5 });
    expect(result.metadata?.readOnlyTools).toEqual(["read_file"]);
  });

  test("coordinator delegates a leaf wave through the shared controller context", async () => {
    const scripted = scriptedProvider([
      callRound("call-1", "review_v3_spawn_children", JSON.stringify({
        tasks: [{
          task_id: "logic-1",
          task: "Review the logic",
          entity: "review-worker",
          role: "worker",
          scope_ids: ["src/a.ts"],
        }],
      })),
      okReply,
    ]);
    const spawned: unknown[] = [];
    const approvals: string[] = [];
    const boundaries: string[] = [];
    const adapter = createReviewV3NativeAdapter({
      cwd: process.cwd(),
      providerFor: () => ({ provider: scripted.provider, providerId: "scripted", modelId: "test" }),
      entityInstructions: () => "Coordinator instructions",
      beforeAction: async (_request, action) => { boundaries.push(action.kind); },
      requestApproval: async (_request, name) => { approvals.push(name); return true; },
    });

    const result = await adapter.execute(
      request({ role: "coordinator", entity: "review-coordinator", depth: 1 }),
      context({
        spawnChildren: async (children) => {
          spawned.push(...children);
          return children.map((child) => terminal(child.taskId));
        },
      }),
    );

    expect(spawned).toEqual([{
      taskId: "logic-1",
      task: "Review the logic",
      attempt: 1,
      entity: "review-worker",
      role: "worker",
      adapterId: "native",
      scopeIds: ["src/a.ts"],
    }]);
    expect(approvals).toEqual(["review_v3_spawn_children"]);
    expect(boundaries).toEqual(["model", "tool", "model"]);
    expect(result.usage?.modelRounds).toBe(2);
    expect(result.usage?.toolCalls).toBe(1);
    expect((result.content as { text: string }).text).toBe("done");
  });

  test("does not expose delegation to a leaf", async () => {
    const scripted = scriptedProvider([okReply]);
    const adapter = createReviewV3NativeAdapter({
      cwd: process.cwd(),
      providerFor: () => ({ provider: scripted.provider, providerId: "scripted", modelId: "test" }),
      entityInstructions: () => "Leaf instructions",
    });

    await adapter.execute(request({ role: "validator" }), context());

    expect(scripted.requests[0]?.tools?.map((entry) => entry.name)).not.toContain("review_v3_spawn_children");
  });

  test("does not persist partial text after a provider failure as a completed review", async () => {
    const scripted = scriptedProvider([[
      { kind: "text_delta", text: "partial finding" },
      {
        kind: "provider_error",
        error: { kind: "authentication", retryable: false, message: "not authenticated" },
      },
    ]]);
    const adapter = createReviewV3NativeAdapter({
      cwd: process.cwd(),
      providerFor: () => ({ provider: scripted.provider, providerId: "scripted", modelId: "test" }),
      entityInstructions: () => "Leaf instructions",
    });

    await expect(adapter.execute(request(), context())).rejects.toMatchObject({ code: "turn-incomplete" });
  });

  test("cancel aborts an in-flight provider and reconcile reports cancellation", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const adapter = createReviewV3NativeAdapter({
      cwd: process.cwd(),
      providerFor: () => ({
        providerId: "blocking",
        modelId: "test",
        provider: {
          describe: () => ({
            capabilities: {
              streaming: true,
              toolCalls: true,
              parallelToolCalls: false,
              structuredOutput: false,
              reasoningMetadata: false,
              promptCaching: false,
              vision: false,
              tokenCounting: false,
              modelListing: false,
            },
            descriptor: { providerId: "blocking" },
          }),
          stream: (_providerRequest, options) => (async function* () {
            entered();
            await new Promise<void>((_resolve, reject) => {
              options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
            });
            yield { kind: "model_end", sequence: 0, attemptId: options.attemptId } as const;
          })(),
        },
      }),
      entityInstructions: () => "Worker instructions",
    });
    const execution = adapter.execute(request(), context());
    await started;

    await adapter.cancel?.({ runId: "run-1", dispatchId: "dispatch-1", reason: "test" });

    await expect(execution).rejects.toBeInstanceOf(ReviewV3NativeAdapterError);
    expect(await adapter.reconcile?.({ runId: "run-1", dispatchId: "dispatch-1" })).toBe("cancelled");
  });

  test("enforces the controller-supplied effective elapsed deadline", async () => {
    const adapter = createReviewV3NativeAdapter({
      cwd: process.cwd(),
      providerFor: () => ({
        providerId: "blocking",
        modelId: "test",
        provider: {
          describe: () => ({
            capabilities: {
              streaming: true,
              toolCalls: true,
              parallelToolCalls: false,
              structuredOutput: false,
              reasoningMetadata: false,
              promptCaching: false,
              vision: false,
              tokenCounting: false,
              modelListing: false,
            },
            descriptor: { providerId: "blocking" },
          }),
          stream: (_providerRequest, options) => (async function* () {
            await new Promise<void>((_resolve, reject) => {
              options.signal?.addEventListener("abort", () => reject(new DOMException("deadline", "AbortError")), { once: true });
            });
            yield { kind: "model_end", sequence: 0, attemptId: options.attemptId } as const;
          })(),
        },
      }),
      entityInstructions: () => "Worker instructions",
    });

    await expect(adapter.execute(
      request({ limits: { ...limits, elapsedMs: 5 } }),
      context(),
    )).rejects.toMatchObject({ code: "cancelled" });
  });
});

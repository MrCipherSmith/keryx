// Shared fixtures for the R4d approval suites (flow 369): a provider that asks
// for scripted tool calls, an executor that counts what really ran, and the tmp
// directories every suite needs.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  NormalizedEvent,
  NormalizedRequest,
  ProviderDescription,
  ProviderPort,
  StreamOptions,
} from "../harness/provider/types";
import { ToolRegistry } from "../harness/tool/registry";
import type { ToolDefinition, ToolExecutorPort, ToolInvocation, ToolResult, ToolRisk } from "../harness/tool/types";

export interface ScriptedCall {
  id: string;
  name: string;
  input: string;
}

/** Offline and deterministic: emits the scripted calls, then stops. */
export class ScriptedProvider implements ProviderPort {
  constructor(private readonly calls: readonly ScriptedCall[]) {}
  describe(): ProviderDescription {
    return {
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
      descriptor: { providerId: "scripted-stub" },
    };
  }
  async *stream(_request: NormalizedRequest, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
    let sequence = 0;
    const next = (body: Omit<NormalizedEvent, "sequence" | "attemptId">): NormalizedEvent => ({
      ...body,
      sequence: sequence++,
      attemptId: opts.attemptId,
    });
    yield next({ kind: "model_start" });
    for (const call of this.calls) {
      yield next({ kind: "tool_call_start", toolCallId: call.id, toolName: call.name });
      yield next({ kind: "tool_call_end", toolCallId: call.id, toolName: call.name, input: call.input });
    }
    yield next({ kind: "model_end" });
  }
}

export function tool(name: string, risk: ToolRisk): ToolDefinition {
  return {
    schemaVersion: 1,
    toolId: name,
    version: "1.0.0",
    inputSchema: { type: "object", properties: { body: { type: "string" } } },
    outputSchema: { type: "object" },
    risk,
    capabilities: [],
    limits: { timeoutMs: 1_000, maxOutputBytes: 1_024, concurrencyKey: name },
    replay: { deterministic: true, recordedResultSupported: true },
  };
}

export function registryOf(...tools: ToolDefinition[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const definition of tools) {
    registry.register(definition);
  }
  return registry;
}

/** Records the input of every invocation, so "ran once with these arguments" is asserted. */
export class CountingExecutor implements ToolExecutorPort {
  readonly invocations: Array<{ tool: string; input: unknown }> = [];
  async invoke(invocation: ToolInvocation): Promise<ToolResult> {
    this.invocations.push({ tool: invocation.call.toolName, input: invocation.call.input });
    return {
      schemaVersion: 1,
      toolResultId: `result-${this.invocations.length}`,
      executionId: `exec-${this.invocations.length}`,
      toolCallId: invocation.call.toolCallId,
      causal: {},
      status: "succeeded",
      outputHash: "0".repeat(64),
      redaction: "not-needed",
      createdAt: "2026-09-29T10:00:00.000Z",
    } as unknown as ToolResult;
  }
  get names(): string[] {
    return this.invocations.map((entry) => entry.tool);
  }
}

export interface Dirs {
  configDir: string;
  project: string;
  cleanup(): void;
}

export function makeDirs(prefix = "keryx-approvals-"): Dirs {
  const base = mkdtempSync(path.join(tmpdir(), prefix));
  const configDir = path.join(base, "config");
  const project = path.join(base, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(path.join(project, ".metaproject"), { recursive: true });
  return { configDir, project, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

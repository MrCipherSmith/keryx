import { expect, test } from "bun:test";
import { runAgentTurn } from "./agent";
import type { AgentDeps, AgentIO } from "./agent";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { NormalizedEvent, NormalizedRequest, ProviderDescription, ProviderPort } from "../harness/provider/types";

const DESCRIPTION: ProviderDescription = {
  capabilities: {
    streaming: true,
    toolCalls: true,
    parallelToolCalls: true,
    structuredOutput: false,
    reasoningMetadata: false,
    promptCaching: false,
    vision: false,
    tokenCounting: false,
    modelListing: false,
  },
  descriptor: { providerId: "offline-rewind-stub" },
};

function scriptedProvider(rounds: readonly (readonly Partial<NormalizedEvent>[])[]): ProviderPort {
  let round = 0;
  return {
    describe: () => DESCRIPTION,
    stream: (_request: NormalizedRequest, options) => {
      const events = rounds[round] ?? [{ kind: "text_delta", text: "done" }];
      round += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        let sequence = 0;
        for (const event of events) {
          yield { sequence: sequence++, attemptId: options.attemptId, kind: "model_end", ...event } as NormalizedEvent;
        }
      })();
    },
  };
}

function call(id: string, name: string): Partial<NormalizedEvent>[] {
  return [
    { kind: "tool_call_start", toolCallId: id, toolName: name },
    { kind: "tool_call_end", toolCallId: id, input: JSON.stringify({ value: id }) },
  ];
}

function probe(name: string, risk: "read" | "write" | "shell", log: string[]): InteractiveTool {
  return {
    definition: {
      name,
      description: `${name} probe`,
      inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      risk,
    },
    invoke: async (input) => {
      log.push(`${name}:${String(input.value)}`);
      return { output: "ok", isError: false };
    },
  };
}

async function runTurn(options: { rounds: (readonly Partial<NormalizedEvent>[])[]; tools: InteractiveTool[]; io: Partial<AgentIO>; unattended?: boolean }): Promise<void> {
  let id = 0;
  const deps = {
    provider: scriptedProvider(options.rounds),
    providerId: "offline-rewind-stub",
    modelId: "fixture",
    tools: options.tools,
    systemInstruction: "probe only",
    idSeq: () => `rewind-${id++}`,
    maxRounds: 10,
    ...(options.unattended === true ? { unattended: true } : {}),
  } as AgentDeps;
  await runAgentTurn({ write: () => undefined, ...options.io }, deps, [], "go");
}

test("a read-only turn never reaches the snapshot seam", async () => {
  const log: string[] = [];
  await runTurn({
    rounds: [[...call("c1", "reader"), { kind: "model_end" }], [{ kind: "text_delta", text: "done" }, { kind: "model_end" }]],
    tools: [probe("reader", "read", log)],
    io: { beforeMutation: async () => void log.push("snapshot") },
  });
  expect(log).toEqual(["reader:c1"]);
});

test("a write tool is snapshotted after approval and strictly before it runs", async () => {
  const log: string[] = [];
  await runTurn({
    rounds: [[...call("c1", "reader"), ...call("c2", "writer"), { kind: "model_end" }], [{ kind: "text_delta", text: "done" }, { kind: "model_end" }]],
    tools: [probe("reader", "read", log), probe("writer", "write", log)],
    io: {
      requestApproval: async () => {
        log.push("approved");
        return true;
      },
      beforeMutation: async () => void log.push("snapshot"),
    },
  });
  expect(log).toEqual(["reader:c1", "approved", "snapshot", "writer:c2"]);
});

test("a shell tool reaches the seam", async () => {
  const log: string[] = [];
  await runTurn({
    rounds: [[...call("c1", "runner"), { kind: "model_end" }], [{ kind: "text_delta", text: "done" }, { kind: "model_end" }]],
    tools: [probe("runner", "shell", log)],
    io: { requestApproval: async () => true, beforeMutation: async () => void log.push("snapshot") },
  });
  expect(log).toEqual(["snapshot", "runner:c1"]);
});

test("a denied call never snapshots", async () => {
  const log: string[] = [];
  await runTurn({
    rounds: [[...call("c1", "writer"), { kind: "model_end" }], [{ kind: "text_delta", text: "done" }, { kind: "model_end" }]],
    tools: [probe("writer", "write", log)],
    io: { requestApproval: async () => false, beforeMutation: async () => void log.push("snapshot") },
  });
  expect(log).toEqual([]);
});

test("a throwing snapshot hook does not block the tool", async () => {
  const log: string[] = [];
  await runTurn({
    rounds: [[...call("c1", "writer"), { kind: "model_end" }], [{ kind: "text_delta", text: "done" }, { kind: "model_end" }]],
    tools: [probe("writer", "write", log)],
    io: {
      requestApproval: async () => true,
      beforeMutation: async () => {
        throw new Error("disk full");
      },
    },
  });
  expect(log).toEqual(["writer:c1"]);
});

test("an unattended run never calls the snapshot hook", async () => {
  const log: string[] = [];
  await runTurn({
    unattended: true,
    rounds: [[...call("c1", "writer"), { kind: "model_end" }], [{ kind: "text_delta", text: "done" }, { kind: "model_end" }]],
    tools: [probe("writer", "write", log)],
    io: { requestApproval: async () => true, beforeMutation: async () => void log.push("snapshot") },
  });
  expect(log).not.toContain("snapshot");
});

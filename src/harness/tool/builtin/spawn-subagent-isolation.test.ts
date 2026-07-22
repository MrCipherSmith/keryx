// Flow 115 / finding 5: the whole isolation of a subagent rests on invariants
// that were never pinned by a test.
//
// `mode` comes from the MODEL's tool input, and the TUI auto-approves
// `read_only` with no prompt — so the model chooses its own privilege level.
// That is only safe because a child cannot execute shell in ANY mode. Nothing
// asserted that. These tests are the guard: if a future change hands a child
// `shell_exec`, or lets a requested mode widen the tool set, they fail.
//
// Also pins the flow-115 stress finding M3: a child returned 1.5 MB verbatim
// into the parent's history, because nothing capped a child summary.

import { expect, test } from "bun:test";
import { createSpawnSubagentTool } from "./spawn-subagent-tool";
import type {
  NormalizedEvent,
  ProviderDescription,
  ProviderPort,
} from "../../provider/types";

const DESCRIPTION: ProviderDescription = {
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
  descriptor: { providerId: "scripted" },
};

/** A child provider replaying scripted rounds. */
function childProvider(rounds: Partial<NormalizedEvent>[][]): ProviderPort {
  let call = 0;
  return {
    describe: () => DESCRIPTION,
    stream: (_request, opts) => {
      const events = rounds[call] ?? [{ kind: "text_delta", text: "child done" }, { kind: "model_end" }];
      call += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        let sequence = 0;
        for (const partial of events) {
          yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
        }
      })();
    },
  };
}

function toolCallRound(name: string, input: string): Partial<NormalizedEvent>[] {
  return [
    { kind: "tool_call_start", toolCallId: "x1", toolName: name },
    { kind: "tool_call_end", toolCallId: "x1", input },
    { kind: "model_end" },
  ];
}

function spawnTool(rounds: Partial<NormalizedEvent>[][]) {
  let seq = 0;
  return createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "anthropic", modelId: "claude-sonnet-5" }),
    makeProvider: () => childProvider(rounds),
    getDetectedProviders: () => [{ name: "anthropic" }],
    idSeq: () => `id-${seq++}`,
    clock: () => "2026-07-21T00:00:00.000Z",
  });
}

// --- SECURITY INVARIANT: a child never executes shell -----------------------

test("a read_only subagent cannot execute shell_exec", async () => {
  const tool = spawnTool([toolCallRound("shell_exec", '{"command":"echo pwned"}')]);
  const result = await tool.invoke({ task: "try shell", mode: "read_only" });
  expect(result.output).not.toMatch(/pwned/);
});

test("a GENERAL subagent cannot execute shell_exec either — mode does not widen the tool set", async () => {
  const tool = spawnTool([toolCallRound("shell_exec", '{"command":"echo pwned"}')]);
  const result = await tool.invoke({ task: "try shell", mode: "general" });
  expect(result.output).not.toMatch(/pwned/);
});

test("a subagent cannot spawn a further subagent (no delegate tool at any depth)", async () => {
  const tool = spawnTool([toolCallRound("spawn_subagent", '{"task":"grandchild"}')]);
  const result = await tool.invoke({ task: "try to recurse", mode: "general" });
  expect(result.output).not.toMatch(/grandchild/);
});

test("the reported mode is the requested mode — the transcript cannot understate privilege", async () => {
  const ro = await spawnTool([]).invoke({ task: "t", mode: "read_only" });
  expect(ro.output).toMatch(/read_only/);
  const gen = await spawnTool([]).invoke({ task: "t", mode: "general" });
  expect(gen.output).toMatch(/general/);
  // An unknown/absent mode falls back to the RESTRICTED one, never the wider one.
  const missing = await spawnTool([]).invoke({ task: "t" });
  expect(missing.output).toMatch(/read_only/);
  const bogus = await spawnTool([]).invoke({ task: "t", mode: "root" });
  expect(bogus.output).toMatch(/read_only/);
});

// --- M3: a child summary is bounded ----------------------------------------

test("a child summary is capped before it reaches the parent's history", async () => {
  const huge = "x".repeat(1_500_000);
  const tool = spawnTool([[{ kind: "text_delta", text: huge }, { kind: "model_end" }]]);
  const result = await tool.invoke({ task: "flood the parent" });
  expect(result.output.length).toBeLessThan(64_000);
  expect(result.output).toMatch(/truncated/i);
});

test("a normal-sized summary is passed through untouched", async () => {
  const tool = spawnTool([[{ kind: "text_delta", text: "a short factual summary" }, { kind: "model_end" }]]);
  const result = await tool.invoke({ task: "normal" });
  expect(result.output).toMatch(/a short factual summary/);
  expect(result.output).not.toMatch(/truncated/i);
});

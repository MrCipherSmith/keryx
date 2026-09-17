// flow 268 T18 — guard test: the result a subagent hands back to its parent
// (`spawn_subagent`'s `output` field) must never contain the child's
// reasoning text, only its answer (AC12).
//
// `../../../commands/agent.ts` (read-only reference here — owned by a
// concurrent flow-268 agent, not edited by this task) dispatches
// `reasoning_delta` events to `io.onReasoning` and only assistant-text events
// to `io.onAssistantText`, kept strictly separate (see its `event.kind ===
// "reasoning_delta"` branches). `spawn-subagent-tool.ts` wires
// `io.onAssistantText` to the local `assistant` accumulator that becomes the
// child's returned summary (`assistant.trim()` / the `history` fallback,
// both reading `.content` — see the `raw = assistant.trim().length > 0 ? ...
// : history.filter(...).map((m) => m.content)...` block) and wires
// `io.onReasoning` only to a fleet UI log event, never to that accumulator.
// This test drives a real child turn through a fake provider that emits
// `reasoning_delta` (carrying a marker) before its `text_delta` answer, and
// asserts the parent-visible `output` never contains it.

import { expect, test } from "bun:test";
import { createSpawnSubagentTool, type SpawnSubagentFleetEvent } from "./spawn-subagent-tool";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../../provider/types";

const REASONING_MARKER = "REASONING-MARKER-268";

/** A ProviderPort that emits reasoning (with the marker) before its answer. */
function reasoningProvider(answerText: string): ProviderPort {
  return {
    describe() {
      return {
        capabilities: {
          streaming: true,
          toolCalls: false,
          parallelToolCalls: false,
          structuredOutput: false,
          reasoningMetadata: true,
          promptCaching: false,
          vision: false,
          tokenCounting: false,
          modelListing: false,
        },
        descriptor: { providerId: "stub-reasoning" },
      };
    },
    async *stream(_req, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield {
        kind: "reasoning_delta",
        sequence: 0,
        attemptId: opts.attemptId,
        text: `${REASONING_MARKER} deliberating before answering...`,
      };
      yield { kind: "text_delta", sequence: 1, attemptId: opts.attemptId, text: answerText };
      yield { kind: "model_end", sequence: 2, attemptId: opts.attemptId };
    },
  };
}

test("flow 268 T18: spawn_subagent's result summary never contains the child's reasoning marker (AC12)", async () => {
  const events: SpawnSubagentFleetEvent[] = [];
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => reasoningProvider("Child found 2 issues in auth."),
    getDetectedProviders: () => [{ name: "ollama" }],
    idSeq: (() => {
      let n = 0;
      return () => `id-${n++}`;
    })(),
    clock: () => "2020-01-01T00:00:00.000Z",
    onFleetEvent: (event) => events.push(event),
  });

  const result = await tool.invoke({
    task: "Review auth module briefly",
    mode: "read_only",
    label: "auth-check",
  });

  expect(result.isError).toBe(false);
  expect(result.output).toMatch(/Child found 2 issues/);
  expect(result.output).not.toContain(REASONING_MARKER);

  // The reasoning DID flow through the fleet log channel (proves the marker
  // was really emitted by the provider, not just absent by construction) —
  // it just never reached the parent-visible result.
  const reasoningLogs = events.filter(
    (event) => event.kind === "log" && event.entry.kind === "reasoning",
  );
  expect(reasoningLogs.some((event) => event.kind === "log" && event.entry.text.includes(REASONING_MARKER))).toBe(
    true,
  );
});

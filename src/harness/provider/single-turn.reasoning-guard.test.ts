// flow 268 T18 — guard test: runModelTurn's returned `text` must never carry
// reasoning text, only answer text (AC12).
//
// The model event stream carries `reasoning_delta` (chain-of-thought text)
// and `text_delta` (the answer) as separate event kinds — see
// `../../harness/provider/types.ts`'s `NormalizedEvent` doc comment (flow 268
// T11). `runModelTurn` (./single-turn.ts) already only folds `text_delta`
// into `result.text` and only flips `result.reasoning` to `true` on a
// `reasoning_delta` (see its `for await` loop) — this test pins that
// contract with a concrete marker string so a future change that starts
// accumulating `reasoning_delta.text` into `result.text` fails loudly.

import { describe, expect, test } from "bun:test";
import { runModelTurn, type ProviderFactory } from "./single-turn";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "./types";

const REASONING_MARKER = "REASONING-MARKER-268";

/** A provider that emits reasoning text (with the marker) AND a normal answer. */
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
    async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield {
        kind: "reasoning_delta",
        sequence: 0,
        attemptId: opts.attemptId,
        text: `${REASONING_MARKER} thinking about the answer...`,
      };
      yield { kind: "text_delta", sequence: 1, attemptId: opts.attemptId, text: answerText };
      yield { kind: "model_end", sequence: 2, attemptId: opts.attemptId };
    },
  };
}

describe("flow 268 T18: runModelTurn never leaks reasoning into the returned text (AC12)", () => {
  test("result.text excludes the reasoning marker; result.reasoning is true", async () => {
    const factory: ProviderFactory = () => reasoningProvider("42 is the answer.");
    const result = await runModelTurn({
      system: "s",
      user: "u",
      provider: "anthropic",
      env: {},
      preferSavedShell: false,
      providerFactory: factory,
      requestId: "flow-268-t18-single-turn",
    });

    expect(result.text).toBe("42 is the answer.");
    expect(result.text).not.toContain(REASONING_MARKER);
    expect(result.reasoning).toBe(true);
  });

  test("reasoning-only stream (no text_delta) leaves text empty, never falls back to reasoning text", async () => {
    const factory: ProviderFactory = () => ({
      describe: reasoningProvider("unused").describe,
      async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
        yield {
          kind: "reasoning_delta",
          sequence: 0,
          attemptId: opts.attemptId,
          text: `${REASONING_MARKER} only reasoning, no answer emitted`,
        };
        yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
      },
    });
    const result = await runModelTurn({
      system: "s",
      user: "u",
      provider: "anthropic",
      env: {},
      preferSavedShell: false,
      providerFactory: factory,
      requestId: "flow-268-t18-single-turn-reasoning-only",
    });

    expect(result.text).toBe("");
    expect(result.text).not.toContain(REASONING_MARKER);
    expect(result.reasoning).toBe(true);
  });
});

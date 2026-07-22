// Flow 115 follow-up / stress findings M1 and M4b.
//
// M4b: a child whose provider never answered was still running after the probe
// deadline. `maxRuntimeMs` on the reservation was pure ledger accounting — no
// timer, no AbortSignal, no cancellation path — so a hung child blocked the
// parent turn indefinitely.
//
// M1: `admitted=3/10`. Each spawn reserved 5 min out of a 15 min session budget
// and never gave any of it back, so a session could start three children
// however quickly they finished, with `DEFAULT_MAX_CHILDREN = 16` never
// approached.

import { expect, test } from "bun:test";
import { createSpawnSubagentTool, ENV_SUBAGENT_TIMEOUT_MS } from "./spawn-subagent-tool";
import type { NormalizedEvent, ProviderDescription, ProviderPort } from "../../provider/types";

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

/** A provider that answers immediately with a short summary. */
function fastProvider(): ProviderPort {
  return {
    describe: () => DESCRIPTION,
    stream: (_r, opts) =>
      (async function* (): AsyncGenerator<NormalizedEvent> {
        yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: "done" };
        yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
      })(),
  };
}

/** A provider that never yields and never returns. */
function hangingProvider(): ProviderPort {
  return {
    describe: () => DESCRIPTION,
    stream: () =>
      (async function* (): AsyncGenerator<NormalizedEvent> {
        await new Promise(() => {});
      })(),
  };
}

function toolWith(provider: () => ProviderPort) {
  let seq = 0;
  return createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "anthropic", modelId: "claude-sonnet-5" }),
    makeProvider: provider,
    getDetectedProviders: () => [{ name: "anthropic" }],
    idSeq: () => `id-${seq++}`,
    clock: () => "2026-07-21T00:00:00.000Z",
  });
}

test("a hung subagent is abandoned at its deadline instead of blocking the parent", async () => {
  const prev = process.env[ENV_SUBAGENT_TIMEOUT_MS];
  process.env[ENV_SUBAGENT_TIMEOUT_MS] = "250";
  try {
    const tool = toolWith(hangingProvider);
    const started = performance.now();
    const result = await tool.invoke({ task: "hang forever", label: "hung" });
    const elapsed = performance.now() - started;

    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/timed out/i);
    expect(elapsed).toBeLessThan(5_000);
  } finally {
    if (prev === undefined) delete process.env[ENV_SUBAGENT_TIMEOUT_MS];
    else process.env[ENV_SUBAGENT_TIMEOUT_MS] = prev;
  }
});

test("a fast subagent returns its unused budget, so a session is not capped at three", async () => {
  const tool = toolWith(fastProvider);
  const outcomes: boolean[] = [];
  for (let i = 0; i < 8; i++) {
    const result = await tool.invoke({ task: `probe ${i}`, label: `p${i}` });
    outcomes.push(result.isError);
  }
  // Before the fix the 4th spawn onwards was denied by the ledger.
  expect(outcomes).toEqual([false, false, false, false, false, false, false, false]);
});

test("a hung subagent still returns its budget — a timeout must not leak the reservation", async () => {
  const prev = process.env[ENV_SUBAGENT_TIMEOUT_MS];
  process.env[ENV_SUBAGENT_TIMEOUT_MS] = "150";
  try {
    const tool = toolWith(hangingProvider);
    // Four hung children in a row: without a release on the timeout path the
    // ledger would be exhausted and the fourth would be denied by MAE rather
    // than timing out.
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await tool.invoke({ task: `hang ${i}`, label: `h${i}` }));
    }
    for (const r of results) {
      expect(r.output).toMatch(/timed out/i);
      expect(r.output).not.toMatch(/denied by MAE/);
    }
  } finally {
    if (prev === undefined) delete process.env[ENV_SUBAGENT_TIMEOUT_MS];
    else process.env[ENV_SUBAGENT_TIMEOUT_MS] = prev;
  }
});

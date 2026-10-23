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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isEmptyRecord, splitUsage } from "../../../review/dispatch-usage";
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

/** A provider that refuses every request with a normalized error of `kind`. */
function refusingProvider(kind: "rate_limit" | "overloaded" | "unavailable", retryAfterMs?: number): () => ProviderPort {
  return () => ({
    describe: () => DESCRIPTION,
    stream: (_r, opts) =>
      (async function* (): AsyncGenerator<NormalizedEvent> {
        yield {
          kind: "provider_error",
          sequence: 0,
          attemptId: opts.attemptId,
          error: { kind, retryable: true, message: `429 ${kind}`, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
        };
      })(),
  });
}

test("E5: a rate-limited child is not 'Completed': it reports STATUS: RATE_LIMITED with the provider's retry-after", async () => {
  const result = await toolWith(refusingProvider("rate_limit", 30_500)).invoke({ task: "review", label: "r1" });
  expect(result.isError).toBe(true);
  expect(result.output.split("\n")[0]).toBe("STATUS: RATE_LIMITED (retry-after: 31s)");
});

test("E5: an overloaded child reports STATUS: RATE_LIMITED too; another provider error does not", async () => {
  const overloaded = await toolWith(refusingProvider("overloaded")).invoke({ task: "review", label: "r2" });
  expect(overloaded.output.split("\n")[0]).toBe("STATUS: RATE_LIMITED");
  const unavailable = await toolWith(refusingProvider("unavailable")).invoke({ task: "review", label: "r3" });
  expect(unavailable.output).not.toContain("RATE_LIMITED");
});

test("E5: a rate-limited child hands back the text it produced before the refusal", async () => {
  const provider = (): ProviderPort => ({
    describe: () => DESCRIPTION,
    stream: (_r, opts) =>
      (async function* (): AsyncGenerator<NormalizedEvent> {
        yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: "found the bug in parser.ts" };
        yield { kind: "provider_error", sequence: 1, attemptId: opts.attemptId, error: { kind: "rate_limit", retryable: true, message: "429" } };
      })(),
  });
  const result = await toolWith(provider).invoke({ task: "review", label: "r4" });
  expect(result.output.split("\n")[0]).toBe("STATUS: RATE_LIMITED");
  expect(result.output).toContain("found the bug in parser.ts");
});

test("E5 / flow 460 (H): a rate-limited child that reported no usage still records its dispatch at save_result_to (LG-002, LG-006)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-ratelimit-save-"));
  try {
    let seq = 0;
    const tool = createSpawnSubagentTool({
      cwd: root,
      getParentModel: () => ({ providerId: "anthropic", modelId: "claude-sonnet-5" }),
      makeProvider: refusingProvider("rate_limit"),
      getDetectedProviders: () => [{ name: "anthropic" }],
      idSeq: () => `id-${seq++}`,
      clock: () => "2026-07-21T00:00:00.000Z",
    });
    const result = await tool.invoke({ task: "review", label: "r5", save_result_to: "raw/review-logic.txt" });
    expect(result.output.split("\n")[0]).toBe("STATUS: RATE_LIMITED");
    const saved = await readFile(path.join(root, "raw/review-logic.txt"), "utf8");
    expect(isEmptyRecord(saved)).toBe(true);
    // One dispatch, usage unknown (no line states counts), and not a complete result.
    expect(splitUsage(saved)).toMatchObject({ incomplete: true });
    expect(splitUsage(saved).usage).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
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

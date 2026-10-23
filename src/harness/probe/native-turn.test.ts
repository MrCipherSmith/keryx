import { expect, test } from "bun:test";
import { nativeProbeTurn, probeReservationUsd } from "./native-turn";

test("unknown or invalid pricing cannot authorize a provider request", () => {
  expect(probeReservationUsd(undefined)).toBe(Infinity);
  expect(probeReservationUsd({ input: -1, output: 1 })).toBe(Infinity);
  expect(probeReservationUsd({ input: NaN, output: 1 })).toBe(Infinity);
});

test("reservation covers every bounded request, not just the first", () => {
  const amount = probeReservationUsd({ input: 2, output: 10 });
  expect(amount).toBeGreaterThan(4 * (65536 * 2 + 1024 * 10) / 1e6);
  expect(Number.isFinite(amount)).toBe(true);
  expect(probeReservationUsd({ input: 0, output: 0 })).toBeGreaterThan(0);
});

import { scriptedProvider, type Script } from "../../commands/agent.test-helpers";
import type { ProbeTurnInput } from "./runner";
const turnInput: ProbeTurnInput = { root: process.cwd(), arm: "base", seed: 0,
  instructions: "Read only", prompt: "Find the function", checkpointPath: "unused" };
const answerEvent = { kind: "text_delta" as const, text: "FILE: src/a.ts SYMBOL: example" };
const failureEvent = { kind: "provider_error" as const,
  error: { kind: "unavailable" as const, retryable: false, message: "fixture failure" } };
for (const ending of [[failureEvent], []]) test(`partial answer is rejected: ${JSON.stringify(ending)}`, async () => {
  const { provider } = scriptedProvider([[answerEvent, ...ending]]);
  await expect(nativeProbeTurn(turnInput, "fixture", "fixture", { provider })).rejects.toThrow();
});
test("completed text answer is accepted", async () => {
  const { provider } = scriptedProvider([[answerEvent, { kind: "model_end" }]]);
  expect((await nativeProbeTurn(turnInput, "fixture", "fixture", { provider })).answer).toBe(answerEvent.text);
});
test("later round failure cannot reuse earlier text", async () => {
  const first: Script = [answerEvent, { kind: "tool_call_start", toolCallId: "read", toolName: "get_cwd" },
    { kind: "tool_call_end", toolCallId: "read", input: "{}" }, { kind: "model_end" }];
  const { provider } = scriptedProvider([first, [failureEvent]]);
  await expect(nativeProbeTurn(turnInput, "fixture", "fixture", { provider })).rejects.toThrow();
});
for (const afterToken of [false, true]) test(`deadline cancels stalled transport: afterToken=${afterToken}`, async () => {
  const { provider } = scriptedProvider([]);
  let aborted = false; let settled = false;
  provider.stream = (_request, options) => (async function* () {
    try {
      if (afterToken) yield { ...answerEvent, sequence: 0, attemptId: options.attemptId };
      await new Promise<void>((_resolve, reject) => {
        const stop = () => { aborted = true; reject(new Error("aborted transport")); };
        if (options.signal?.aborted) stop();
        else options.signal?.addEventListener("abort", stop, { once: true });
      });
    } finally { settled = true; }
  })();
  await expect(nativeProbeTurn(turnInput, "fixture", "fixture", { provider, timeoutMs: 20 })).rejects.toThrow();
  expect(aborted).toBe(true); expect(settled).toBe(true);
});
test("operator cancellation cannot start a request", async () => {
  const controller = new AbortController(); controller.abort();
  const { provider, requests } = scriptedProvider([[answerEvent, { kind: "model_end" }]]);
  await expect(nativeProbeTurn({ ...turnInput, signal: controller.signal }, "fixture", "fixture", { provider })).rejects.toThrow();
  expect(requests).toHaveLength(0);
});

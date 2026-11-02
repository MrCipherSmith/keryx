import { expect, test } from "bun:test";
import {
  invokeWithBackstop,
  resolveSubagentHardCapMs,
  SUBAGENT_CHILD_RESERVATION_MS,
  SUBAGENT_HARD_CAP_GRACE_MS,
} from "./spawn-subagent-tool";

test("a call that never returns is answered with a Timeout result and its child is aborted", async () => {
  let aborted = false;
  const hang = (_input: Record<string, unknown>, ctx?: { signal?: AbortSignal }) =>
    new Promise<never>(() => {
      ctx?.signal?.addEventListener("abort", () => {
        aborted = true;
      });
    });
  const result = await invokeWithBackstop(hang, { task: "x" }, undefined, 20);
  expect(result.status).toBe("Timeout");
  expect(result.isError).toBe(true);
  expect(aborted).toBe(true);
});

test("a call that returns in time is passed through untouched", async () => {
  const result = await invokeWithBackstop(async () => ({ status: "Completed", output: "ok", isError: false }), { task: "x" }, undefined, 1000);
  expect(result).toEqual({ status: "Completed", output: "ok", isError: false });
});

test("a rejection inside the call still reaches the caller", async () => {
  await expect(
    invokeWithBackstop(() => Promise.reject(new Error("setup failed")), { task: "x" }, undefined, 1000),
  ).rejects.toThrow("setup failed");
});

test("the parent's abort reaches the child through the backstop", async () => {
  const parent = new AbortController();
  let seen: AbortSignal | undefined;
  const run = invokeWithBackstop(
    (_input, ctx) => {
      seen = ctx?.signal;
      return new Promise((resolve) => ctx?.signal?.addEventListener("abort", () => resolve({ status: "Error", output: "stopped", isError: true })));
    },
    { task: "x" },
    { signal: parent.signal },
    5000,
  );
  parent.abort();
  expect((await run).output).toBe("stopped");
  expect(seen?.aborted).toBe(true);
});

test("the cap is the child deadline plus the grace; off for external runtimes and a disabled deadline", () => {
  expect(resolveSubagentHardCapMs({ task: "x" }, {})).toBe(SUBAGENT_CHILD_RESERVATION_MS + SUBAGENT_HARD_CAP_GRACE_MS);
  expect(resolveSubagentHardCapMs({ task: "x" }, { KERYX_SUBAGENT_TIMEOUT_MS: "60000" })).toBe(60_000 + SUBAGENT_HARD_CAP_GRACE_MS);
  expect(resolveSubagentHardCapMs({ task: "x" }, { KERYX_SUBAGENT_TIMEOUT_MS: "0" })).toBe(0);
  expect(resolveSubagentHardCapMs({ task: "x", runtime: { kind: "external" } }, {})).toBe(0);
});

test("the cap follows the deadline the call was granted, not the fixed default", () => {
  const thirtyMin = 30 * 60_000;
  expect(resolveSubagentHardCapMs({ task: "x", timeout_ms: thirtyMin }, {})).toBe(thirtyMin + SUBAGENT_HARD_CAP_GRACE_MS);
  expect(resolveSubagentHardCapMs({ task: "x", runtime: { kind: "keryx", timeoutMs: thirtyMin } }, {})).toBe(
    thirtyMin + SUBAGENT_HARD_CAP_GRACE_MS,
  );
  // The operator override still tightens it, and a disabled deadline still disables the cap.
  expect(resolveSubagentHardCapMs({ task: "x", timeout_ms: thirtyMin }, { KERYX_SUBAGENT_TIMEOUT_MS: "60000" })).toBe(
    60_000 + SUBAGENT_HARD_CAP_GRACE_MS,
  );
  expect(resolveSubagentHardCapMs({ task: "x", timeout_ms: thirtyMin }, { KERYX_SUBAGENT_TIMEOUT_MS: "0" })).toBe(0);
  // A malformed request falls back to the default (the call itself is refused by invoke()).
  expect(resolveSubagentHardCapMs({ task: "x", timeout_ms: -5 }, {})).toBe(SUBAGENT_CHILD_RESERVATION_MS + SUBAGENT_HARD_CAP_GRACE_MS);
});

test("a huge model-supplied timeout_ms is clamped to the largest timer delay (2^31-1)", () => {
  // Past 2^31-1 a setTimeout fires after ~1 ms, which would abandon the child at once.
  expect(resolveSubagentHardCapMs({ task: "x", timeout_ms: Number.MAX_SAFE_INTEGER }, {})).toBe(2 ** 31 - 1);
});

test("a cap of zero runs the call directly with the caller's own context", async () => {
  const ctx = { signal: new AbortController().signal };
  let seen: unknown;
  await invokeWithBackstop(
    async (_input, received) => {
      seen = received;
      return { status: "Completed", output: "ok", isError: false };
    },
    { task: "x" },
    ctx,
    0,
  );
  expect(seen).toBe(ctx);
});

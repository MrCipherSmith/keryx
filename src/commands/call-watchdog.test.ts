import { expect, test } from "bun:test";
import { DEFAULT_CALL_WATCHDOG_MS, ENV_CALL_WATCHDOG_MS, resolveCallWatchdogMs, runWithCallWatchdog } from "./call-watchdog";

test("a call that never settles is answered with the stage it was stuck in", async () => {
  const result = await runWithCallWatchdog(
    "spawn_subagent",
    (_signal, stage) => {
      stage.current = "post-tool-hook";
      return new Promise<never>(() => {});
    },
    { capMs: 20 },
  );
  expect(result.isError).toBe(true);
  expect(result.output).toContain('stage "post-tool-hook"');
});

test("a call that finishes in time is passed through", async () => {
  const result = await runWithCallWatchdog("spawn_subagent", async () => ({ output: "ok", isError: false }), { capMs: 1000 });
  expect(result).toEqual({ output: "ok", isError: false });
});

test("the operator's abort answers the call after the grace even when the tool ignores the signal", async () => {
  const operator = new AbortController();
  const run = runWithCallWatchdog("spawn_subagent", () => new Promise<never>(() => {}), {
    signal: operator.signal,
    capMs: 60_000,
    abortGraceMs: 20,
  });
  operator.abort();
  const result = await run;
  expect(result.isError).toBe(true);
  expect(result.output).toContain("cancelled by the operator");
});

test("the clock does not run while a human is deciding on the approval", async () => {
  let release: (() => void) | undefined;
  const run = runWithCallWatchdog(
    "spawn_subagent",
    (_signal, stage) => {
      stage.current = "approval";
      return new Promise<{ output: string; isError: boolean }>((resolve) => {
        release = () => resolve({ output: "approved and done", isError: false });
      });
    },
    { capMs: 15 },
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  release?.();
  expect((await run).output).toBe("approved and done");
});

test("a rejection inside the call reaches the caller; zero disables the watchdog", async () => {
  await expect(runWithCallWatchdog("x", () => Promise.reject(new Error("boom")), { capMs: 1000 })).rejects.toThrow("boom");
  expect(await runWithCallWatchdog("x", async () => ({ output: "plain", isError: false }), { capMs: 0 })).toEqual({ output: "plain", isError: false });
});

test("the cap defaults, takes an env override, and ignores junk", () => {
  expect(resolveCallWatchdogMs({})).toBe(DEFAULT_CALL_WATCHDOG_MS);
  expect(resolveCallWatchdogMs({ [ENV_CALL_WATCHDOG_MS]: "90000" })).toBe(90_000);
  expect(resolveCallWatchdogMs({ [ENV_CALL_WATCHDOG_MS]: "0" })).toBe(0);
  expect(resolveCallWatchdogMs({ [ENV_CALL_WATCHDOG_MS]: "soon" })).toBe(DEFAULT_CALL_WATCHDOG_MS);
});

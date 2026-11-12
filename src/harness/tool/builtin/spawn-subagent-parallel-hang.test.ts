// Flow 487: a batch of parallel spawn_subagent calls must come back even when one call never settles.
// The parent turn waits on every result of the batch, so one lost call parks the whole session.
import { expect, test } from "bun:test";
import { runWithCallWatchdog, type CallStage } from "../../../commands/call-watchdog";
import { invokeWithBackstop, type SubagentCompletionStatus } from "./spawn-subagent-tool";

const BATCH = 9;
const HUNG_INDEX = 4;

type Result = { status: SubagentCompletionStatus; output: string; isError: boolean };

const ok = async (): Promise<Result> => ({ status: "Completed", output: "ok", isError: false });
/** A child run that never settles and ignores the abort signal. */
const hang = (): Promise<Result> => new Promise<Result>(() => {});

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timed-out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), ms);
  });
  return Promise.race([promise, limit]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

test("a batch of 9 returns when one child hangs inside invoke: the backstop answers it", async () => {
  const calls = Array.from({ length: BATCH }, (_, i) =>
    invokeWithBackstop(i === HUNG_INDEX ? hang : ok, { task: `t${i}` }, undefined, 30),
  );
  const settled = await withTimeout(Promise.allSettled(calls), 2000);
  expect(settled).not.toBe("timed-out");
  if (settled === "timed-out") return;
  expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
  const results = settled.map((s) => (s.status === "fulfilled" ? s.value : undefined));
  expect(results[HUNG_INDEX]?.status).toBe("Timeout");
  expect(results.filter((r) => r?.status === "Completed")).toHaveLength(BATCH - 1);
});

test("a batch of 9 returns when one call stalls OUTSIDE invoke (after the tool): the call watchdog answers it", async () => {
  const calls = Array.from({ length: BATCH }, (_, i) =>
    runWithCallWatchdog(
      "spawn_subagent",
      async (_signal, stage: CallStage) => {
        stage.current = "invoke";
        if (i === HUNG_INDEX) {
          await hang();
        }
        stage.current = "post-tool-hook";
        return ok();
      },
      { capMs: 40, abortGraceMs: 10 },
    ),
  );
  const settled = await withTimeout(Promise.allSettled(calls), 2000);
  expect(settled).not.toBe("timed-out");
  if (settled === "timed-out") return;
  const hung = settled[HUNG_INDEX];
  expect(hung?.status).toBe("fulfilled");
  if (hung?.status === "fulfilled") {
    expect(hung.value.isError).toBe(true);
    expect(hung.value.output).toContain('stuck at stage "invoke"');
  }
  expect(settled.filter((s) => s.status === "fulfilled" && !s.value.isError)).toHaveLength(BATCH - 1);
});

test("the full stack: watchdog around the backstop around a child that never settles", async () => {
  const calls = Array.from({ length: BATCH }, (_, i) =>
    runWithCallWatchdog(
      "spawn_subagent",
      async (signal, stage: CallStage) => {
        stage.current = "invoke";
        const result = await invokeWithBackstop(
          i === HUNG_INDEX ? hang : ok,
          { task: `t${i}` },
          signal === undefined ? undefined : { signal },
          30,
        );
        stage.current = "post-tool-hook";
        return result;
      },
      { capMs: 500, abortGraceMs: 10 },
    ),
  );
  const settled = await withTimeout(Promise.allSettled(calls), 2000);
  expect(settled).not.toBe("timed-out");
  if (settled === "timed-out") return;
  expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
});

test("a call parked at the human 'approval' stage is still answered once the operator aborts the turn", async () => {
  const turn = new AbortController();
  const run = runWithCallWatchdog(
    "spawn_subagent",
    async (_signal, stage: CallStage) => {
      stage.current = "approval";
      return hang();
    },
    { signal: turn.signal, capMs: 20, abortGraceMs: 20 },
  );
  // The watchdog clock does not run on the approval stage (HUMAN_STAGES) ...
  expect(await withTimeout(run, 120)).toBe("timed-out");
  // ... but the operator's abort must still free the call after the grace.
  turn.abort();
  const result = await withTimeout(run, 500);
  expect(result).not.toBe("timed-out");
  if (result !== "timed-out") expect(result.isError).toBe(true);
});

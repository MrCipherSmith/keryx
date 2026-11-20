import { expect, test } from "bun:test";
import { REPO_RETRY_DELAYS, lookupWithRetry } from "./repoLookup";

function harness(results: Array<string | null | Error>) {
  const delays: number[] = [];
  const pending: Array<() => void> = [];
  const answers: Array<string | null> = [];
  let calls = 0;
  const lookup = () => {
    const r = results[Math.min(calls++, results.length - 1)];
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r ?? null);
  };
  const schedule = (run: () => void, ms: number) => {
    delays.push(ms);
    pending.push(run);
    return () => { pending.length = 0; };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { lookup, schedule, delays, pending, answers, calls: () => calls, flush };
}

test("a busy rejection is retried until the host answers", async () => {
  const h = harness([new Error("busy: x"), new Error("busy: x"), "o/r"]);
  lookupWithRetry(h.lookup, (n) => h.answers.push(n), h.schedule, () => 0.5);
  await h.flush();
  expect(h.answers).toEqual([]);
  h.pending.shift()?.();
  await h.flush();
  h.pending.shift()?.();
  await h.flush();
  expect(h.answers).toEqual(["o/r"]);
  expect(h.delays).toEqual([REPO_RETRY_DELAYS[0], REPO_RETRY_DELAYS[1]]);
});

test("a real null answer is reported once and not retried", async () => {
  const h = harness([null]);
  lookupWithRetry(h.lookup, (n) => h.answers.push(n), h.schedule);
  await h.flush();
  expect(h.answers).toEqual([null]);
  expect(h.pending).toHaveLength(0);
});

test("when the retries run out nothing is reported: unknown is not remembered as no remote", async () => {
  const h = harness([new Error("busy: x")]);
  lookupWithRetry(h.lookup, (n) => h.answers.push(n), h.schedule, () => 0.5);
  for (let i = 0; i <= REPO_RETRY_DELAYS.length; i++) {
    await h.flush();
    h.pending.shift()?.();
  }
  await h.flush();
  expect(h.calls()).toBe(REPO_RETRY_DELAYS.length + 1);
  expect(h.answers).toEqual([]);
});

test("jitter spreads the delay and cancelling stops further work", async () => {
  const low = harness([new Error("busy: x")]);
  lookupWithRetry(low.lookup, () => {}, low.schedule, () => 0);
  const high = harness([new Error("busy: x")]);
  const cancel = lookupWithRetry(high.lookup, () => {}, high.schedule, () => 1);
  await low.flush();
  expect(low.delays[0]).toBe(Math.round(REPO_RETRY_DELAYS[0] * 0.8));
  expect(high.delays[0]).toBe(Math.round(REPO_RETRY_DELAYS[0] * 1.2));
  cancel();
  expect(high.pending).toHaveLength(0);
});

// The shell-side run guard (flow 376, block 2; the "run limits" half of AC11).
//
// A run started from Telegram must not be able to hold a shell forever. The guard
// gives `fn` an `AbortSignal`, interrupts it when `runMs` has passed, and tells
// the topic. It does not depend on `fn` behaving: after the timeout the caller
// gets its answer even if `fn` ignores the signal, and whatever `fn` later does
// is swallowed rather than surfacing as an unhandled rejection.

import { type HubTimers, realTimers } from "./hub";

export type RunOutcome<T> = { ok: true; value: T } | { ok: false; timedOut: true; runMs: number };

export function describeRunLimit(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** The notice posted to the topic when a run is interrupted. */
export function runTimeoutNotice(runMs: number): string {
  return `Run interrupted: it exceeded the ${describeRunLimit(runMs)} limit.`;
}

/**
 * Run `fn` for at most `runMs`. On timeout the signal is aborted, `onTimeout` is
 * awaited (post the notice there) and `{ ok: false, timedOut: true }` is
 * returned. An error thrown by `fn` before the timeout propagates as usual.
 */
export async function withRunTimeout<T>(
  runMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  onTimeout: (info: { runMs: number }) => void | Promise<void>,
  timers: HubTimers = realTimers,
): Promise<RunOutcome<T>> {
  if (!Number.isFinite(runMs) || runMs < 1) {
    throw new RangeError("runMs must be a positive number of milliseconds");
  }
  const controller = new AbortController();
  let timer: unknown;
  const expired = new Promise<"timeout">((resolve) => {
    timer = timers.setTimeout(() => resolve("timeout"), runMs);
  });
  const running = fn(controller.signal).then(
    (value) => ({ kind: "done" as const, value }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  try {
    const first = await Promise.race([running, expired]);
    if (first === "timeout") {
      controller.abort(new Error(`run exceeded ${runMs} ms`));
      try {
        await onTimeout({ runMs });
      } catch {
        // A notice that cannot be posted must not turn an interrupted run into a crash.
      }
      return { ok: false, timedOut: true, runMs };
    }
    if (first.kind === "failed") {
      throw first.error;
    }
    return { ok: true, value: first.value };
  } finally {
    timers.clearTimeout(timer);
  }
}

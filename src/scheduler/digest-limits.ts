// Flow 389 (AC7): the limits of one digest run.
//
//   dollar  the dispatch `ceilingUsd`. The digest's only model call is the optional
//           summary; it is reserved under the project-wide spend lock and metered
//           (flow 295's `reserveTriggerSpend` and `createSpendMeter`). Reaching the
//           reservation stops the call. The tool calls cost nothing.
//   memory  `action.digest.memoryLimitMb`, checked against this process's resident
//           set at every checkpoint (after each repository and each step) and on an
//           interval while a call is in flight.
//   time    the dispatch `maxSeconds`, through the same `armTimeout` seam the
//           other scheduled runs use.
//
// A limit that trips aborts one `AbortSignal`. That signal is passed into every gh
// call and the summary call, and checked between steps, so the run stops at once and
// the report states which limit it was. Nothing here reads a clock or the machine
// directly except through the seams, so a test trips each limit deterministically.

import { defaultArmTimeout } from "../commands/trigger-agent-task";

export type LimitKind = "timeout" | "memory" | "spend";

export interface DigestLimitDeps {
  readonly armTimeout?: (ms: number, fire: () => void) => () => void;
  /** Resident memory of this process in MiB. */
  readonly rssMb?: () => number;
  /** Start a repeating memory check; returns the stop function. Default: `setInterval`, unref'd. */
  readonly armWatch?: (fire: () => void, everyMs: number) => () => void;
}

export interface RunLimits {
  /** Aborted as soon as any limit trips. */
  readonly signal: AbortSignal;
  /** The first limit that tripped, or undefined. */
  tripped(): LimitKind | undefined;
  /** Why the run stopped, in a sentence, or undefined while it is within its limits. */
  reason(): string | undefined;
  /** Check the memory limit now. Call after each step. Returns true when the run must stop. */
  checkpoint(): boolean;
  /** Record that the dollar limit was reached (called by the spend meter's abort hook). */
  spendStopped(): void;
  /** Stop the timer and the watch. Idempotent. */
  dispose(): void;
}

const WATCH_EVERY_MS = 1000;

function defaultArmWatch(fire: () => void, everyMs: number): () => void {
  const timer = setInterval(fire, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function startLimits(
  limits: { readonly maxSeconds: number; readonly memoryLimitMb: number },
  deps: DigestLimitDeps = {},
): RunLimits {
  const controller = new AbortController();
  let tripped: LimitKind | undefined;
  let detail = "";
  const rss = deps.rssMb ?? ((): number => process.memoryUsage().rss / (1024 * 1024));

  const trip = (kind: LimitKind, why: string): void => {
    if (tripped !== undefined) return;
    tripped = kind;
    detail = why;
    controller.abort();
  };
  const checkMemory = (): void => {
    if (tripped !== undefined) return;
    const used = rss();
    if (used > limits.memoryLimitMb) trip("memory", `memory limit exceeded (${Math.round(used)} MiB used, limit ${limits.memoryLimitMb} MiB)`);
  };

  const disarmTimeout = (deps.armTimeout ?? defaultArmTimeout)(limits.maxSeconds * 1000, () => trip("timeout", `timed out after ${limits.maxSeconds}s`));
  const disarmWatch = (deps.armWatch ?? defaultArmWatch)(checkMemory, WATCH_EVERY_MS);
  let disposed = false;

  return {
    signal: controller.signal,
    tripped: () => tripped,
    reason: () => (tripped === undefined ? undefined : detail),
    checkpoint: () => {
      checkMemory();
      return tripped !== undefined;
    },
    spendStopped: () => trip("spend", "spend cap reached — the run was stopped at its remaining allowance"),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      disarmTimeout();
      disarmWatch();
    },
  };
}

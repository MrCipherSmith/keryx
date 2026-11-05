import { renewReviewV3ControllerLease } from "./store";

export type ReviewV3DeadlineKind = "assignment" | "run";

export interface ReviewV3Deadline {
  readonly stop: () => void;
}

/** Controller-owned deadlines, independent of whether an adapter honours requested limits. */
export function createReviewV3Deadline(options: {
  readonly assignmentRemainingMs: number;
  readonly runRemainingMs: number;
  readonly onExpire: (kind: ReviewV3DeadlineKind) => void | Promise<void>;
  readonly onFailure?: (error: unknown) => void;
  readonly now?: () => number;
}): ReviewV3Deadline {
  for (const [name, value] of [["assignmentRemainingMs", options.assignmentRemainingMs], ["runRemainingMs", options.runRemainingMs]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  }
  let assignmentTimer: ReturnType<typeof setTimeout> | undefined;
  let runTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (assignmentTimer !== undefined) clearTimeout(assignmentTimer);
    if (runTimer !== undefined) clearTimeout(runTimer);
    assignmentTimer = undefined; runTimer = undefined;
  };
  const expire = (kind: ReviewV3DeadlineKind) => {
    if (stopped) return;
    stop();
    void Promise.resolve(options.onExpire(kind)).catch((error: unknown) => options.onFailure?.(error));
  };
  assignmentTimer = setTimeout(() => expire("assignment"), options.assignmentRemainingMs); assignmentTimer.unref?.();
  runTimer = setTimeout(() => expire("run"), options.runRemainingMs); runTimer.unref?.();

  return { stop };
}

/** Delay for polling paths; removes its abort listener on timer and abort completion. */
export function reviewV3AbortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(ms) || ms < 0) return Promise.reject(new Error("delay must be a non-negative safe integer"));
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(signal?.reason ?? new Error("aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface ReviewV3LeaseHeartbeat {
  readonly renewNow: () => Promise<void>;
  readonly stop: () => void;
}

/** Serial lease renewal. The first failure stops the heartbeat and fences controller work. */
export function startReviewV3LeaseHeartbeat(options: {
  readonly storageDir: string;
  readonly ownerId: string;
  readonly fencingToken: string;
  readonly leaseMs: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly onRenew?: () => void;
  readonly onFailure: (error: unknown) => void;
}): ReviewV3LeaseHeartbeat {
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 2) throw new Error("leaseMs must be a safe integer >= 2");
  const intervalMs = options.intervalMs ?? Math.max(1, Math.floor(options.leaseMs / 3));
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs >= options.leaseMs) throw new Error("intervalMs must be positive and shorter than leaseMs");
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const stop = () => { if (stopped) return; stopped = true; clearInterval(timer); };
  const renewNow = async (): Promise<void> => {
    if (stopped) throw new Error("review V3 lease heartbeat is stopped");
    if (inFlight !== undefined) return inFlight;
    inFlight = renewReviewV3ControllerLease(options.storageDir, options.ownerId, options.fencingToken, options.leaseMs, options.now?.() ?? Date.now())
      .then(() => { options.onRenew?.(); })
      .catch((error: unknown) => { stop(); options.onFailure(error); throw error; })
      .finally(() => { inFlight = undefined; });
    return inFlight;
  };
  const timer = setInterval(() => { void renewNow().catch(() => undefined); }, intervalMs); timer.unref?.();
  return { renewNow, stop };
}

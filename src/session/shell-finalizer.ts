// Flow 415: one awaited preservation barrier per shell lifetime.
export interface ShellFinalizerSteps {
  stop: () => void | Promise<void>;
  stopTimeoutMs?: number;
  /** Second deadline after `stopTimeoutMs`: past it the stuck operation is abandoned and preserve/release still run. */
  hardStopTimeoutMs?: number;
  checkpoint: () => void | Promise<void>;
  preserve: () => Promise<void>;
  cleanup: (signal: AbortSignal) => Promise<void>;
  release: () => void;
  cleanupTimeoutMs?: number;
  progress: (stage: "saving" | "waiting" | "stuck" | "queued" | "failed" | "released") => void;
}
export interface ShellFinalizationResult { preserved: boolean; cleanupFailed: boolean }
export function createShellFinalizer(steps: ShellFinalizerSteps): () => Promise<ShellFinalizationResult> {
  let flight: Promise<ShellFinalizationResult> | undefined;
  return () => {
    if (flight !== undefined) return flight;
    // Assign before callbacks run so synchronous reentry also joins.
    flight = Promise.resolve().then(async () => {
      let preserved = false;
      let cleanupFailed = false;
      const progress = (stage: Parameters<ShellFinalizerSteps["progress"]>[0]): void => {
        try { steps.progress(stage); } catch { /* EPIPE cannot bypass saving */ }
      };
      progress("saving");
      try {
        let stopTimer: ReturnType<typeof setTimeout> | undefined;
        const stopped = Promise.resolve().then(steps.stop);
        try {
          const settled = await Promise.race([
            stopped.then(() => true),
            new Promise<false>((resolve) => {
              stopTimer = setTimeout(() => resolve(false), steps.stopTimeoutMs ?? 10_000);
            }),
          ]);
          if (!settled) {
            // A deadline is not cancellation. Retain ownership until mutations stop.
            progress("waiting");
            try { await steps.checkpoint(); } catch { progress("failed"); }
            let hardTimer: ReturnType<typeof setTimeout> | undefined;
            const finished = await Promise.race([
              stopped.then(() => true, () => true),
              new Promise<false>((resolve) => {
                hardTimer = setTimeout(() => resolve(false), steps.hardStopTimeoutMs ?? 20_000);
              }),
            ]);
            if (hardTimer !== undefined) clearTimeout(hardTimer);
            if (!finished) progress("stuck");
          }
        } finally {
          if (stopTimer !== undefined) clearTimeout(stopTimer);
        }
        await steps.checkpoint();
        await steps.preserve();
        preserved = true;
        progress("queued");
      } catch { progress("failed"); }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanupAbort = new AbortController();
      try {
        await Promise.race([
          Promise.resolve().then(() => steps.cleanup(cleanupAbort.signal)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => { cleanupAbort.abort(); reject(new Error("optional cleanup timeout")); }, steps.cleanupTimeoutMs ?? 10_000);
          }),
        ]);
      } catch { cleanupFailed = true; }
      finally { cleanupAbort.abort(); if (timer !== undefined) clearTimeout(timer); }
      steps.release();
      progress("released");
      return { preserved, cleanupFailed };
    });
    return flight;
  };
}
/** Never echo disk/provider errors containing session content. */
export function preservationProgress(stage: Parameters<ShellFinalizerSteps["progress"]>[0]): string {
  switch (stage) {
    case "saving": return "keryx: saving session history and memory…";
    case "waiting": return "keryx: active operation is still stopping; saving partial checkpoint and retaining session ownership until it settles.";
    case "stuck": return "keryx: the active operation did not stop; saving what is recorded and releasing session ownership anyway.";
    case "queued": return "keryx: local evidence preserved; workspace review/delivery pending (not accepted memory).";
    case "failed": return "keryx: PRESERVATION FAILED; session was not confirmed saved. Inspect session storage before resuming.";
    case "released": return "keryx: session ownership released.";
  }
}

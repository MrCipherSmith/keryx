import { appendFileSync } from "node:fs";

export interface ShellStartupTrace {
  mark(stage: string): void;
  finish(): void;
}

const disabled: ShellStartupTrace = { mark() {}, finish() {} };

/** Opt-in JSONL diagnostics. Stage durations are incremental wall time, not CPU time.
 * maxLagMs is timer lateness (25ms cadence), not the duration of a single task.
 * Marks also inspect an overdue timer, catching synchronous stalls before it fires.
 * The destination's parent directory must already exist; no session data is logged.
 */
export function startShellStartupTrace(
  scope: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = () => performance.now(),
): ShellStartupTrace {
  const destination = env.KERYX_SHELL_STARTUP_TRACE;
  if (!destination) return disabled;
  const started = now();
  let previous = started;
  let expected = started + 25;
  let maxLagMs = 0;
  let samples = 0;
  let finished = false;
  const stages: { stage: string; durationMs: number; elapsedMs: number }[] = [];
  const observe = (time: number): void => {
    maxLagMs = Math.max(maxLagMs, time - expected);
  };
  const timer = setInterval(() => {
    const time = now();
    observe(time);
    samples++;
    expected = time + 25;
  }, 25);
  timer.unref();
  return {
    mark(stage) {
      if (finished) return;
      const time = now();
      observe(time);
      stages.push({ stage, durationMs: time - previous, elapsedMs: time - started });
      previous = time;
    },
    finish() {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      const time = now();
      observe(time);
      try {
        appendFileSync(destination, JSON.stringify({
          scope, pid: process.pid, durationMs: time - started, stages,
          eventLoop: { maxLagMs, samples },
        }) + "\n", { mode: 0o600 });
      } catch (error) {
        // Diagnostics must not prevent the session starting or mask its error.
        process.emitWarning(`Shell startup trace could not be written: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

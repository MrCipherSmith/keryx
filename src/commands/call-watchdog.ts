import { composeAbortSignals } from "../lib/abort-compose";
import { callDiagnostics, type DiagOutcome } from "../lib/call-diagnostics";
import { tracePhase } from "../lib/phase-trace";

export type CallStage = { current: string };

export const ENV_CALL_WATCHDOG_MS = "KERYX_SPAWN_CALL_WATCHDOG_MS";

/** Past the 8 min spawn backstop: only a stall outside `invoke()` can still reach this. */
export const DEFAULT_CALL_WATCHDOG_MS = 12 * 60_000;

/** How long a tool that ignores the abort signal is given before the call is answered anyway. */
export const ABORT_GRACE_MS = 10_000;

/** Stage names whose wait belongs to a human, so the clock does not run on them. */
const HUMAN_STAGES: ReadonlySet<string> = new Set(["approval"]);

export function resolveCallWatchdogMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env[ENV_CALL_WATCHDOG_MS];
  if (raw === undefined || raw.trim() === "") return DEFAULT_CALL_WATCHDOG_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_CALL_WATCHDOG_MS;
}

type CallResult = { output: string; isError: boolean };

/**
 * Answer a tool call that cannot finish. A call that never settles parks the whole parent turn
 * (the archive writes the assistant message only after every result), and one that ignores the
 * operator's Esc cannot be stopped; both leave the session unrecoverable but for a kill.
 */
export async function runWithCallWatchdog<T extends CallResult>(
  name: string,
  run: (signal: AbortSignal | undefined, stage: CallStage) => Promise<T>,
  options: { signal?: AbortSignal | undefined; capMs?: number; abortGraceMs?: number; callId?: string } = {},
): Promise<T | CallResult> {
  const capMs = options.capMs ?? resolveCallWatchdogMs();
  const callId = options.callId;
  // Concurrent calls of one tool interleave in the trace; the id tells them apart.
  const tag = callId === undefined ? name : `${name}#${callId}`;
  let currentStage = "start";
  const stage: CallStage = {
    get current(): string {
      return currentStage;
    },
    set current(next: string) {
      currentStage = next;
      tracePhase(`${tag} stage ${next}`);
      if (callId !== undefined) callDiagnostics.stage(callId, next);
    },
  };
  tracePhase(`${tag} call start (watchdog ${capMs}ms)`);
  if (callId !== undefined) callDiagnostics.begin(callId, name);
  if (capMs <= 0) {
    let kind: DiagOutcome = "error";
    try {
      const result = await run(options.signal, stage);
      kind = result.isError ? "error" : "ok";
      return result;
    } finally {
      if (callId !== undefined) callDiagnostics.end(callId, kind);
    }
  }

  const graceMs = options.abortGraceMs ?? ABORT_GRACE_MS;
  const inner = new AbortController();
  const composed = composeAbortSignals(options.signal, inner.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let firedKind = undefined as DiagOutcome | undefined;

  const stalled = new Promise<CallResult>((resolve) => {
    const arm = (): void => {
      timer = setTimeout(() => {
        if (HUMAN_STAGES.has(stage.current)) {
          callDiagnostics.event("approval.rearm", tag);
          arm();
          return;
        }
        tracePhase(`${tag} watchdog fired at stage ${stage.current}`);
        callDiagnostics.event("watchdog.fired", `${tag} stage=${stage.current}`);
        firedKind = "watchdog";
        resolve({
          output:
            `${name} did not finish within ${capMs}ms and was abandoned by the harness watchdog ` +
            `(stuck at stage "${stage.current}"; tune with ${ENV_CALL_WATCHDOG_MS}). Retry on a smaller slice instead of waiting.`,
          isError: true,
        });
        try {
          inner.abort(new Error(`${name} watchdog`));
        } catch {
          // an abort listener that throws must not undo the answer already given
        }
      }, capMs);
    };
    arm();
    if (options.signal !== undefined) {
      onAbort = (): void => {
        graceTimer = setTimeout(
          () => {
            firedKind = "aborted";
            callDiagnostics.event("abort.abandoned", `${tag} stage=${stage.current}`);
            resolve({
              output: `${name} was cancelled by the operator and did not stop on its own (stage "${stage.current}"); the call was abandoned.`,
              isError: true,
            });
          },
          graceMs,
        );
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  const running = run(composed.signal, stage);
  let kind: DiagOutcome = "error";
  try {
    const outcome = await Promise.race([running, stalled]);
    kind = firedKind ?? (outcome.isError ? "error" : "ok");
    tracePhase(`${tag} call settled`);
    return outcome;
  } finally {
    if (callId !== undefined) callDiagnostics.end(callId, kind);
    if (timer !== undefined) clearTimeout(timer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (onAbort !== undefined) options.signal?.removeEventListener("abort", onAbort);
    composed.dispose();
    void running.catch(() => {
      // abandoned call; its outcome is ignored once the watchdog has answered
    });
  }
}

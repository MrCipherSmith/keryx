import { isBusy } from "./busy";

/** Seconds-scale ladder: the host answers "busy" while saturated; the repository only auto-links bare "PR #n" text. */
export const REPO_RETRY_DELAYS = [400, 1200, 3000, 15000, 30000] as const;

type Schedule = (run: () => void, ms: number) => () => void;
const timerSchedule: Schedule = (run, ms) => {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
};

/**
 * Ask for the project's GitHub repository. Only a "busy" refusal is retried (with jitter so views started together do
 * not retry in lockstep); any other failure (not a repository, git missing) is final, and nothing is reported for it.
 * Only a real answer is reported, so "unknown" is never remembered as "no GitHub remote". Returns a cancel function.
 */
export function lookupWithRetry(
  lookup: () => Promise<string | null>,
  onResult: (name: string | null) => void,
  schedule: Schedule = timerSchedule,
  jitter: () => number = Math.random,
): () => void {
  let active = true;
  let cancelTimer: () => void = () => {};
  const attempt = (n: number): void => {
    // `then(lookup)` also turns a synchronous throw into a rejection instead of an uncaught exception in a timer.
    void Promise.resolve().then(lookup).then(
      (name) => { if (active) onResult(name); },
      (error: unknown) => {
        if (!active || !isBusy(error)) return;
        const delay = REPO_RETRY_DELAYS[n];
        if (delay === undefined) return;
        cancelTimer = schedule(() => attempt(n + 1), Math.round(delay * (0.8 + jitter() * 0.4)));
      },
    );
  };
  attempt(0);
  return () => {
    active = false;
    cancelTimer();
  };
}

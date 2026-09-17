// Next-step suggestion helpers (flow 268, T8/AC14).
//
// Split out of `tui-shell.ts`'s `suggestNextStep` so the two load-bearing
// rules — what text is safe to show, and when an in-flight request must be
// thrown away — are each a small, directly testable pure unit instead of
// logic buried inside a closure with no headless injection seam (see
// `tui-shell.test.ts`'s "source-text audit" blocks for why that closure
// itself cannot be driven in tests).

/** Discard a raw model reply longer than this once normalized. */
export const NEXT_STEP_SUGGESTION_MAX_LENGTH = 80;
/** Never show more than this many words, even inside the length budget. */
export const NEXT_STEP_SUGGESTION_MAX_WORDS = 20;
/** Hard timeout for the underlying provider request. */
export const NEXT_STEP_SUGGESTION_TIMEOUT_MS = 8000;

/**
 * Normalize a raw "what's next" model reply and decide whether it is safe to
 * show as a composer placeholder. Returns the normalized text, or
 * `undefined` when it must be discarded: empty after normalizing whitespace,
 * exactly ".", longer than {@link NEXT_STEP_SUGGESTION_MAX_LENGTH} characters,
 * or containing `<`/`>` (never let raw model text near anything that could be
 * read as markup in a terminal-UI placeholder).
 */
export function sanitizeNextStepSuggestion(rawText: string): string | undefined {
  const words = rawText
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const normalized = words.slice(0, NEXT_STEP_SUGGESTION_MAX_WORDS).join(" ");
  if (normalized.length === 0) return undefined;
  if (normalized === ".") return undefined;
  if (normalized.length > NEXT_STEP_SUGGESTION_MAX_LENGTH) return undefined;
  if (normalized.includes("<") || normalized.includes(">")) return undefined;
  return normalized;
}

/**
 * Owns the single AbortController for the in-flight next-step suggestion
 * request. At most one request is ever outstanding — the shell only asks
 * once a main turn has fully settled with an empty queue — so `start()`
 * unconditionally supersedes whatever came before it, and `cancel()` is the
 * one seam both "a new turn started" and "the user typed" call into.
 *
 * `start()` returns a signal that already combines the request's own
 * controller with a hard timeout (mirrors every other single-turn provider
 * call in this codebase — see `commands/shell.ts`'s grant-refresh timeout)
 * plus an `isCurrent()` check: a request whose signal never actually aborts
 * (a provider that ignores `signal`) must still refuse to show a reply that
 * arrived after it was superseded or cancelled.
 */
export class NextStepSuggestionGate {
  private current: AbortController | undefined;

  /** Start a new request: aborts/replaces any previous one. */
  start(timeoutMs: number = NEXT_STEP_SUGGESTION_TIMEOUT_MS): { signal: AbortSignal; isCurrent: () => boolean } {
    this.cancel("superseded by a new suggestion request");
    const controller = new AbortController();
    this.current = controller;
    return {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
      isCurrent: () => this.current === controller,
    };
  }

  /** True while a request started by `start()` is still current. */
  get isActive(): boolean {
    return this.current !== undefined;
  }

  /** Cancel the in-flight request, if any — a new turn started, or the user typed. */
  cancel(reason?: unknown): void {
    this.current?.abort(reason);
    this.current = undefined;
  }
}

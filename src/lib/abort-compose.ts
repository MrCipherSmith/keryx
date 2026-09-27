// Composing two abort signals into one (flow 352 audit, AC6).
//
// Extracted from `src/wiki/deep-enrich.ts`, which needed exactly this to combine
// its OWN deadline timer with a caller-supplied cancellation signal into the one
// signal a child agent turn actually watches. `spawn_subagent`
// (`src/harness/tool/builtin/spawn-subagent-tool.ts`) needed the identical
// combination — its own timeout controller, plus the PARENT turn's abort signal
// (`ctx.signal`, threaded from `commands/agent.ts`'s `tool.invoke(input, {
// signal })`) — so this is the one copy of the composition rather than a second
// hand-written version.
//
// Pure event-plumbing: no clock, no I/O. `dispose()` removes both listeners, so a
// caller that keeps its EXTERNAL signal alive across many calls (a long-running
// turn spawning several children in sequence) does not accumulate one listener
// per call on it.

/** One derived signal that aborts when EITHER input does, plus its cleanup. */
export function composeAbortSignals(
  external: AbortSignal | undefined,
  internal: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  if (external === undefined) {
    return { signal: internal, dispose: () => {} };
  }
  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };
  const onExternalAbort = (): void => abortFrom(external);
  const onInternalAbort = (): void => abortFrom(internal);
  external.addEventListener("abort", onExternalAbort, { once: true });
  internal.addEventListener("abort", onInternalAbort, { once: true });
  if (external.aborted) abortFrom(external);
  if (internal.aborted) abortFrom(internal);
  return {
    signal: controller.signal,
    dispose: () => {
      external.removeEventListener("abort", onExternalAbort);
      internal.removeEventListener("abort", onInternalAbort);
    },
  };
}

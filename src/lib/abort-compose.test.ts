// Extracted from `wiki/deep-enrich.ts` for reuse by `spawn-subagent-tool.ts`
// (flow 352 audit, AC6) — see that file's header for why this is one copy.
import { describe, expect, test } from "bun:test";
import { composeAbortSignals } from "./abort-compose";

describe("composeAbortSignals", () => {
  test("no external signal: the composed signal IS the internal one", () => {
    const internal = new AbortController();
    const { signal } = composeAbortSignals(undefined, internal.signal);
    expect(signal).toBe(internal.signal);
    expect(signal.aborted).toBe(false);
    internal.abort("internal reason");
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe("internal reason");
  });

  test("an external abort aborts the composed signal", () => {
    const external = new AbortController();
    const internal = new AbortController();
    const { signal } = composeAbortSignals(external.signal, internal.signal);
    expect(signal.aborted).toBe(false);
    external.abort("external reason");
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe("external reason");
    // The internal controller itself is untouched — composition is one-way
    // into the derived signal, not a merge of the two inputs.
    expect(internal.signal.aborted).toBe(false);
  });

  test("an internal abort aborts the composed signal, independent of external", () => {
    const external = new AbortController();
    const internal = new AbortController();
    const { signal } = composeAbortSignals(external.signal, internal.signal);
    internal.abort("timed out");
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe("timed out");
    expect(external.signal.aborted).toBe(false);
  });

  test("already-aborted inputs compose immediately, external checked first", () => {
    const external = new AbortController();
    external.abort("already gone");
    const internal = new AbortController();
    const { signal } = composeAbortSignals(external.signal, internal.signal);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe("already gone");
  });

  test("dispose removes both listeners — a LATER abort on either input no longer reaches a NEW composition's signal", () => {
    // Regression guard for AC6's cross-call concern: a long-lived external
    // signal reused across several composed calls must not accumulate a
    // listener from every earlier one still capable of firing.
    const external = new AbortController();
    const internal1 = new AbortController();
    const first = composeAbortSignals(external.signal, internal1.signal);
    first.dispose();
    internal1.abort();
    // The first composed signal is still whatever it was when disposed —
    // dispose stops FUTURE propagation, it does not un-abort anything.
    expect(first.signal.aborted).toBe(false);

    const internal2 = new AbortController();
    const second = composeAbortSignals(external.signal, internal2.signal);
    external.abort("second round");
    expect(second.signal.aborted).toBe(true);
  });
});

// The unforgeable token that lets `store.ts` tell "a real `keryx learn
// accept`" apart from every other writer in this workstream (W3 AC4/AC11:
// only `keryx learn accept` may ever produce `status: accepted`).
//
// This module is deliberately the ONLY place that can construct a value
// `isAcceptCapability` accepts. `store.writePattern` refuses any write whose
// record has `status: "accepted"` unless the caller hands it a value from
// here — so the boundary that matters is not runtime unforgeability (a
// caller that imports this module can always call `createAcceptCapability()`
// itself) but IMPORT DISCIPLINE: `accept-capability.test.ts` asserts that
// nothing under `src/` imports this module except `store.ts`, `accept.ts`
// (T8 — may not exist yet) and test files. That is what makes "only
// `keryx learn accept` produces `accepted`" an enforced property rather than
// a convention: a new writer would have to import this file to bypass the
// refusal, and the source audit catches that import on sight.
const ACCEPT_CAPABILITY_BRAND: unique symbol = Symbol("learning-accept-capability");

export interface AcceptCapability {
  readonly [ACCEPT_CAPABILITY_BRAND]: true;
}

let issued: AcceptCapability | undefined;

/** Returns the one accept-capability token, creating it on first call. */
export function createAcceptCapability(): AcceptCapability {
  issued ??= { [ACCEPT_CAPABILITY_BRAND]: true };
  return issued;
}

/** True only for a value produced by `createAcceptCapability()` in this process. */
export function isAcceptCapability(value: unknown): value is AcceptCapability {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[ACCEPT_CAPABILITY_BRAND] === true
  );
}

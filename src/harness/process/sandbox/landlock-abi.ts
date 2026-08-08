// Landlock ABI version seam (flow 145) — requirements package
// `keryx-linux-containment`, specification §2 (`landlock-abi.ts`) and N4.
//
// This module holds the *interface* and the cache, and deliberately holds no
// mechanism. Reading the kernel's Landlock ABI means asking the kernel — today
// the intended route is `landlock_create_ruleset(NULL, 0,
// LANDLOCK_CREATE_RULESET_VERSION)` through `bun:ffi`, but whether `bun:ffi` can
// carry Landlock at all is the open question of the specification's step-2 spike
// (§4.2), and its stated fallback is a compiled helper. An interface that
// assumed either one would have to be rewritten when that spike concludes.
//
// So: the reader is injected. `detect.ts` — not this module — decides what a
// failure to read the ABI means for layer selection; a policy decision does not
// belong behind a cache.

/**
 * The kernel's Landlock ABI version. `0` means Landlock is not available, which
 * is also what a kernel without Landlock reports.
 */
export type LandlockAbiVersion = number;

/** The value that means "this kernel has no Landlock". */
export const LANDLOCK_ABI_UNAVAILABLE: LandlockAbiVersion = 0;

/**
 * Reads the kernel's Landlock ABI version.
 *
 * Impure by definition, and the only impure thing the Landlock layer needs
 * before it applies anything. Implementations may throw; see
 * {@link cacheLandlockAbi} for how a throw is treated.
 */
export type LandlockAbiReader = () => LandlockAbiVersion;

/**
 * Wrap a reader so the kernel is asked **at most once** per returned function
 * (N4: probing must not make startup feel slow).
 *
 * A throw is cached and re-thrown as-is rather than converted into
 * {@link LANDLOCK_ABI_UNAVAILABLE}. Two reasons: a mechanism failure and a
 * kernel without Landlock are different facts and `sandbox status` has to be
 * able to tell them apart, and swallowing the first into the second is the same
 * class of mistake — reporting an unverified conclusion — that this package
 * exists to remove.
 *
 * The cache is per call to this function, not module-global, so a test can hold
 * its own and no test can leak a value into another.
 */
export function cacheLandlockAbi(read: LandlockAbiReader): LandlockAbiReader {
  let state: { kind: "value"; value: LandlockAbiVersion } | { kind: "error"; error: unknown } | undefined;

  return () => {
    if (state === undefined) {
      try {
        state = { kind: "value", value: read() };
      } catch (error) {
        state = { kind: "error", error };
      }
    }
    if (state.kind === "error") {
      throw state.error;
    }
    return state.value;
  };
}

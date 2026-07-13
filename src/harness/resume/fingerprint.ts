// Durable-resume fingerprints (flow 011, W8 / RS-01, R0-02).
//
// A `Fingerprints` pair captures the two environment invariants a resume must
// re-observe before it may CONTINUE prior work in place: the `worktree` root and
// the `toolchain` identity recorded when the session was last written. When both
// still match, resume continues on the reconstructed leaf; when either drifted,
// the recorded work is stale and resume must start a NEW immutable attempt rather
// than silently reusing state gathered under a different environment.
//
// Pure + deterministic: a structural equality with no clock, RNG, network, or
// filesystem access. This module deliberately holds only the two invariants the
// @task-RS-01 scenarios pin (`worktree`, `toolchain`); richer fingerprints are a
// later concern and are intentionally out of scope here.

/**
 * The environment invariants compared across a resume. Both must be byte-equal
 * for a resume to continue the recorded work in place.
 */
export interface Fingerprints {
  /** Absolute worktree root the session was recorded against. */
  worktree: string;
  /** Toolchain identity (e.g. `bun-1.2.0`) the session was recorded against. */
  toolchain: string;
}

/**
 * True only when both the `worktree` and the `toolchain` of `a` and `b` are
 * equal. Any drift returns false, signalling the recorded work is stale and a
 * new attempt must be started.
 */
export function fingerprintsMatch(a: Fingerprints, b: Fingerprints): boolean {
  return a.worktree === b.worktree && a.toolchain === b.toolchain;
}

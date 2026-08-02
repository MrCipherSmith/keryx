// The permissiveness orderings the policy layer compares profiles with.
//
// One copy, here, because there were two. `child/isolation.ts` owned
// `TRUST_RANK`, `OUTCOME_RANK`, `ISOLATION_RANK` and `rankOf` — including the
// fail-closed-on-unknown rule — and `policy/profiles.ts` grew a second
// implementation of the same tables for the remote non-weakening check. Two
// rankings are two chances to disagree about what "more permissive" means, and
// the second copy also dropped a dimension the first had.
//
// The `rankOf` fail-closed rule is the reason these are functions rather than
// bare lookups: the inputs are typed, but a malformed profile that bypassed
// schema validation must not silently skip a comparison. `undefined > n` is
// `false`, which fails OPEN, so an unrecognised value returns `undefined` and
// every caller is written to treat that as a refusal.

import type { PolicyProfile, PolicyProfileDefaults, PolicyProfileRequiredControls } from "./types";

/**
 * Capability ordering of the three trust postures for CHILD INHERITANCE.
 *
 * Broader = higher. `untrusted` is the broadest because a child in that posture
 * is the one permitted to take in content nobody has vetted; a child may not be
 * broader than its parent.
 *
 * This ordering answers "may this child do what its parent does". It is NOT the
 * ordering for "may this remote profile run against the operator's ceiling" —
 * see `REMOTE_TRUST_RANK`, which answers a different question and is separate
 * for that reason rather than by accident.
 */
export const TRUST_RANK: Record<PolicyProfile["trustMode"], number> = {
  "read-only": 0,
  "trusted-local": 1,
  untrusted: 2,
};

/**
 * How much TRUST a posture extends, for the remote non-weakening check.
 *
 * Higher extends more. `untrusted` extends the least: it is the posture for
 * input nobody has vetted, and everything about it is tighter. `trusted-local`
 * extends the most: it is the posture for content the operator produced.
 *
 * The two orderings are inverses on the same field, and that is the finding
 * rather than a mistake in one of them. `trustMode` carries two meanings in this
 * codebase — "how much exposure does this agent have" (child inheritance) and
 * "how much trust does this posture extend" (non-weakening) — and a single
 * table cannot answer both. Reusing `TRUST_RANK` for the remote check would make
 * the shipped default refuse to start: `remote-restricted` resolves to
 * `unattended-untrusted`, whose defaults are strictly TIGHTER than the local
 * baseline's on every dimension, and whose isolation is stricter. Refusing it
 * would be a wrong answer produced by a right-looking reuse.
 *
 * Named, exported and justified rather than inlined, so the next reader finds
 * the distinction instead of re-deriving it — and so a guard can assert that
 * these two tables are the only two.
 */
export const REMOTE_TRUST_RANK: Record<PolicyProfile["trustMode"], number> = {
  untrusted: 0,
  "read-only": 1,
  "trusted-local": 2,
};

/** Permissiveness ordering of the three outcomes (`deny < ask < allow`). */
export const OUTCOME_RANK: Record<PolicyProfileDefaults[keyof PolicyProfileDefaults], number> = {
  deny: 0,
  ask: 1,
  allow: 2,
};

/**
 * Strength ordering of the isolation control (`not-required < required-fail-closed`).
 * A profile may only KEEP or STRENGTHEN isolation; downgrading
 * `required-fail-closed` -> `not-required` is a fail-open and is DENIED.
 */
export const ISOLATION_RANK: Record<PolicyProfileRequiredControls["isolation"], number> = {
  "not-required": 0,
  "required-fail-closed": 1,
};

/**
 * Resolve a rank, failing CLOSED on an out-of-enum value.
 *
 * `undefined` forces the caller to deny. Returning a number for an unknown value
 * — any number — would let a profile carrying a value this code cannot reason
 * about be compared as though it could.
 */
export function rankOf<K extends string>(map: Record<K, number>, value: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(map, value) ? (map as Record<string, number>)[value] : undefined;
}

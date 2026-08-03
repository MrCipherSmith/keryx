// What `trustMode` actually says, and the orderings that follow from it.
//
// One copy, here, because there were two — `child/isolation.ts` owned the rank
// tables and `policy/profiles.ts` grew a second implementation of the same
// question, and the copy silently dropped a dimension for a release.
//
// Then the consolidation itself was wrong, and a five-reviewer round said so
// three times independently. It kept TWO tables over `trustMode` and defended
// them in a comment as "inverses on the same field". They are not inverses:
//
//   TRUST_RANK          read-only 0 < trusted-local 1 < untrusted 2
//   its actual inverse  untrusted 0 < trusted-local 1 < read-only 2
//   the second table    untrusted 0 < read-only     1 < trusted-local 2
//
// Only `untrusted` moves. When you reverse an ordering and two of three values
// stay put, you are not looking at one axis measured two ways — you are looking
// at TWO axes compressed into one enum, with one value living on the axis the
// other two do not.
//
// Say what the field carries:
//
//   profile                    authority     input provenance
//   read-only-review           cannot act    vetted
//   monitored-trusted-local    can act       vetted
//   unattended-untrusted       can act       UNVETTED
//
// `read-only` and `trusted-local` differ in AUTHORITY. `trusted-local` and
// `untrusted` differ in the PROVENANCE of the input, at equal authority. There
// is no fourth cell — no `cannot act` over unvetted input — which is why three
// values fit one enum and the compression looked free.
//
// It was not free. Each of the two tables was a projection of the same pair
// onto a different component, so each was right about its own question and
// silent about the other; and a third consumer, `mutation/execute.ts`, gave up
// on ordering entirely and asked two independent yes/no questions — which is
// the correct decomposition, arrived at by accident because ordering three
// values would have produced nonsense for what it needed.
//
// So the projection is named here, once, and every consumer reads through it.
// Two fields, one monotone ordering each, both compared in the same direction,
// and nothing left to explain in a comment. The wire enum does not change and
// no fingerprint moves — those are computed from `<profileId>:<profileVersion>`
// string literals, not from the profile body — so nothing on disk or in
// recorded evidence shifts.

import type { PolicyProfile, PolicyProfileDefaults, PolicyProfileRequiredControls } from "./types";

/** May this posture act at all, or only read? */
export type PolicyAuthority = "read-only" | "acting";

/** Has the content this posture handles been vetted by the operator? */
export type PolicyInputTrust = "vetted" | "unvetted";

/**
 * The two axes `trustMode` compresses.
 *
 * Total and exhaustive over the enum. A value outside it yields `undefined` on
 * both axes and every caller treats that as a refusal — same fail-closed rule
 * as `rankOf`, applied one level up.
 */
export function axesOf(trustMode: string): { authority: PolicyAuthority; inputTrust: PolicyInputTrust } | undefined {
  switch (trustMode) {
    case "read-only":
      return { authority: "read-only", inputTrust: "vetted" };
    case "trusted-local":
      return { authority: "acting", inputTrust: "vetted" };
    case "untrusted":
      return { authority: "acting", inputTrust: "unvetted" };
    default:
      return undefined;
  }
}

/** How much a posture may DO. Higher acts more. */
export const AUTHORITY_RANK: Record<PolicyAuthority, number> = {
  "read-only": 0,
  acting: 1,
};

/**
 * How much a posture TRUSTS its input. Higher extends more trust.
 *
 * `unvetted` is the bottom: it is the posture for content nobody has checked,
 * and everything about it is tighter.
 */
export const INPUT_TRUST_RANK: Record<PolicyInputTrust, number> = {
  unvetted: 0,
  vetted: 1,
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
 * `undefined` forces the caller to deny. Returning a number for an unknown
 * value — any number — would let a profile carrying something this code cannot
 * reason about be compared as though it could.
 */
export function rankOf<K extends string>(map: Record<K, number>, value: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(map, value) ? (map as Record<string, number>)[value] : undefined;
}

/**
 * How an axis is NAMED when it reaches an operator in a refusal.
 *
 * Qualified by the field they project, because they are not schema fields —
 * `PolicyProfile` has `trustMode` and has neither of these. `compareProfiles`
 * puts whatever it is handed into `widened`, whose docstring promises the
 * contents are "schema vocabulary", and bare `authority` sent an operator
 * looking for a profile key that does not exist. `trustMode.authority` is both
 * true and more useful: it names the field to change.
 */
export const AUTHORITY_AXIS = "trustMode.authority";
export const INPUT_TRUST_AXIS = "trustMode.inputTrust";

// ---------------------------------------------------------------------------
// The two questions
// ---------------------------------------------------------------------------
//
// Both are built on `axesOf`, and they agree exactly on `authority`: neither a
// child nor a remote profile may ACT more than the thing it is measured against.
//
// They read `inputTrust` in OPPOSITE directions, and that is not a residue of
// the old mistake — it is the two questions being different, now visible as two
// named predicates instead of hidden inside two rank tables that looked like
// they disagreed about one thing:
//
//   child inheritance   "does this child take on MORE EXPOSURE than its parent?"
//                       A child handling less-vetted input than its parent is
//                       reaching further into untrusted territory than the
//                       parent was granted, so LOWER inputTrust is the escalation.
//
//   remote non-weakening
//                       "does this profile EXTEND MORE TRUST than the ceiling?"
//                       A remote profile treating its input as vetted when the
//                       operator's own ceiling treats it as unvetted is claiming
//                       a trust the operator does not extend, so HIGHER
//                       inputTrust is the escalation.
//
// Exposure taken on and trust extended are inverses of each other on that one
// axis. Two predicates, each stating its own direction and its own reason, is
// the honest shape; one table claiming to answer both was not.

/**
 * Which axes of `candidate` exceed `ceiling`. Empty means it does not.
 *
 * The REMOTE non-weakening question. Fails closed on either side being
 * unreadable — an unknown posture is one this code cannot reason about, and the
 * answer is then no.
 */
export function exceedingAxes(ceiling: PolicyProfile["trustMode"], candidate: PolicyProfile["trustMode"]): string[] {
  const low = axesOf(ceiling);
  const high = axesOf(candidate);
  if (low === undefined || high === undefined) {
    return [AUTHORITY_AXIS, INPUT_TRUST_AXIS];
  }
  const exceeded: string[] = [];
  if (AUTHORITY_RANK[high.authority] > AUTHORITY_RANK[low.authority]) {
    exceeded.push(AUTHORITY_AXIS);
  }
  if (INPUT_TRUST_RANK[high.inputTrust] > INPUT_TRUST_RANK[low.inputTrust]) {
    exceeded.push(INPUT_TRUST_AXIS);
  }
  return exceeded;
}

/**
 * Which axes of `child` broaden on `parent`. Empty means it does not.
 *
 * The CHILD INHERITANCE question. Behaviour-preserving against the single
 * `read-only < trusted-local < untrusted` ordering it replaces: all nine
 * ordered pairs of the enum give the same allow/deny answer, which
 * `isolation.test.ts` asserts exhaustively rather than by sampling.
 */
export function broadeningAxes(parent: PolicyProfile["trustMode"], child: PolicyProfile["trustMode"]): string[] {
  const above = axesOf(parent);
  const below = axesOf(child);
  if (above === undefined || below === undefined) {
    return [AUTHORITY_AXIS, INPUT_TRUST_AXIS];
  }
  const broadened: string[] = [];
  if (AUTHORITY_RANK[below.authority] > AUTHORITY_RANK[above.authority]) {
    broadened.push(AUTHORITY_AXIS);
  }
  // LOWER is the escalation here — see the note above.
  if (INPUT_TRUST_RANK[below.inputTrust] < INPUT_TRUST_RANK[above.inputTrust]) {
    broadened.push(INPUT_TRUST_AXIS);
  }
  return broadened;
}

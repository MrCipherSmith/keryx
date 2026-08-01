// The one place a named policy profile is resolved.
//
// Both profiles below existed as inline literals inside `src/commands/harness.ts`
// — one per command, built where it was needed. That was fine while the only
// consumers were two subcommands of one CLI. `keryx serve` is the third
// consumer, and it needs something the inline shape cannot give it: a profile it
// can COMPARE against, because security-policy.md §"Remote policy profile"
// requires that a remote profile never grant what the local one denies.
//
// Writing a third inline literal in `serve` would have made that comparison a
// comparison against nothing. It is also exactly the shape `config-dir.ts` was
// extracted to stop, one flow earlier: the third copy is the one that must not
// be written, because it is the one that eventually disagrees with the other two.
//
// This module is deliberately pure — no clock, no filesystem, no environment. A
// profile is data, and resolution is a lookup.

import { createHash } from "node:crypto";
import type { PolicyOutcome, PolicyProfile, PolicyProfileDefaults } from "./types";

/** Small stable fingerprint for a frozen profile — node built-in only. */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * The names a caller may ask for.
 *
 * A closed set, not an open string. `serve.json` carries an operator-supplied
 * `profile` field, and a resolver that accepted any string would either have to
 * invent a profile for an unknown name or fall back to one — and a fallback here
 * is a fallback to a posture nobody chose.
 */
export type LocalProfileName = "read-only-review" | "monitored-trusted-local" | "unattended-untrusted";

export const LOCAL_PROFILE_NAMES: readonly LocalProfileName[] = [
  "read-only-review",
  "monitored-trusted-local",
  "unattended-untrusted",
];

export function isLocalProfileName(value: string): value is LocalProfileName {
  return (LOCAL_PROFILE_NAMES as readonly string[]).includes(value);
}

/**
 * A read-only-review profile (`defaults.read = "allow"`), per
 * `policy-profile.schema.json`. Byte-identical to the literal it replaces in
 * `src/commands/harness.ts`; the fingerprint input is unchanged so no existing
 * evidence record's `policyFingerprint` moves.
 */
function readOnlyReview(): PolicyProfile {
  return {
    schemaVersion: 1,
    profileId: "read-only-review",
    profileVersion: "1.0.0",
    fingerprint: sha256Hex("read-only-review:1.0.0"),
    trustMode: "read-only",
    defaults: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" },
    requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
  };
}

/**
 * A `trusted-local` profile with `defaults.shell: "allow"` — the deterministic
 * "approved argv and environment allowlist" posture the frozen
 * SC_R04_SHELL_CONTAINMENT scenario describes. Only reached behind the `exec`
 * opt-in gate. Fingerprint input unchanged, for the reason above.
 */
function monitoredTrustedLocal(): PolicyProfile {
  return {
    schemaVersion: 1,
    profileId: "monitored-trusted-local",
    profileVersion: "1.0.0-shell-contained",
    fingerprint: sha256Hex("monitored-trusted-local:1.0.0-shell-contained"),
    trustMode: "trusted-local",
    defaults: { read: "allow", write: "ask", shell: "allow", network: "ask", delegate: "ask" },
    requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
  };
}

/**
 * The stricter-by-default posture specification.md §"Remote policy profile"
 * requires of a remote turn absent explicit configuration: OS sandbox
 * containment required, network off, every mutation `ask`.
 *
 * `network: "deny"` is the "off" of "network off or restricted". Restricted is a
 * sandbox posture rather than a policy default, and choosing the weaker of the
 * two permitted readings as the DEFAULT would be picking the more permissive
 * option for the case where nobody chose — which is the opposite of what
 * "stricter by default" means.
 */
function unattendedUntrusted(): PolicyProfile {
  return {
    schemaVersion: 1,
    profileId: "unattended-untrusted",
    profileVersion: "1.0.0",
    fingerprint: sha256Hex("unattended-untrusted:1.0.0"),
    trustMode: "untrusted",
    defaults: { read: "allow", write: "ask", shell: "ask", network: "deny", delegate: "ask" },
    requiredControls: { isolation: "required-fail-closed", redactionFailure: "deny", networkBrokerFailure: "deny" },
  };
}

/**
 * Parent shell policy for `spawn_subagent`. Network is `allow` because the
 * interactive shell already uses cloud LLM providers (deepseek/anthropic/…);
 * children that *inherit* the parent model must not fail MAE G2 solely for
 * tool-isolation.
 *
 * NOT in `LOCAL_PROFILE_NAMES`, deliberately. This is an internal posture for
 * one tool, and `network: "allow"` with `delegate: "allow"` is not something an
 * operator should be able to select for `keryx serve` by typing a name into
 * `serve.json`. The operator-selectable set stays the three above.
 *
 * The fingerprint input is `shell-parent-policy:v1` verbatim — it does not
 * follow the `<id>:<version>` shape the other profiles use, and changing it to
 * match would move a fingerprint that is already in recorded evidence.
 */
export function shellParentProfile(): PolicyProfile {
  return {
    schemaVersion: 1,
    profileId: "monitored-trusted-local",
    profileVersion: "1.0.0",
    fingerprint: sha256Hex("shell-parent-policy:v1"),
    trustMode: "trusted-local",
    defaults: { read: "allow", write: "ask", shell: "ask", network: "allow", delegate: "allow" },
    requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
  };
}

/**
 * Child "read-only tools" policy for shell spawns.
 *
 * MAE G2 denies network-class LLM providers when `trustMode` is `read-only` OR
 * network is not `allow`. That gate is about model/provider resolution, not tool
 * risk — shell subagents still need the parent's cloud model while being
 * forbidden write/shell/delegate TOOLS. Hence trusted-local + network allow,
 * with the three mutating classes denied.
 *
 * Also not operator-selectable, for the reason above. Fingerprint input
 * `shell-child-tools-readonly:v2`, preserved verbatim.
 */
export function shellChildReadOnlyProfile(): PolicyProfile {
  return {
    schemaVersion: 1,
    profileId: "monitored-trusted-local",
    profileVersion: "1.0.0-shell-child-tools-ro",
    fingerprint: sha256Hex("shell-child-tools-readonly:v2"),
    trustMode: "trusted-local",
    defaults: { read: "allow", write: "deny", shell: "deny", network: "allow", delegate: "deny" },
    requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
  };
}

/** Resolve a named profile. Pure; the same name always yields the same profile. */
export function resolveLocalProfile(name: LocalProfileName): PolicyProfile {
  switch (name) {
    case "read-only-review":
      return readOnlyReview();
    case "monitored-trusted-local":
      return monitoredTrustedLocal();
    case "unattended-untrusted":
      return unattendedUntrusted();
  }
}

// ---------------------------------------------------------------------------
// Non-weakening comparison (spec AC-04)
// ---------------------------------------------------------------------------

/**
 * How permissive an outcome is. Higher grants more.
 *
 * `undefined` for anything else, and every caller below treats `undefined` as a
 * failure rather than as a rank. A profile carrying a value this function does
 * not recognise is a profile this code cannot reason about, and the answer to
 * "may it run remotely" is then no.
 */
function rank(outcome: string): number | undefined {
  switch (outcome) {
    case "deny":
      return 0;
    case "ask":
      return 1;
    case "allow":
      return 2;
    default:
      return undefined;
  }
}

/** How strict an isolation requirement is. Higher is stricter. */
function isolationRank(value: string): number | undefined {
  switch (value) {
    case "not-required":
      return 0;
    case "required-fail-closed":
      return 1;
    default:
      return undefined;
  }
}

export interface ProfileComparison {
  /** True only when the remote profile grants nothing the local profile withholds. */
  ok: boolean;
  /**
   * The fields that widen, or that could not be compared. Field NAMES only —
   * they are schema vocabulary, not operator data, so they are safe to print in
   * a refusal. Sorted, so the message is stable.
   */
  widened: string[];
}

/**
 * Decide whether `remote` is no weaker than `local`.
 *
 * STRUCTURAL, over the resolved profiles' fields — never a comparison of
 * `profileId` or `profileVersion`. A name match is not a permission match: the
 * recorded `allowlist-not-a-boundary` lesson is exactly this shape, a check
 * against a raw string standing in for a check against the thing the string was
 * supposed to describe. Two profiles could share a name and differ in every
 * default, and the one that matters is the default.
 *
 * Every uncertainty is a failure:
 *
 *   - a key present in either profile's defaults is compared, so a key added to
 *     `PolicyProfileDefaults` later is compared without editing this function
 *     rather than silently ignored;
 *   - a key present in one and absent in the other cannot be shown to be no
 *     weaker, so it widens;
 *   - a value neither `allow`, `ask` nor `deny` has no rank, so it widens;
 *   - `requiredControls` compares by strictness, and the two `deny`-pinned
 *     controls are checked for being `deny` rather than assumed to be.
 */
export function compareProfiles(local: PolicyProfile, remote: PolicyProfile): ProfileComparison {
  const widened = new Set<string>();

  const localDefaults = local.defaults as unknown as Record<string, string | undefined>;
  const remoteDefaults = remote.defaults as unknown as Record<string, string | undefined>;
  // The UNION of both key sets, not a hardcoded list of five. A profile with an
  // extra key is compared on it; a profile missing one the other has widens.
  for (const key of new Set([...Object.keys(localDefaults), ...Object.keys(remoteDefaults)])) {
    const localRank = rank(localDefaults[key] ?? "");
    const remoteRank = rank(remoteDefaults[key] ?? "");
    if (localRank === undefined || remoteRank === undefined || remoteRank > localRank) {
      widened.add(`defaults.${key}`);
    }
  }

  const localIsolation = isolationRank(local.requiredControls?.isolation ?? "");
  const remoteIsolation = isolationRank(remote.requiredControls?.isolation ?? "");
  if (localIsolation === undefined || remoteIsolation === undefined || remoteIsolation < localIsolation) {
    widened.add("requiredControls.isolation");
  }
  // Pinned to `deny` by the frozen schema. Checked rather than trusted: this
  // function's whole job is to be the place that does not assume.
  if (remote.requiredControls?.redactionFailure !== "deny") {
    widened.add("requiredControls.redactionFailure");
  }
  if (remote.requiredControls?.networkBrokerFailure !== "deny") {
    widened.add("requiredControls.networkBrokerFailure");
  }

  return { ok: widened.size === 0, widened: [...widened].sort() };
}

/**
 * The defaults a remote profile is held to when nothing else constrains it.
 *
 * Exported so a test can assert the stricter-by-default requirement against a
 * value rather than against a re-reading of the profile literal.
 */
export const REMOTE_DEFAULT_PROFILE: LocalProfileName = "unattended-untrusted";

// ---------------------------------------------------------------------------
// Operator-facing profile names
// ---------------------------------------------------------------------------

/**
 * The names `serve.json`'s `profile` field may carry.
 *
 * Deliberately NOT the same vocabulary as `PolicyProfileId`. Those three ids are
 * frozen by `policy-profile.schema.json` and appear in evidence; these are what
 * an operator types. R4b shipped `remote-restricted` as the default before any
 * of them resolved to anything, and it is kept — renaming it would refuse every
 * configuration already on disk, which is a migration wearing the costume of a
 * validation fix.
 *
 * That the operator-facing name and the frozen id differ is also the clearest
 * possible statement of why `compareProfiles` may never compare names:
 * `remote-restricted` and `unattended-untrusted` are the same posture under two
 * spellings, and a name comparison would call them different.
 */
export type RemoteProfileName = "remote-restricted" | "remote-read-only";

export const REMOTE_PROFILE_NAMES: readonly RemoteProfileName[] = ["remote-restricted", "remote-read-only"];

/**
 * Resolve the profile a remote turn runs under, or `null` for a name that is not
 * in the closed set.
 *
 * `null` rather than a fallback. A configuration naming a profile this release
 * does not implement is a configuration whose author believed something about
 * their security posture that is not true, and running them under "the closest
 * one" is how that belief survives. The caller turns it into a startup refusal.
 */
export function resolveRemoteProfile(name: string): PolicyProfile | null {
  switch (name) {
    case "remote-restricted":
      // The stricter-by-default posture specification.md requires: containment
      // required, network off, every mutation `ask`.
      return resolveLocalProfile("unattended-untrusted");
    case "remote-read-only":
      return resolveLocalProfile("read-only-review");
    default:
      return null;
  }
}

/**
 * The posture the OPERATOR's own agent surface runs under, and therefore the
 * ceiling a remote profile may not exceed.
 *
 * Choosing this is a decision rather than a lookup, and it is recorded as D5 in
 * flow 131. keryx has several local postures: `harness run` is read-only-review,
 * `harness exec` is shell-allow, and the interactive shell — the one an operator
 * actually sits in front of — is `shellParentProfile`. The ceiling has to be the
 * most permissive thing the operator's own surface grants, because
 * "remote may never grant what local denies" is a statement about what local
 * grants, not about the strictest corner of it. Picking `read-only-review` would
 * make the check pass only for a remote profile that can do nothing, which is
 * not a security property but a refusal to implement the feature.
 */
export function localBaselineProfile(): PolicyProfile {
  return shellParentProfile();
}

export type { PolicyOutcome, PolicyProfileDefaults };

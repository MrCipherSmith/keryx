// The profile resolver and the non-weakening comparison (spec AC-04).
//
// Two things are pinned here. First, that extracting the two inline profiles
// moved no byte of behaviour — the fingerprints are the input to every evidence
// record's `policyFingerprint`, so a changed fingerprint would silently
// invalidate replay fixtures. Second, that the comparison is STRUCTURAL and
// fails closed on everything it cannot reason about, because it is the check
// standing between a remote caller and a profile that grants more than the
// operator's own.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import {
  compareProfiles,
  isLocalProfileName,
  LOCAL_PROFILE_NAMES,
  REMOTE_DEFAULT_PROFILE,
  resolveLocalProfile,
} from "./profiles";
import type { PolicyProfile } from "./types";

const SRC = path.join(import.meta.dir, "..", "..");

describe("resolveLocalProfile", () => {
  test("the extracted profiles are byte-identical to the literals they replace", () => {
    // The fingerprints in particular. They are derived from
    // `<profileId>:<profileVersion>` and land in every evidence record, so a
    // drift here invalidates replay fixtures without failing anything that
    // looks like it is about profiles.
    expect(resolveLocalProfile("read-only-review")).toEqual({
      schemaVersion: 1,
      profileId: "read-only-review",
      profileVersion: "1.0.0",
      // sha256("read-only-review:1.0.0"), verified against the value main
      // produced before the extraction.
      fingerprint: "68979dda4497df369aef5e676418d21ad91a714026d875df616ca516e0f57e75",
      trustMode: "read-only",
      defaults: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" },
      requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
    } satisfies PolicyProfile);
  });

  test("every declared name resolves, and the resolved id matches the name asked for", () => {
    for (const name of LOCAL_PROFILE_NAMES) {
      const profile = resolveLocalProfile(name);
      expect({ name, id: profile.profileId }).toEqual({ name, id: name });
    }
  });

  test("the name set is closed", () => {
    expect(isLocalProfileName("read-only-review")).toBe(true);
    expect(isLocalProfileName("wide-open")).toBe(false);
    // Not a prefix or substring match: `allowlist-not-a-boundary` again.
    expect(isLocalProfileName("read-only")).toBe(false);
    expect(isLocalProfileName("read-only-review-plus")).toBe(false);
  });

  test("the remote default is the stricter-by-default posture the specification requires", () => {
    // specification.md §"Remote policy profile": OS sandbox containment
    // required, network off or restricted, every mutation `ask`.
    const remote = resolveLocalProfile(REMOTE_DEFAULT_PROFILE);
    expect(remote.requiredControls.isolation).toBe("required-fail-closed");
    expect(remote.defaults.network).toBe("deny");
    for (const mutating of ["write", "shell", "delegate"] as const) {
      expect({ field: mutating, outcome: remote.defaults[mutating] }).toEqual({ field: mutating, outcome: "ask" });
    }
  });
});

describe("compareProfiles — a remote profile may never grant what the local one denies", () => {
  const local = resolveLocalProfile("monitored-trusted-local");

  test("a profile compared with itself is not weaker than itself", () => {
    expect(compareProfiles(local, local)).toEqual({ ok: true, widened: [] });
  });

  test("a strictly stricter remote profile passes", () => {
    expect(compareProfiles(local, resolveLocalProfile("read-only-review"))).toEqual({ ok: true, widened: [] });
  });

  test("each of the five defaults is compared, and each names itself when it widens", () => {
    // One at a time. A comparator that checked only the first field would pass a
    // per-field loop that asserted the whole object once.
    for (const field of ["read", "write", "shell", "network", "delegate"] as const) {
      const strict = resolveLocalProfile("read-only-review");
      const wider: PolicyProfile = { ...strict, defaults: { ...strict.defaults, [field]: "allow" } };
      const result = compareProfiles(strict, wider);
      expect({ field, ok: result.ok, widened: result.widened }).toEqual({
        field,
        ok: field === "read" ? true : false, // `read` is already `allow` locally
        widened: field === "read" ? [] : [`defaults.${field}`],
      });
    }
  });

  test("ask is weaker than deny and stronger than allow, in that order", () => {
    const strict = resolveLocalProfile("read-only-review"); // write: deny
    const asking: PolicyProfile = { ...strict, defaults: { ...strict.defaults, write: "ask" } };
    const allowing: PolicyProfile = { ...strict, defaults: { ...strict.defaults, write: "allow" } };
    expect(compareProfiles(strict, asking).ok).toBe(false);
    expect(compareProfiles(asking, strict).ok).toBe(true);
    expect(compareProfiles(allowing, asking).ok).toBe(true);
    expect(compareProfiles(asking, allowing).ok).toBe(false);
  });

  test("an unrecognised outcome has no rank and therefore widens", () => {
    // The fail-closed direction. A profile carrying a value this code cannot
    // reason about is a profile it must not clear.
    const strict = resolveLocalProfile("read-only-review");
    const nonsense = { ...strict, defaults: { ...strict.defaults, shell: "maybe" } } as unknown as PolicyProfile;
    expect(compareProfiles(strict, nonsense)).toEqual({ ok: false, widened: ["defaults.shell"] });
    // ...in BOTH positions. An unreadable local profile is not a licence either.
    expect(compareProfiles(nonsense, strict)).toEqual({ ok: false, widened: ["defaults.shell"] });
  });

  test("a key present in one profile and absent in the other widens", () => {
    const strict = resolveLocalProfile("read-only-review");
    const extra = {
      ...strict,
      defaults: { ...strict.defaults, credential: "allow" },
    } as unknown as PolicyProfile;
    // The union of keys is compared, so the extra key is seen at all.
    expect(compareProfiles(strict, extra)).toEqual({ ok: false, widened: ["defaults.credential"] });
    // And the mirror: a remote profile MISSING a key the local one constrains
    // cannot be shown to be no weaker on it.
    expect(compareProfiles(extra, strict)).toEqual({ ok: false, widened: ["defaults.credential"] });
  });

  test("a sixth default added to the type would be compared without editing the comparator", () => {
    // This is the class-shaped half. The comparator iterates the UNION of the
    // two profiles' keys rather than a hardcoded list of five, so a field added
    // to `PolicyProfileDefaults` later is compared rather than silently ignored.
    // Driven with a synthetic key on BOTH sides, which a hardcoded list would
    // pass while ignoring the widening.
    const strict = resolveLocalProfile("read-only-review");
    const withKey = (value: string): PolicyProfile =>
      ({ ...strict, defaults: { ...strict.defaults, futureField: value } }) as unknown as PolicyProfile;
    expect(compareProfiles(withKey("deny"), withKey("deny"))).toEqual({ ok: true, widened: [] });
    expect(compareProfiles(withKey("deny"), withKey("allow"))).toEqual({ ok: false, widened: ["defaults.futureField"] });
  });

  test("isolation compares by strictness: a remote profile may not drop a required launcher", () => {
    const contained = resolveLocalProfile("unattended-untrusted"); // required-fail-closed
    const uncontained: PolicyProfile = {
      ...contained,
      requiredControls: { ...contained.requiredControls, isolation: "not-required" },
    };
    expect(compareProfiles(contained, uncontained)).toEqual({
      ok: false,
      widened: ["requiredControls.isolation"],
    });
    // The other direction is fine: a remote turn may require containment the
    // local profile does not.
    expect(compareProfiles(uncontained, contained)).toEqual({ ok: true, widened: [] });
  });

  test("the deny-pinned controls are checked rather than assumed", () => {
    const strict = resolveLocalProfile("read-only-review");
    for (const control of ["redactionFailure", "networkBrokerFailure"] as const) {
      const loosened = {
        ...strict,
        requiredControls: { ...strict.requiredControls, [control]: "warn" },
      } as unknown as PolicyProfile;
      expect(compareProfiles(strict, loosened)).toEqual({
        ok: false,
        widened: [`requiredControls.${control}`],
      });
    }
  });

  test("the comparison never consults profileId or profileVersion", () => {
    // A name match is not a permission match — `allowlist-not-a-boundary`. Two
    // profiles wearing the same identity and differing in a default must NOT
    // compare equal, and two with different identities and identical fields must.
    const strict = resolveLocalProfile("read-only-review");
    const impostor = {
      ...strict,
      defaults: { ...strict.defaults, shell: "allow" },
    } as PolicyProfile;
    expect(compareProfiles(strict, impostor).ok).toBe(false); // same id, wider

    const renamed = { ...strict, profileId: "unattended-untrusted", profileVersion: "9.9.9" } as PolicyProfile;
    expect(compareProfiles(strict, renamed).ok).toBe(true); // different id, identical fields
  });
});

describe("no fourth copy of a profile literal", () => {
  // The reason this module exists. Two byte-identical literals lived in
  // `commands/harness.ts`, and `serve` was about to write a third — which would
  // have made the non-weakening comparison a comparison against a literal
  // nobody else used. Source-level, so a fourth cannot appear quietly.
  //
  // Same construction as `config-dir.writers.test.ts`: derive the denominator
  // from the tree, assert the complement is empty.
  //
  // Written first and run against an untouched tree, it reported TWO files. One
  // was `policy/types.ts`, a false positive the detector below no longer makes —
  // it now requires an object literal (`requiredControls: {`) rather than the
  // bare member name, which an interface declaration does not have. The other
  // was `tool/builtin/spawn-subagent-tool.ts`, which held two further profile
  // literals that the R4c launch prompt recorded as not existing: it named the
  // two in `commands/harness.ts` "the ONLY local profiles that exist". There
  // were four. Both moved into the resolver.
  const EXEMPT = new Set(["harness/policy/profiles.ts"]);

  /** A profile being CONSTRUCTED, not a type declaring the member. */
  const PROFILE_LITERAL = /requiredControls\s*:\s*\{/;

  /** Source with string literals and comments blanked, so neither can fake a hit. */
  function code(source: string): string {
    return source
      .replace(/`(?:\\.|[^`\\])*`/gs, "``")
      .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
      .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
  }

  test("only profiles.ts constructs a PolicyProfile literal", () => {
    const offenders: string[] = [];
    for (const relative of new Glob("**/*.ts").scanSync(SRC)) {
      const file = relative.split(path.sep).join("/");
      if (file.includes(".test.") || EXEMPT.has(file)) {
        continue;
      }
      const source = code(readFileSync(path.join(SRC, relative), "utf8"));
      // A profile being constructed carries BOTH an object-literal
      // `requiredControls` and a `trustMode` member. Matching `profileId` alone
      // would fire on every file that merely reads one, and matching
      // `requiredControls:` without the brace fires on the interface itself.
      if (PROFILE_LITERAL.test(source) && source.includes("trustMode:")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the detector fires on a planted literal and not on the type that declares it", () => {
    // Otherwise the assertion above passes because the predicate matches
    // nothing at all — the decorative shape this codebase has now shipped twice.
    const planted = code(`const p = {
      profileId: "read-only-review",
      trustMode: "read-only",
      defaults: { read: "allow" },
      requiredControls: { isolation: "not-required" },
    };`);
    expect(PROFILE_LITERAL.test(planted) && planted.includes("trustMode:")).toBe(true);

    // The half that was a false positive: a declaration, not a construction.
    const declaration = code(`interface PolicyProfile {
      trustMode: PolicyTrustMode;
      requiredControls: PolicyProfileRequiredControls;
    }`);
    expect(PROFILE_LITERAL.test(declaration)).toBe(false);

    // And it is not defeated by whitespace.
    expect(PROFILE_LITERAL.test("requiredControls:{isolation:x}")).toBe(true);
  });
});

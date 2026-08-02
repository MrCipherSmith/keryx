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
import path from "node:path";
// The SHARED stripper and tree walk, not a local copy. A third comment/string
// stripper is the mistake `config-dir.scan.ts` was extracted to stop, and the
// guard this file used to hold made it.
import { code, sourceFiles, treeSources } from "../../lib/config-dir.scan";
import {
  compareProfiles,
  isLocalProfileName,
  LOCAL_PROFILE_NAMES,
  REMOTE_DEFAULT_PROFILE,
  resolveLocalProfile,
  resolveRemoteProfile,
  shellParentProfile,
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

  test("trustMode is compared, and a remote profile may not extend more trust", () => {
    // F-004. `trustMode` was not compared at all: a probe with it widened and
    // everything else equal returned `{ok: true, widened: []}`, so a remote
    // profile could claim a more trusting posture than the operator's own
    // surface extends and start anyway.
    const strict = resolveLocalProfile("read-only-review");
    const moreTrusting = { ...strict, trustMode: "trusted-local" } as PolicyProfile;

    const comparison = compareProfiles(strict, moreTrusting);
    expect(comparison.ok).toBe(false);
    expect(comparison.widened).toEqual(["trustMode"]);
  });

  test("a LESS trusting remote posture is not a widening", () => {
    // The other direction, and the reason the remote check does not reuse
    // `TRUST_RANK`. `untrusted` extends the LEAST trust — it is the posture for
    // input nobody has vetted — so a remote profile in it is stricter, not
    // wider, and must pass. Ranking it as "broadest" here, which the
    // child-inheritance table does for its own different question, would refuse
    // the shipped default: `remote-restricted` resolves to
    // `unattended-untrusted`, whose defaults are tighter than the baseline's on
    // every dimension and whose isolation is stricter.
    const baseline = shellParentProfile();
    const remote = resolveRemoteProfile("remote-restricted");
    expect(remote).not.toBeNull();

    const comparison = compareProfiles(baseline, remote as PolicyProfile);
    expect({ ok: comparison.ok, widened: comparison.widened }).toEqual({ ok: true, widened: [] });
  });

  test("an unrecognised trustMode has no rank and therefore widens", () => {
    // Fail closed, exactly as the defaults do. A profile carrying a posture this
    // code cannot reason about is one the answer to "may it run remotely" is no
    // for.
    const strict = resolveLocalProfile("read-only-review");
    const nonsense = { ...strict, trustMode: "extremely-trusted" } as unknown as PolicyProfile;
    expect(compareProfiles(strict, nonsense).widened).toEqual(["trustMode"]);
  });
});

describe("no fourth copy of a profile literal, and no second ranking table", () => {
  // Rebuilt from the `config-dir.writers.test.ts` template, because the version
  // this replaces was decorative. It copied that guard's COMMENT about
  // decorative guards and not its construction: the tree walk was inline rather
  // than a seam, so the self-check re-evaluated the regex on a string literal
  // instead of driving the loop the tree assertion drives; nothing asserted the
  // scan had reached the tree; and the denominator was zero, so the assertion
  // would have passed against a predicate that matched nothing.
  //
  // It also carried its own copy of the comment/string stripper — a third one —
  // while `lib/config-dir.scan.ts` exports the shared implementation. Two
  // strippers that drift produce two guards that disagree about what the source
  // says, which is the reason that module exists.
  //
  // History worth keeping: written first and run against an untouched tree, the
  // original reported TWO files. One was `policy/types.ts`, a false positive the
  // detector no longer makes — it requires an object literal
  // (`requiredControls: {`) rather than the bare member name. The other was
  // `tool/builtin/spawn-subagent-tool.ts`, which held two further profile
  // literals the R4c launch prompt recorded as not existing. Both moved into the
  // resolver.
  const EXEMPT_LITERAL = new Set(["harness/policy/profiles.ts"]);
  /** The two tables `ranks.ts` owns are the two that may exist. */
  const EXEMPT_RANKS = new Set(["harness/policy/ranks.ts"]);

  /** A profile being CONSTRUCTED, not a type declaring the member. */
  const PROFILE_LITERAL = /requiredControls\s*:\s*\{/;
  /** A permissiveness ordering being DECLARED. */
  const RANK_TABLE = /\b(TRUST_RANK|OUTCOME_RANK|ISOLATION_RANK|REMOTE_TRUST_RANK)\s*(:|=)/;

  /**
   * Files that construct a `PolicyProfile` literal.
   *
   * PURE over a `{ path -> source }` map, so the self-check below can drive THIS
   * function rather than a re-implementation of it. That is the whole difference
   * between this guard and the one it replaces.
   */
  function literalOffenders(sources: ReadonlyMap<string, string>): string[] {
    const offenders: string[] = [];
    for (const [file, raw] of [...sources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (EXEMPT_LITERAL.has(file)) {
        continue;
      }
      const source = code(raw);
      // BOTH an object-literal `requiredControls` and a `trustMode` member.
      // `profileId` alone fires on every file that merely reads one, and
      // `requiredControls:` without the brace fires on the interface itself.
      if (PROFILE_LITERAL.test(source) && source.includes("trustMode:")) {
        offenders.push(file);
      }
    }
    return offenders;
  }

  /** Files that declare a permissiveness ranking table. Same construction. */
  function rankOffenders(sources: ReadonlyMap<string, string>): string[] {
    const offenders: string[] = [];
    for (const [file, raw] of [...sources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (EXEMPT_RANKS.has(file)) {
        continue;
      }
      if (RANK_TABLE.test(code(raw))) {
        offenders.push(file);
      }
    }
    return offenders;
  }

  test("only profiles.ts constructs a PolicyProfile literal", () => {
    expect(literalOffenders(treeSources(SRC))).toEqual([]);
  });

  test("only ranks.ts declares a permissiveness ordering", () => {
    // F-004. `compareProfiles` grew a second implementation of the ranking
    // `child/isolation.ts` already owned, and the copy dropped `trustMode` — so
    // a remote profile could claim a more trusting posture than the operator's
    // own surface extends and start anyway.
    expect(rankOffenders(treeSources(SRC))).toEqual([]);
  });

  test("the scan actually reaches the source tree", () => {
    // Without this both assertions above pass vacuously if the root moves.
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain("harness/policy/profiles.ts");
    expect(files).toContain("harness/policy/ranks.ts");
    expect(files).toContain("harness/child/isolation.ts");
  });

  test("the scan finds the files that genuinely carry each shape", () => {
    // The complement being empty means nothing if the numerator is empty too.
    // Driven through the seams with the exemptions removed, so what is measured
    // is the predicate rather than a re-reading of it.
    const tree = treeSources(SRC);
    const profileFiles = [...tree].filter(([, raw]) => {
      const source = code(raw);
      return PROFILE_LITERAL.test(source) && source.includes("trustMode:");
    });
    expect(profileFiles.map(([file]) => file)).toEqual(["harness/policy/profiles.ts"]);

    const rankFiles = [...tree].filter(([, raw]) => RANK_TABLE.test(code(raw)));
    expect(rankFiles.map(([file]) => file)).toEqual(["harness/policy/ranks.ts"]);
  });

  test("both detectors fire through the seam, and neither fires on a declaration", () => {
    // Through `literalOffenders`/`rankOffenders` themselves. The guard this
    // replaces re-evaluated its regex on a string inline, so replacing either
    // function body with `return []` would have left it green.
    const planted = new Map([
      [
        "probe/constructs-a-profile.ts",
        `const p = {
          profileId: "read-only-review",
          trustMode: "read-only",
          defaults: { read: "allow" },
          requiredControls: { isolation: "not-required" },
        };`,
      ],
    ]);
    expect(literalOffenders(planted)).toEqual(["probe/constructs-a-profile.ts"]);

    const plantedRanks = new Map([
      ["probe/second-ranking.ts", "const TRUST_RANK: Record<string, number> = { untrusted: 2 };"],
      ["probe/second-outcome.ts", "const OUTCOME_RANK = { deny: 0, ask: 1, allow: 2 };"],
    ]);
    expect(rankOffenders(plantedRanks).sort()).toEqual(["probe/second-outcome.ts", "probe/second-ranking.ts"]);

    // The other half: a declaration is not a construction, and a mention is not
    // a declaration. Without this, a detector that reported everything would
    // satisfy the assertions above.
    const clean = new Map([
      [
        "probe/declares-the-type.ts",
        `interface PolicyProfile {
          trustMode: PolicyTrustMode;
          requiredControls: PolicyProfileRequiredControls;
        }`,
      ],
      ["probe/imports-the-ranks.ts", "import { TRUST_RANK, rankOf } from '../policy/ranks';\nrankOf(TRUST_RANK, x);"],
      ["probe/mentions-in-a-comment.ts", "// OUTCOME_RANK = the ordering, named here and not declared"],
    ]);
    expect(literalOffenders(clean)).toEqual([]);
    expect(rankOffenders(clean)).toEqual([]);

    // And the literal detector is not defeated by whitespace.
    expect(PROFILE_LITERAL.test("requiredControls:{isolation:x}")).toBe(true);
  });
});

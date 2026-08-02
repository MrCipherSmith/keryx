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
import { constructsWith, declaresRanking, parse } from "../../lib/config-dir.ast";
import {
  compareProfiles,
  isLocalProfileName,
  LOCAL_PROFILE_NAMES,
  REMOTE_DEFAULT_PROFILE,
  resolveLocalProfile,
  resolveRemoteProfile,
  shellParentProfile,
} from "./profiles";
import { AUTHORITY_AXIS, INPUT_TRUST_AXIS } from "./ranks";
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

  test("both axes of trustMode are compared, and the refusal names which one", () => {
    // `trustMode` was not compared at all for a release: a probe with it widened
    // and everything else equal returned `{ok: true, widened: []}`. The first
    // fix compared it on a single total order, which named only "trustMode" and
    // got one pair wrong; the field carries two axes and the refusal says which.
    const strict = resolveLocalProfile("read-only-review"); // read-only + vetted

    // More AUTHORITY than the ceiling.
    expect(compareProfiles(strict, { ...strict, trustMode: "trusted-local" } as PolicyProfile)).toEqual({
      ok: false,
      widened: [AUTHORITY_AXIS],
    });

    // More TRUST EXTENDED to the input than the ceiling, at equal authority.
    const acting = resolveLocalProfile("unattended-untrusted"); // acting + unvetted
    expect(compareProfiles(acting, { ...acting, trustMode: "trusted-local" } as PolicyProfile).widened).toEqual([
      INPUT_TRUST_AXIS,
    ]);
  });

  test("a read-only ceiling refuses an untrusted remote — the pair the single order got wrong", () => {
    // The fail-open the review found in the first fix. By the code that
    // ENFORCES `trustMode` — `mutation/execute.ts` blocks every mutation under
    // `read-only`, and blocks `untrusted` only without isolation — `read-only`
    // is strictly the tightest posture. The single total order ranked it ABOVE
    // `untrusted`, so a `read-only` ceiling ACCEPTED an `untrusted` remote: a
    // profile that may mutate under isolation clearing a ceiling that may never
    // mutate at all. Splitting the field refuses it on `authority`.
    const ceiling = resolveLocalProfile("read-only-review");
    const remote = resolveLocalProfile("unattended-untrusted");

    expect(compareProfiles(ceiling, remote).widened).toContain(AUTHORITY_AXIS);
    expect(compareProfiles(ceiling, remote).ok).toBe(false);
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
    // BOTH axes, because a posture that cannot be projected is one this code
    // can say nothing about on either.
    expect(compareProfiles(strict, nonsense).widened).toEqual([AUTHORITY_AXIS, INPUT_TRUST_AXIS]);
    // ...in both positions. An unreadable ceiling is not a licence either.
    expect(compareProfiles(nonsense, strict).widened).toEqual([AUTHORITY_AXIS, INPUT_TRUST_AXIS]);
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
  /**
   * Files allowed to declare a ranking of the policy vocabulary.
   *
   * `ranks.ts` owns every ordering over a `PolicyProfile`. `security/resolve.ts`
   * is excused for one word: its `ACTION_PRECEDENCE` ranks `SecurityAction`, a
   * different closed vocabulary for a different question, and it happens to
   * share the token `allow`. Excusing the file rather than dropping `allow` from
   * the detector, because `allow` is a real member of `OUTCOME_RANK` and
   * removing it would blind the guard to the table it most needs to see.
   */
  const EXEMPT_RANKS = new Set(["harness/policy/ranks.ts", "security/resolve.ts"]);

  /** A profile being CONSTRUCTED, not a type declaring the member. */
  /** A permissiveness ordering being DECLARED. */
  // A permissiveness ordering being DECLARED, and a profile being CONSTRUCTED —
  // both by asking the PARSER, after three rounds of losing to spellings.
  //
  // The rank detector was three regexes. It could not see quoted keys at all
  // (the shared `code()` blanks string literals, and four of the ELEVEN policy
  // words cannot be bare identifiers. That count has now been wrong twice: first
  // "three" while listing four, then "four of the five" — the numerator was
  // corrected and the denominator was not, which is the same operation that
  // produced an impossible byte figure two files away. The claim that a verbatim
  // copy of `ranks.ts` was invisible was also wrong, for the two tables whose
  // keys are all bare identifiers); after that was fixed with a local
  // comment-stripper and two more patterns, a reviewer defeated the result with
  // computed keys, a `Map`, an if-chain and a ternary chain — planting a real
  // `ranks-duplicate.ts` in a sandbox and watching sixty tests stay green.
  //
  // The profile detector was widened last round specifically to catch controls
  // "built separately and referenced by name", and the widened version still
  // missed `requiredControls: buildControls()` — a CALL, which is the most
  // natural way to build something separately.
  //
  // `declaresRanking` and `constructsWith` ask about node kinds instead.
  // `{ untrusted: 2 }`, `{ "untrusted": 2 }` and `{ ["untrusted"]: 2 }` are
  // three strings and one PropertyAssignment. An interface member is not an
  // ObjectLiteralExpression, so the declaration this used to exclude by
  // inspecting punctuation is excluded by being a different kind of thing.
  // See `lib/config-dir.ast.ts` for the stated limits — no module resolution,
  // no type checking.
  const POLICY_WORDS = [
    "read-only",
    "trusted-local",
    "untrusted",
    "deny",
    "ask",
    "allow",
    "not-required",
    "required-fail-closed",
    "vetted",
    "unvetted",
    "acting",
  ] as const;

  const RANK_TABLE = {
    test: (file: string, source: string): boolean =>
      declaresRanking(parse(file, source), POLICY_WORDS),
  };


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
      // BOTH members, because `trustMode` alone fires on every file that
      // merely reads one and `requiredControls` alone fires on the interface —
      // except that "fires on the interface" is no longer something that can
      // happen: an interface member is not an object literal.
      if (constructsWith(parse(file, raw), ["trustMode", "requiredControls"])) {
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
      if (RANK_TABLE.test(file, raw)) {
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
    const profileFiles = [...tree].filter(([file, raw]) => {
      return constructsWith(parse(file, raw), ["trustMode", "requiredControls"]);
    });
    expect(profileFiles.map(([file]) => file)).toEqual(["harness/policy/profiles.ts"]);

    const rankFiles = [...tree].filter(([file, raw]) => RANK_TABLE.test(file, raw));
    // ONE, and the change from two is a false positive going away rather than
    // coverage being lost.
    //
    // The regex version also reported `security/resolve.ts`, and the exemption
    // list carried it as "a ranking over a different vocabulary". It is:
    // `ACTION_PRECEDENCE` orders `SecurityAction` — block, require-approval,
    // redact, warn, allow — which shares exactly ONE word with the policy
    // vocabulary. The regex fired on that single word; requiring two or more
    // does not, because one word is not an ordering over this vocabulary.
    //
    // Checked rather than assumed: the file is still read (it is in `tree`), and
    // the assertion below re-derives the reason instead of trusting this comment.
    expect(rankFiles.map(([file]) => file)).toEqual(["harness/policy/ranks.ts"]);

    const resolve = tree.get("security/resolve.ts");
    expect(resolve).toBeDefined();
    // It does declare an ordering — over a vocabulary that is not this one.
    expect(declaresRanking(parse("security/resolve.ts", resolve ?? ""), ["block", "warn", "redact"])).toBe(true);
    expect(RANK_TABLE.test("security/resolve.ts", resolve ?? "")).toBe(false);
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

    // Both shapes the duplicate has actually taken in this repository. The
    // switch form is the one the guard this replaces could not see: a reviewer
    // pasted the real pre-fix duplicate back in verbatim and the guard stayed
    // green, because it matched four identifiers and the duplicate used none of
    // them.
    const plantedRanks = new Map([
      ["probe/literal-under-a-new-name.ts", "const POSTURE_ORDER = { untrusted: 2, 'trusted-local': 1 };"],
      ["probe/second-outcome.ts", "const WHATEVER = { deny: 0, ask: 1, allow: 2 };"],
      // The three that defeated the previous version.
      [
        "probe/quoted-keys.ts",
        'const POSTURE_RANK = { "read-only": 0, "trusted-local": 1, "untrusted": 2 };',
      ],
      ["probe/multi-digit.ts", "const R = { untrusted: 10, allow: 20 };"],
      [
        "probe/ordered-array.ts",
        'const TRUST_ORDER = ["read-only", "trusted-local", "untrusted"];\nTRUST_ORDER.indexOf(v);',
      ],
      [
        "probe/the-real-pre-fix-duplicate.ts",
        `function rank(outcome: string): number | undefined {
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
        }`,
      ],
    ]);
    expect(rankOffenders(plantedRanks).sort()).toEqual([
      "probe/literal-under-a-new-name.ts",
      "probe/multi-digit.ts",
      "probe/ordered-array.ts",
      "probe/quoted-keys.ts",
      "probe/second-outcome.ts",
      "probe/the-real-pre-fix-duplicate.ts",
    ]);

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

    // The spellings that defeated the regex, driven through the guard itself
    // rather than by re-testing a pattern against an inline string — which is
    // the construction the comment at the top of this describe condemns, and
    // which the previous version of this very assertion used.
    const defeated = new Map([
      ["probe/call.ts", 'const p = { trustMode: "x", requiredControls: buildControls() };'],
      ["probe/quoted.ts", 'const p = { "trustMode": "x", "requiredControls": c };'],
      ["probe/spaced.ts", 'const p = { trustMode : "x", requiredControls : c };'],
      ["probe/computed.ts", 'const p = { ["trustMode"]: "x", ["requiredControls"]: c };'],
    ]);
    expect(literalOffenders(defeated).sort()).toEqual([
      "probe/call.ts",
      "probe/computed.ts",
      "probe/quoted.ts",
      "probe/spaced.ts",
    ]);

    const rankDefeated = new Map([
      ["probe/computed-keys.ts", 'const R = { ["read-only"]: 0, ["untrusted"]: 2 };'],
      ["probe/map.ts", 'const R = new Map([["deny", 0], ["ask", 1], ["allow", 2]]);'],
      [
        "probe/if-chain.ts",
        'function r(v){ if (v === "read-only") return 0; if (v === "untrusted") return 2; return 1; }',
      ],
      ["probe/ternary.ts", 'const r = (v) => (v === "deny" ? 0 : v === "ask" ? 1 : 2);'],
    ]);
    expect(rankOffenders(rankDefeated).sort()).toEqual([
      "probe/computed-keys.ts",
      "probe/if-chain.ts",
      "probe/map.ts",
      "probe/ternary.ts",
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  LANDLOCK_FS_ACCESS_BIT,
  LANDLOCK_FS_ACCESS_MIN_ABI,
  LANDLOCK_UNHANDLED_ACTIONS,
  LANDLOCK_UNRESTRICTABLE_ACTIONS,
  buildLandlockRuleset,
  landlockFsMask,
} from "./landlock";
import type {
  LandlockInexpressible,
  LandlockInexpressibleCode,
  LandlockRuleset,
} from "./landlock";
import { defaultSandboxProfile } from "./profile";
import type { SandboxProfile } from "./profile";

/** ABI 4 is what the ADR-0010 reference host (Ubuntu 24.04, 6.8) reports. */
const ABI_CURRENT = 4;

/** An expressible profile: workspace-write, network on, nothing read-denied. */
const expressible: SandboxProfile = {
  mode: "workspace-write",
  network: "on",
  writableRoots: ["/work/repo", "/tmp/session"],
  readDenyList: [],
  allowedDomains: [],
  required: true,
};

/** Every profile shape that can yield a ruleset — the AC3 guards run over all. */
const expressibleShapes: readonly SandboxProfile[] = [
  expressible,
  { ...expressible, writableRoots: [] },
  { ...expressible, writableRoots: ["/work/repo", "/work/repo"] },
  { ...expressible, mode: "read-only", writableRoots: [] },
  { ...expressible, mode: "read-only", writableRoots: ["/work/repo"] },
  { ...expressible, required: false },
  { ...expressible, proxy: { host: "127.0.0.1", port: 8080 } },
];

/** The failure codes of a translation, or `null` when it succeeded. */
function codes(profile: SandboxProfile, abi = ABI_CURRENT): LandlockInexpressibleCode[] | null {
  const result = buildLandlockRuleset(profile, abi);
  return result.ok ? null : result.failures.map((f) => f.code);
}

/** The failures of a translation; fails the test if it produced a ruleset. */
function failuresOf(profile: SandboxProfile, abi = ABI_CURRENT): readonly LandlockInexpressible[] {
  const result = buildLandlockRuleset(profile, abi);
  if (result.ok) {
    throw new Error("expected an inexpressible profile, but a ruleset was returned");
  }
  return result.failures;
}

/** The ruleset of a translation; fails the test if it was inexpressible. */
function rulesetOf(profile: SandboxProfile, abi = ABI_CURRENT): LandlockRuleset {
  const result = buildLandlockRuleset(profile, abi);
  if (!result.ok) {
    throw new Error(
      `expected an expressible profile, got: ${result.failures.map((f) => f.code).join(", ")}`,
    );
  }
  return result.ruleset;
}

/** Rules that grant a writable hierarchy, i.e. everything but the device carve-out. */
function rootRules(ruleset: LandlockRuleset) {
  return ruleset.pathRules.filter((r) => r.onMissing === "fail");
}

// ---------------------------------------------------------------------------
// AC1 — deterministic, offline, no syscall
// ---------------------------------------------------------------------------

describe("AC1: buildLandlockRuleset is a pure translation", () => {
  test("the module loads nothing impure and reaches for no impure global", async () => {
    // AC1's "no syscall, no FFI, no spawn, no filesystem read, no
    // process.platform branch" is unobservable from outputs: a filesystem read
    // is perfectly deterministic within a run. So the criterion is enforced
    // structurally, and the guard has to match the SHAPE of the offence rather
    // than a list of the names it has worn. An earlier version matched only
    // `from "…"` with double quotes, and `import { readFileSync } from 'fs'`
    // walked straight through it.
    const source = await readFile(fileURLToPath(new URL("./landlock.ts", import.meta.url)), "utf8");

    // The module discusses `bun:ffi` and `process.platform` in prose, so
    // comments go first — including trailing ones, without eating `https://`.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:'"`])\/\/.*$/gm, "$1");

    // Every module-specifier form, both quote styles: `from`, dynamic `import()`,
    // `require()`, and a bare side-effect `import "x"`.
    const specifiers = [
      ...code.matchAll(/\bfrom\s*(['"])([^'"]+)\1/g),
      ...code.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1/g),
      ...code.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1/g),
      ...code.matchAll(/^\s*import\s+(['"])([^'"]+)\1/gm),
    ].map((m) => m[2]);
    expect([...new Set(specifiers)].sort()).toEqual(["./profile", "node:path"]);

    // An allowlist cannot see a global, so the impure globals are named. String
    // literals are blanked first: the module's operator-facing `detail` prose
    // must not be able to turn this guard red, or its next maintainer weakens it.
    const withoutStrings = code
      .replace(/(['"])(?:\\.|(?!\1)[^\\])*\1/g, '""')
      .replace(/`(?:\\.|[^\\`])*`/g, "``");
    for (const forbidden of [
      "process.",
      "Bun.",
      "globalThis",
      "eval(",
      "new Function",
      "fetch(",
      "Date.now",
      "Math.random",
      "performance.",
    ]) {
      expect(withoutStrings).not.toContain(forbidden);
    }
  });

  test("identical inputs produce deeply equal output", () => {
    expect(buildLandlockRuleset(expressible, ABI_CURRENT)).toEqual(
      buildLandlockRuleset(expressible, ABI_CURRENT),
    );
  });

  test("the same profile is translated identically on repeated calls, including failures", () => {
    const offline = { ...expressible, network: "off" as const };
    expect(buildLandlockRuleset(offline, ABI_CURRENT)).toEqual(
      buildLandlockRuleset(offline, ABI_CURRENT),
    );
  });

  test("the ABI is an argument, never read from the host", () => {
    // Two different ABIs, same profile, different verdicts — proving the kernel
    // value comes from the caller and the tests need no Landlock to run.
    expect(buildLandlockRuleset(expressible, 4).ok).toBe(true);
    expect(buildLandlockRuleset(expressible, 1).ok).toBe(false);
  });

  test("it does not mutate the profile it was given", () => {
    const profile: SandboxProfile = { ...expressible, writableRoots: ["/work/repo", "/work/repo"] };
    const snapshot = structuredClone(profile);
    buildLandlockRuleset(profile, ABI_CURRENT);
    expect(profile).toEqual(snapshot);
  });

  test("fields the translation must ignore do not change its output", () => {
    // `required` is a fail-closed directive for the adapter and `proxy` belongs
    // to the restricted-network path; neither has a Landlock representation.
    const base = rulesetOf(expressible);
    expect(rulesetOf({ ...expressible, required: false })).toEqual(base);
    expect(rulesetOf({ ...expressible, proxy: { host: "127.0.0.1", port: 8080 } })).toEqual(base);
  });

  test("workspace roots become path-beneath rules, deduplicated, in profile order", () => {
    const ruleset = rulesetOf({ ...expressible, writableRoots: ["/work/repo", "/tmp/s", "/work/repo"] });
    expect(rootRules(ruleset).map((r) => r.path)).toEqual(["/work/repo", "/tmp/s"]);
  });

  test("a trailing slash is normalised away, so the rule path is the path enforced", () => {
    const ruleset = rulesetOf({ ...expressible, writableRoots: ["/work/repo/", "/work/repo"] });
    expect(rootRules(ruleset).map((r) => r.path)).toEqual(["/work/repo"]);
  });

  test("read-only handles the same write rights but grants no hierarchy", () => {
    const ruleset = rulesetOf({ ...expressible, mode: "read-only", writableRoots: [] });
    expect(rootRules(ruleset)).toEqual([]);
    expect(ruleset.handledFs).toContain("write_file");
  });

  test("a read-only profile carrying writable roots does not grant them", () => {
    // `writableRoots` is documented as empty for read-only. Honouring it would
    // silently widen a read-only claim into workspace-write.
    const ruleset = rulesetOf({ ...expressible, mode: "read-only", writableRoots: ["/work/repo"] });
    expect(rootRules(ruleset)).toEqual([]);
  });

  test("workspace-write with no roots yields a boundary as strict as read-only", () => {
    expect(rulesetOf({ ...expressible, writableRoots: [] })).toEqual(
      rulesetOf({ ...expressible, mode: "read-only", writableRoots: [] }),
    );
  });

  test("no read-ish right is handled, which is how the broad read default is expressed", () => {
    const ruleset = rulesetOf(expressible);
    expect(ruleset.handledFs).not.toContain("read_file");
    expect(ruleset.handledFs).not.toContain("read_dir");
    expect(ruleset.handledFs).not.toContain("execute");
  });

  test("truncate and refer are handled, so the write boundary has no truncate hole", () => {
    const ruleset = rulesetOf(expressible);
    expect(ruleset.handledFs).toContain("truncate");
    expect(ruleset.handledFs).toContain("refer");
  });

  test("handledFs is never empty — an empty mask is rejected by landlock_create_ruleset", () => {
    for (const profile of expressibleShapes) {
      expect(rulesetOf(profile).handledFs.length).toBeGreaterThan(0);
    }
  });

  test("nothing a ruleset exposes is mutable, so a consumer cannot widen a boundary", () => {
    // `readonly` is erased at run time and the barrel publishes to JS callers
    // with no type checker. Enumerated over every shape rather than named
    // member by member: a per-site freeze that leaves a sibling mutable is how
    // these reviews reach round seven.
    for (const profile of expressibleShapes) {
      const ruleset = rulesetOf(profile);
      for (const value of [ruleset, ruleset.handledFs, ruleset.pathRules, ruleset.handledNet, ruleset.netRules]) {
        expect(Object.isFrozen(value)).toBe(true);
      }
      for (const rule of ruleset.pathRules) {
        expect(Object.isFrozen(rule)).toBe(true);
        expect(Object.isFrozen(rule.allow)).toBe(true);
      }
    }
    expect(Object.isFrozen(LANDLOCK_FS_ACCESS_BIT)).toBe(true);
    expect(Object.isFrozen(LANDLOCK_FS_ACCESS_MIN_ABI)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The device carve-out — the compatibility floor both sibling launchers carry
// ---------------------------------------------------------------------------

describe("stdio devices stay writable, as in seatbelt.ts and bwrap.ts", () => {
  test.each(["/dev/null", "/dev/zero", "/dev/tty"])("%s is writable in every mode", (device) => {
    for (const profile of expressibleShapes) {
      const rule = rulesetOf(profile).pathRules.find((r) => r.path === device);
      expect(rule?.allow).toEqual(["write_file", "truncate"]);
    }
  });

  test("a missing device is skipped, a missing writable root is fatal", () => {
    // Dropping a device rule can only over-restrict; dropping a workspace root
    // silently leaves the command with nowhere to write, so it must fail closed.
    const ruleset = rulesetOf(expressible);
    for (const rule of ruleset.pathRules) {
      expect(rule.onMissing).toBe(rule.path.startsWith("/dev/") ? "skip" : "fail");
    }
  });

  test("the carve-out never grants ioctl_dev or a read-ish right", () => {
    for (const rule of rulesetOf(expressible).pathRules) {
      expect(rule.allow).not.toContain("ioctl_dev");
      expect(rule.allow).not.toContain("read_file");
    }
  });

  test("/dev/stdout is deliberately absent — it is a symlink into /proc/self/fd", () => {
    // A rule there would resolve to whatever the descriptor points at and grant
    // write access to it. Inherited stdio needs no rule: Landlock gates `open`.
    const paths = rulesetOf(expressible).pathRules.map((r) => r.path);
    expect(paths).not.toContain("/dev/stdout");
    expect(paths).not.toContain("/dev/stderr");
    expect(paths).not.toContain("/dev/stdin");
  });
});

// ---------------------------------------------------------------------------
// AC2 — inexpressible profiles fail explicitly, never partially
// ---------------------------------------------------------------------------

describe("AC2: an inexpressible profile fails, and never yields a ruleset", () => {
  test('network "off" is refused — Landlock covers TCP only', () => {
    expect(codes({ ...expressible, network: "off" })).toEqual(["network-off-requires-seccomp"]);
  });

  test('network "restricted" is refused — no domain allowlist in Landlock', () => {
    expect(codes({ ...expressible, network: "restricted", allowedDomains: ["example.com"] })).toEqual([
      "network-restricted-requires-proxy-layer",
    ]);
  });

  test("an allowlist on an otherwise-open profile is still treated as restricted", () => {
    expect(codes({ ...expressible, network: "on", allowedDomains: ["example.com"] })).toEqual([
      "network-restricted-requires-proxy-layer",
    ]);
  });

  test("network-off with a stale allowlist is diagnosed as network-off, the stricter posture", () => {
    // Both codes refuse, but they route to different deferred layers: seccomp
    // plus bubblewrap versus the container. The stricter fact must win.
    expect(codes({ ...expressible, network: "off", allowedDomains: ["example.com"] })).toEqual([
      "network-off-requires-seccomp",
    ]);
  });

  test("a non-empty read-deny list is refused — Landlock has no deny rules", () => {
    expect(codes({ ...expressible, readDenyList: ["/home/u/.ssh"] })).toEqual([
      "read-deny-list-requires-mount-view",
    ]);
  });

  test("danger-full-access is refused as a single terminal reason", () => {
    const profile: SandboxProfile = {
      mode: "danger-full-access",
      network: "on",
      writableRoots: [],
      readDenyList: [],
      allowedDomains: [],
      required: false,
    };
    expect(codes(profile, 0)).toEqual(["danger-full-access-is-not-contained"]);
  });

  test("a relative writable root is refused", () => {
    expect(codes({ ...expressible, writableRoots: ["work/repo"] })).toEqual(["path-not-absolute"]);
  });

  test("an empty writable root is refused", () => {
    expect(codes({ ...expressible, writableRoots: [""] })).toEqual(["path-not-absolute"]);
  });

  test("a writable root containing a NUL byte is refused", () => {
    expect(codes({ ...expressible, writableRoots: ["/work/re\0po"] })).toEqual(["path-contains-nul"]);
  });

  test.each(["/work/repo/../..", "/work/./repo", "/..", "/work//repo", "//", "/work/repo//"])(
    "the non-canonical root %s is refused rather than resolved",
    (root) => {
      // Resolving it would grant a hierarchy other than the one reported, and
      // collapsing it silently would report a path the caller never supplied.
      expect(codes({ ...expressible, writableRoots: [root] })).toEqual(["path-not-canonical"]);
    },
  );

  test.each(["/", "/work/..foo", "/work/.hidden", "/work/a..b"])(
    "the legitimate root %s is accepted",
    (root) => {
      // `path-not-canonical` matches whole segments, so a name that merely
      // starts with dots is not a `.` or `..` segment.
      expect(rootRules(rulesetOf({ ...expressible, writableRoots: [root] })).map((r) => r.path)).toEqual([root]);
    },
  );

  test("a failure quotes the root the caller supplied, not a normalised rewrite", () => {
    // Normalisation runs after validation for exactly this reason: an operator
    // reading `writable root ""` cannot map it back to what they configured.
    const [failure] = failuresOf({ ...expressible, writableRoots: ["work/repo/"] });
    expect(failure?.detail).toContain('"work/repo/"');
  });

  test("a duplicated invalid root is reported once", () => {
    expect(codes({ ...expressible, writableRoots: ["rel", "rel"] })).toEqual(["path-not-absolute"]);
  });

  test("ABI 0 is refused as Landlock being unavailable", () => {
    expect(codes(expressible, 0)).toEqual(["landlock-unavailable"]);
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "the malformed ABI %p is a reader failure, not a claim about the kernel",
    (abi) => {
      const [failure] = failuresOf(expressible, abi);
      expect(failure?.code).toBe("abi-unreadable");
      expect(failure?.detail).toContain("says nothing about the kernel");
      // The message must name the value the reader returned. `JSON.stringify`
      // renders NaN and Infinity as `null`, which named a value nobody returned
      // — in the one message whose purpose is to be true about the reader.
      expect(failure?.detail).toContain(String(abi));
    },
  );

  test.each([1, 2])("ABI %i cannot carry the write boundary and is refused", (abi) => {
    expect(codes(expressible, abi)).toEqual(["abi-too-low"]);
  });

  test("ABI 3 is the floor at which the write boundary becomes expressible", () => {
    expect(buildLandlockRuleset(expressible, 3).ok).toBe(true);
    expect(rulesetOf(expressible, 3).minimumAbi).toBe(3);
  });

  test("the ABI failure names the kernel ABI and the missing rights, not the platform", () => {
    const [failure] = failuresOf(expressible, 1);
    expect(failure?.detail).toContain("ABI 1");
    expect(failure?.detail).toContain("truncate");
    expect(failure?.detail.toLowerCase()).not.toContain("linux");
  });

  test("the ABI failure does not claim refer is left unrestricted — the kernel denies it", () => {
    // With `refer` absent or unhandled, cross-directory rename and link are
    // denied everywhere. Reporting them as unrestricted would be a keryx claim
    // about the kernel that contradicts the kernel, on the exact host class
    // (Ubuntu 22.04, ABI 1) the PRD singles out.
    const [failure] = failuresOf(expressible, 1);
    expect(failure?.detail).toContain("without refer, cross-directory rename and link");
    expect(failure?.detail).toContain("stricter than the profile asks for");
    expect(failure?.detail).toContain("without truncate");
  });

  test("each missing right is named once, beside what its absence actually does", () => {
    // At ABI 2 only `truncate` is missing, so `refer` must not be mentioned and
    // nothing may be listed twice.
    const [failure] = failuresOf(expressible, 2);
    expect(failure?.detail).toContain("without truncate");
    expect(failure?.detail).not.toContain("refer");
    expect(failure?.detail.match(/truncate/g)).toHaveLength(1);
  });

  test("every failure carries a code, a field and a non-empty detail", () => {
    const failures = failuresOf(
      { ...expressible, network: "off", readDenyList: ["/home/u/.ssh"], writableRoots: ["rel"] },
      1,
    );
    expect(failures.length).toBeGreaterThan(1);
    for (const failure of failures) {
      expect(failure.code.length).toBeGreaterThan(0);
      expect(failure.field.length).toBeGreaterThan(0);
      expect(failure.detail.length).toBeGreaterThan(0);
    }
  });

  test("every reason is reported, not just the first, with the field it is about", () => {
    const profile: SandboxProfile = {
      ...expressible,
      network: "off",
      readDenyList: ["/home/u/.ssh"],
      writableRoots: ["rel"],
    };
    expect(failuresOf(profile, 1).map((f) => [f.code, f.field])).toEqual([
      ["network-off-requires-seccomp", "network"],
      ["read-deny-list-requires-mount-view", "readDenyList"],
      ["path-not-absolute", "writableRoots"],
      ["abi-too-low", "abi"],
    ]);
  });

  test("a failed translation carries no ruleset at all", () => {
    const result = buildLandlockRuleset({ ...expressible, network: "off" }, ABI_CURRENT);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("ruleset");
  });

  test("the default policy-derived profile is inexpressible once a home directory is known", () => {
    // Recorded because it decides how often the bubblewrap fallback is taken:
    // `defaultReadDenyList(home)` is non-empty, and network-off compounds it.
    expect(codes(defaultSandboxProfile("/work/repo", "/tmp/session", "/home/u"))).toEqual([
      "network-off-requires-seccomp",
      "read-deny-list-requires-mount-view",
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC3 — a returned ruleset covers everything Landlock can reach
// ---------------------------------------------------------------------------

describe("AC3: a returned ruleset is complete by construction", () => {
  test("LandlockRuleset has no field in which a partial boundary could be recorded", () => {
    // The guard against a `notEnforced` / `bestEffort` / `partial` escape hatch
    // being added later: an approximated boundary would be reported as a real
    // one. It runs over every shape that yields a ruleset and at every ABI that
    // can return one, so an optional field populated on some other branch is
    // caught too — a single-fixture assertion is not a claim about the type.
    for (const abi of [3, 4, 5, 6]) {
      for (const profile of expressibleShapes) {
        expect(Object.keys(rulesetOf(profile, abi)).sort()).toEqual([
          "handledFs",
          "handledNet",
          "minimumAbi",
          "netRules",
          "pathRules",
        ]);
      }
    }
  });

  test("the type itself is pinned to those five fields", () => {
    // Runtime keys of one value can never prove a claim about a type. This does:
    // adding or removing a field on LandlockRuleset fails `tsc --noEmit`, which
    // the `check` script already runs.
    type Fields = "handledFs" | "handledNet" | "minimumAbi" | "netRules" | "pathRules";
    const exhaustive: Record<Fields, true> & Record<keyof LandlockRuleset, true> = {
      handledFs: true,
      handledNet: true,
      minimumAbi: true,
      netRules: true,
      pathRules: true,
    };
    expect(Object.keys(exhaustive).length).toBe(5);
  });

  test("every rule's allow set is a non-empty subset of the handled set", () => {
    for (const profile of expressibleShapes) {
      const ruleset = rulesetOf(profile);
      for (const rule of ruleset.pathRules) {
        expect(rule.allow.length).toBeGreaterThan(0);
        for (const access of rule.allow) {
          expect(ruleset.handledFs).toContain(access);
        }
      }
    }
  });

  test("minimumAbi is 3, and it is the maximum first-ABI over the handled rights", () => {
    const ruleset = rulesetOf(expressible);
    expect(ruleset.minimumAbi).toBe(3); // truncate is the binding right
    for (const right of ruleset.handledFs) {
      expect(LANDLOCK_FS_ACCESS_MIN_ABI[right]).toBeLessThanOrEqual(ruleset.minimumAbi);
    }
    expect(
      ruleset.handledFs.some((r) => LANDLOCK_FS_ACCESS_MIN_ABI[r] === ruleset.minimumAbi),
    ).toBe(true);
  });

  test("a ruleset is never returned below its own minimumAbi", () => {
    for (const abi of [0, 1, 2, 3, 4, 5, 6]) {
      const result = buildLandlockRuleset(expressible, abi);
      if (result.ok) {
        expect(abi).toBeGreaterThanOrEqual(result.ruleset.minimumAbi);
      }
    }
  });

  test("what Landlock cannot reach at any ABI is named in a value, not only in a comment", () => {
    // A ruleset covers every access right Landlock HAS that the profile bounds.
    // Metadata mutation has no such right at any ABI, so bubblewrap's boundary
    // is strictly stronger and the two must not be reported as equivalent. This
    // list is the mechanical record of that, for `sandbox status` to read — so
    // it is pinned as a full literal like the two UAPI tables. Asserting that
    // `handledFs` merely excludes these would be a tautology: none of them is a
    // `LandlockFsAccess` value, so no implementation change could make it fail.
    expect([...LANDLOCK_UNRESTRICTABLE_ACTIONS]).toEqual([
      "chmod",
      "chown",
      "setxattr",
      "utime",
      "fcntl",
      "flock",
    ]);
    expect(Object.isFrozen(LANDLOCK_UNRESTRICTABLE_ACTIONS)).toBe(true);
  });

  test("ioctl is recorded as a keryx deferral, not as a kernel limitation", () => {
    // It is unrestrictable below ABI 5 and restrictable from ABI 5 through
    // LANDLOCK_ACCESS_FS_IOCTL_DEV, so listing it as a kernel caveat would be
    // false on a 6.10 kernel — the same shape of untrue statement as reporting
    // a present binary as a working boundary.
    expect(LANDLOCK_UNRESTRICTABLE_ACTIONS).not.toContain("ioctl");
    expect(LANDLOCK_UNHANDLED_ACTIONS.map((a) => [a.action, a.restrictableFromAbi])).toEqual([
      ["ioctl", 5],
    ]);
    expect(LANDLOCK_UNHANDLED_ACTIONS[0]?.reason.length).toBeGreaterThan(0);
    expect(Object.isFrozen(LANDLOCK_UNHANDLED_ACTIONS)).toBe(true);
    // The deferral has to agree with the table it is a deferral from.
    const ioctl = LANDLOCK_UNHANDLED_ACTIONS.find((a) => a.action === "ioctl");
    expect(LANDLOCK_FS_ACCESS_MIN_ABI.ioctl_dev).toBe(ioctl?.restrictableFromAbi ?? -1);
  });

  test("neither residue list varies with the profile — they are mechanism facts", () => {
    for (const profile of expressibleShapes) {
      const ruleset = rulesetOf(profile);
      expect(ruleset.handledFs).not.toContain("ioctl_dev");
      expect([...LANDLOCK_UNRESTRICTABLE_ACTIONS]).toHaveLength(6);
      expect([...LANDLOCK_UNHANDLED_ACTIONS]).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// AC4 — Landlock is never credited with network containment
// ---------------------------------------------------------------------------

describe("AC4: no profile produces a network rule", () => {
  test.each(["on", "off", "restricted"] as const)(
    'network "%s" never yields handledNet or netRules',
    (network) => {
      const result = buildLandlockRuleset({ ...expressible, network }, ABI_CURRENT);
      if (!result.ok) {
        // No ruleset at all is the stronger form of "no network rule", but the
        // reason has to be the network one — otherwise this case proves nothing.
        expect(result.failures.map((f) => f.code)).toContain(
          network === "off" ? "network-off-requires-seccomp" : "network-restricted-requires-proxy-layer",
        );
        return;
      }
      expect(result.ruleset.handledNet).toEqual([]);
      expect(result.ruleset.netRules).toEqual([]);
    },
  );

  test("no profile shape at any usable ABI carries a network rule", () => {
    // Enumerated like AC3's guard rather than run on one fixture: a network
    // field populated on some other shape is exactly what a per-fixture
    // assertion misses, and this is the guard against the second false green.
    for (const abi of [3, 4, 5, 6]) {
      for (const profile of expressibleShapes) {
        const ruleset = rulesetOf(profile, abi);
        expect(ruleset.handledNet).toEqual([]);
        expect(ruleset.netRules).toEqual([]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Kernel constant tables
// ---------------------------------------------------------------------------

describe("access-right tables match the kernel UAPI", () => {
  test("bit positions are the uapi order", () => {
    expect(LANDLOCK_FS_ACCESS_BIT).toEqual({
      execute: 0,
      write_file: 1,
      read_file: 2,
      read_dir: 3,
      remove_dir: 4,
      remove_file: 5,
      make_char: 6,
      make_dir: 7,
      make_reg: 8,
      make_sock: 9,
      make_fifo: 10,
      make_block: 11,
      make_sym: 12,
      refer: 13,
      truncate: 14,
      ioctl_dev: 15,
    });
  });

  test("first-ABI values are the uapi ones", () => {
    // Pinned as a full literal, like the bit table: these are kernel facts, and
    // the module's whole ABI-floor argument rests on them being exact.
    expect(LANDLOCK_FS_ACCESS_MIN_ABI).toEqual({
      execute: 1,
      write_file: 1,
      read_file: 1,
      read_dir: 1,
      remove_dir: 1,
      remove_file: 1,
      make_char: 1,
      make_dir: 1,
      make_reg: 1,
      make_sock: 1,
      make_fifo: 1,
      make_block: 1,
      make_sym: 1,
      refer: 2,
      truncate: 3,
      ioctl_dev: 5,
    });
  });

  test("the two tables describe the same set of rights", () => {
    expect(Object.keys(LANDLOCK_FS_ACCESS_MIN_ABI).sort()).toEqual(
      Object.keys(LANDLOCK_FS_ACCESS_BIT).sort(),
    );
  });

  test("landlockFsMask folds names into the u64 mask", () => {
    expect(landlockFsMask([])).toBe(0n);
    expect(landlockFsMask(["execute"])).toBe(1n);
    expect(landlockFsMask(["write_file", "truncate"])).toBe(0b100000000000010n);
    // Idempotent: a repeated right sets the same bit once.
    expect(landlockFsMask(["truncate", "truncate"])).toBe(landlockFsMask(["truncate"]));
  });
});

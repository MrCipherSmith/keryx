import { describe, expect, test } from "bun:test";
import {
  LANDLOCK_FS_ACCESS_BIT,
  LANDLOCK_FS_ACCESS_MIN_ABI,
  LANDLOCK_UNRESTRICTABLE_ACTIONS,
  buildLandlockRuleset,
  landlockFsMask,
} from "./landlock";
import type {
  LandlockFsAccess,
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
  test("the module imports nothing impure", async () => {
    // AC1's "no syscall, no FFI, no spawn, no filesystem read, no
    // process.platform branch" is unobservable from outputs: a filesystem read
    // is perfectly deterministic within a run. The import allowlist is the
    // load-bearing half — it fails closed on any dependency added later, where
    // a list of known-bad names only catches what someone thought of.
    //
    // The module discusses `bun:ffi` and `process.platform` in prose, so the
    // scan runs over code with comments removed.
    const source = await Bun.file(new URL("./landlock.ts", import.meta.url)).text();
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    const imports = [...code.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect([...new Set(imports)].sort()).toEqual(["./profile", "node:path"]);

    for (const forbidden of [
      "node:fs",
      "node:os",
      "node:child_process",
      "bun:ffi",
      "process.platform",
      "process.env",
      "Date.now",
      "Math.random",
      "spawnSync",
      "require(",
    ]) {
      expect(code).not.toContain(forbidden);
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

  test("the shared access-right arrays are frozen, so a consumer cannot widen a boundary", () => {
    const ruleset = rulesetOf(expressible);
    expect(Object.isFrozen(ruleset.handledFs)).toBe(true);
    for (const rule of ruleset.pathRules) {
      expect(Object.isFrozen(rule.allow)).toBe(true);
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

  test.each(["/work/repo/../..", "/work/./repo", "/.."])(
    "the non-canonical root %s is refused rather than resolved",
    (root) => {
      // Resolving it would grant a hierarchy other than the one reported.
      expect(codes({ ...expressible, writableRoots: [root] })).toEqual(["path-not-canonical"]);
    },
  );

  test("ABI 0 is refused as Landlock being unavailable", () => {
    expect(codes(expressible, 0)).toEqual(["landlock-unavailable"]);
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "the malformed ABI %p is a reader failure, not a claim about the kernel",
    (abi) => {
      const [failure] = failuresOf(expressible, abi);
      expect(failure?.code).toBe("abi-unreadable");
      expect(failure?.detail).toContain("says nothing about the kernel");
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
    expect(failure?.detail).toContain("stricter than the profile asks for");
    expect(failure?.detail).not.toMatch(/refer, truncate would be left unrestricted/);
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

  test("what Landlock cannot reach is named in a value, not only in a comment", () => {
    // A ruleset covers every access right Landlock HAS that the profile bounds.
    // Metadata mutation has no such right at any ABI, so bubblewrap's boundary
    // is strictly stronger and the two must not be reported as equivalent. This
    // list is the mechanical record of that, for `sandbox status` to read.
    expect(LANDLOCK_UNRESTRICTABLE_ACTIONS).toContain("chmod");
    expect(LANDLOCK_UNRESTRICTABLE_ACTIONS).toContain("chown");
    expect(LANDLOCK_UNRESTRICTABLE_ACTIONS).toContain("setxattr");
    expect(Object.isFrozen(LANDLOCK_UNRESTRICTABLE_ACTIONS)).toBe(true);
    // It is a fact about the mechanism, so it must not vary with the profile.
    for (const right of LANDLOCK_UNRESTRICTABLE_ACTIONS) {
      expect(rulesetOf(expressible).handledFs).not.toContain(right as LandlockFsAccess);
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

  test.each([3, 4, 5, 6])("at ABI %i, where Landlock's TCP rights exist, none are handled", (abi) => {
    const ruleset = rulesetOf(expressible, abi);
    expect(ruleset.handledNet).toEqual([]);
    expect(ruleset.netRules).toEqual([]);
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

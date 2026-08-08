import { describe, expect, test } from "bun:test";
import {
  LANDLOCK_FS_ACCESS_BIT,
  LANDLOCK_FS_ACCESS_MIN_ABI,
  LANDLOCK_NET_ACCESS_BIT,
  LANDLOCK_NET_ACCESS_MIN_ABI,
  buildLandlockRuleset,
  landlockFsMask,
  landlockNetMask,
} from "./landlock";
import type { LandlockFsAccess, LandlockInexpressibleCode, LandlockRuleset } from "./landlock";
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

/** The failure codes of a translation, or `null` when it succeeded. */
function codes(profile: SandboxProfile, abi = ABI_CURRENT): LandlockInexpressibleCode[] | null {
  const result = buildLandlockRuleset(profile, abi);
  return result.ok ? null : result.failures.map((f) => f.code);
}

/** The ruleset of a translation; fails the test if it was inexpressible. */
function rulesetOf(profile: SandboxProfile, abi = ABI_CURRENT): LandlockRuleset {
  const result = buildLandlockRuleset(profile, abi);
  if (!result.ok) {
    throw new Error(`expected an expressible profile, got: ${result.failures.map((f) => f.code).join(", ")}`);
  }
  return result.ruleset;
}

// ---------------------------------------------------------------------------
// AC1 — deterministic, offline, no syscall
// ---------------------------------------------------------------------------

describe("AC1: buildLandlockRuleset is a pure translation", () => {
  test("identical inputs produce deeply equal output", () => {
    expect(buildLandlockRuleset(expressible, ABI_CURRENT)).toEqual(
      buildLandlockRuleset(expressible, ABI_CURRENT),
    );
  });

  test("the same profile is translated identically on repeated calls, including failures", () => {
    const offline = { ...expressible, network: "off" as const };
    expect(buildLandlockRuleset(offline, ABI_CURRENT)).toEqual(buildLandlockRuleset(offline, ABI_CURRENT));
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

  test("workspace roots become path-beneath rules, deduplicated, in profile order", () => {
    const ruleset = rulesetOf({ ...expressible, writableRoots: ["/work/repo", "/tmp/s", "/work/repo"] });
    expect(ruleset.pathRules.map((r) => r.path)).toEqual(["/work/repo", "/tmp/s"]);
  });

  test("read-only handles the same write rights but grants none of them anywhere", () => {
    const ruleset = rulesetOf({ ...expressible, mode: "read-only", writableRoots: [] });
    expect(ruleset.pathRules).toEqual([]);
    expect(ruleset.handledFs).toContain("write_file");
  });

  test("a read-only profile carrying writable roots does not grant them", () => {
    // `writableRoots` is documented as empty for read-only. Honouring it would
    // silently widen a read-only claim into workspace-write.
    const ruleset = rulesetOf({ ...expressible, mode: "read-only", writableRoots: ["/work/repo"] });
    expect(ruleset.pathRules).toEqual([]);
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
    for (const mode of ["read-only", "workspace-write"] as const) {
      expect(rulesetOf({ ...expressible, mode }).handledFs.length).toBeGreaterThan(0);
    }
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

  test("a writable root containing a NUL byte is refused", () => {
    expect(codes({ ...expressible, writableRoots: ["/work/re\0po"] })).toEqual(["path-contains-nul"]);
  });

  test("ABI 0 is refused as Landlock being unavailable, not as a low ABI", () => {
    expect(codes(expressible, 0)).toEqual(["landlock-unavailable"]);
  });

  test.each([1, 2])("ABI %i cannot carry the write boundary and is refused", (abi) => {
    expect(codes(expressible, abi)).toEqual(["abi-too-low"]);
  });

  test("ABI 3 is the floor at which the write boundary becomes expressible", () => {
    expect(buildLandlockRuleset(expressible, 3).ok).toBe(true);
    expect(rulesetOf(expressible, 3).minimumAbi).toBe(3);
  });

  test("the ABI failure names the kernel ABI and the missing rights, not the platform", () => {
    const result = buildLandlockRuleset(expressible, 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const detail = result.failures[0]?.detail ?? "";
    expect(detail).toContain("ABI 1");
    expect(detail).toContain("truncate");
    expect(detail.toLowerCase()).not.toContain("linux");
  });

  test("every failure carries a code, a field and a non-empty detail", () => {
    const result = buildLandlockRuleset(
      { ...expressible, network: "off", readDenyList: ["/home/u/.ssh"], writableRoots: ["rel"] },
      1,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.length).toBeGreaterThan(1);
    for (const failure of result.failures) {
      expect(failure.code.length).toBeGreaterThan(0);
      expect(failure.field.length).toBeGreaterThan(0);
      expect(failure.detail.length).toBeGreaterThan(0);
    }
  });

  test("every reason is reported, not just the first, and in a stable order", () => {
    const profile: SandboxProfile = {
      ...expressible,
      network: "off",
      readDenyList: ["/home/u/.ssh"],
      writableRoots: ["rel"],
    };
    expect(codes(profile, 1)).toEqual([
      "network-off-requires-seccomp",
      "read-deny-list-requires-mount-view",
      "path-not-absolute",
      "abi-too-low",
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
// AC3 — a returned ruleset enforces the whole profile
// ---------------------------------------------------------------------------

describe("AC3: a returned ruleset is complete by construction", () => {
  test("LandlockRuleset has no field in which a partial boundary could be recorded", () => {
    // The guard against a `notEnforced` / `bestEffort` / `partial` escape hatch
    // being added later: an approximated boundary would be reported as a real
    // one, which is the defect ADR-0010 exists to remove.
    expect(Object.keys(rulesetOf(expressible)).sort()).toEqual([
      "handledFs",
      "handledNet",
      "minimumAbi",
      "netRules",
      "pathRules",
    ]);
  });

  test("every rule's allow set is a non-empty subset of the handled set", () => {
    const ruleset = rulesetOf(expressible);
    for (const rule of ruleset.pathRules) {
      expect(rule.allow.length).toBeGreaterThan(0);
      for (const access of rule.allow) {
        expect(ruleset.handledFs).toContain(access);
      }
    }
  });

  test("minimumAbi is the maximum first-ABI over the handled rights", () => {
    const ruleset = rulesetOf(expressible);
    const expected = Math.max(...ruleset.handledFs.map((a) => LANDLOCK_FS_ACCESS_MIN_ABI[a]));
    expect(ruleset.minimumAbi).toBe(expected);
  });

  test("a ruleset is never returned below its own minimumAbi", () => {
    for (const abi of [0, 1, 2, 3, 4, 5, 6]) {
      const result = buildLandlockRuleset(expressible, abi);
      if (result.ok) {
        expect(abi).toBeGreaterThanOrEqual(result.ruleset.minimumAbi);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC4 — Landlock is never credited with network-off
// ---------------------------------------------------------------------------

describe("AC4: no profile produces a network rule", () => {
  test.each(["on", "off", "restricted"] as const)(
    'network "%s" never yields handledNet or netRules',
    (network) => {
      const result = buildLandlockRuleset({ ...expressible, network }, ABI_CURRENT);
      if (result.ok) {
        expect(result.ruleset.handledNet).toEqual([]);
        expect(result.ruleset.netRules).toEqual([]);
      }
    },
  );

  test("even at ABI 6, where Landlock's TCP rights exist, none are handled", () => {
    const ruleset = rulesetOf(expressible, 6);
    expect(ruleset.handledNet).toEqual([]);
    expect(ruleset.netRules).toEqual([]);
  });

  test("the TCP rights are declared as ABI 4 and named TCP-only", () => {
    expect(LANDLOCK_NET_ACCESS_MIN_ABI).toEqual({ bind_tcp: 4, connect_tcp: 4 });
  });
});

// ---------------------------------------------------------------------------
// Kernel constant tables
// ---------------------------------------------------------------------------

describe("access-right tables match the kernel UAPI", () => {
  test("filesystem bit positions are the uapi order", () => {
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

  test("every filesystem right has both a bit and a first-ABI", () => {
    const rights = Object.keys(LANDLOCK_FS_ACCESS_BIT) as LandlockFsAccess[];
    for (const right of rights) {
      expect(LANDLOCK_FS_ACCESS_MIN_ABI[right]).toBeGreaterThanOrEqual(1);
    }
    expect(Object.keys(LANDLOCK_FS_ACCESS_MIN_ABI).sort()).toEqual(rights.sort());
  });

  test("landlockFsMask folds names into the u64 mask", () => {
    expect(landlockFsMask([])).toBe(0n);
    expect(landlockFsMask(["execute"])).toBe(1n);
    expect(landlockFsMask(["write_file", "truncate"])).toBe(0b100000000000010n);
    // Idempotent: a repeated right sets the same bit once.
    expect(landlockFsMask(["truncate", "truncate"])).toBe(landlockFsMask(["truncate"]));
  });

  test("landlockNetMask folds names into the u64 mask", () => {
    expect(landlockNetMask([])).toBe(0n);
    expect(landlockNetMask(["bind_tcp"])).toBe(1n);
    expect(landlockNetMask(["bind_tcp", "connect_tcp"])).toBe(3n);
  });

  test("network bit positions are the uapi order", () => {
    expect(LANDLOCK_NET_ACCESS_BIT).toEqual({ bind_tcp: 0, connect_tcp: 1 });
  });
});

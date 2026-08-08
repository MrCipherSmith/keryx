// keryx-linux-containment step 1 — AC4 and AC5.
//
// AC4: the probe reports failure with the launcher's verbatim stderr, and
//      success without it.
// AC5: the probe runs at most once per process.
//
// Every case injects the spawn, so this file never launches bubblewrap,
// sandbox-exec, or anything else — the same discipline `detect.test.ts` keeps
// by injecting `existsSync`.

import { afterEach, describe, expect, test } from "bun:test";
import {
  BWRAP_APPARMOR_REMEDIATION,
  probeContainment,
  resetContainmentProbeCacheForTests,
  runContainmentProbe,
  type ProbeSpawn,
  type ProbeSpawnResult,
} from "./probe";

/** The exact failure measured on Ubuntu 24.04 with no AppArmor profile for bwrap. */
const UID_MAP_FAILURE = "bwrap: setting up uid map: Permission denied";

interface RecordingSpawn {
  spawn: ProbeSpawn;
  calls: { path: string; argv: string[] }[];
}

function recordingSpawn(result: ProbeSpawnResult): RecordingSpawn {
  const calls: { path: string; argv: string[] }[] = [];
  return {
    calls,
    spawn: (path, argv) => {
      calls.push({ path, argv });
      return result;
    },
  };
}

afterEach(() => {
  // The cache is process-global by design (N4). Every test that touches it
  // clears it afterwards so ordering between files cannot decide an outcome.
  resetContainmentProbeCacheForTests();
});

describe("runContainmentProbe — AC4: the launcher's own words are the evidence", () => {
  test("linux failure: reports not-ok, layer bwrap, and the stderr VERBATIM", () => {
    const { spawn } = recordingSpawn({ status: 1, stderr: `${UID_MAP_FAILURE}\n` });
    const result = runContainmentProbe({ platform: "linux", launcherPath: "/usr/bin/bwrap", spawn, cwd: "/tmp" });

    expect(result.ok).toBe(false);
    expect(result.layer).toBe("bwrap");
    // Verbatim: not paraphrased, not prefixed, not summarised. Only the
    // trailing newline is trimmed.
    expect(result.detail).toBe(UID_MAP_FAILURE);
  });

  test("linux failure: names the AppArmor profile as the remediation", () => {
    const { spawn } = recordingSpawn({ status: 1, stderr: UID_MAP_FAILURE });
    const result = runContainmentProbe({ platform: "linux", spawn, cwd: "/tmp" });

    expect(result.remediation).toBe(BWRAP_APPARMOR_REMEDIATION);
    expect(result.remediation).toContain("/etc/apparmor.d/bwrap");
  });

  test("R8 / AC13: the remediation never names the machine-wide sysctl", () => {
    // ADR-0010 rejected `sysctl kernel.apparmor_restrict_unprivileged_userns=0`
    // outright — it disables the restriction for every process on the machine
    // to fix one program — and the advice was deleted from the runbook and the
    // operator guide. A test, not a review convention, keeps it deleted.
    const { spawn } = recordingSpawn({ status: 1, stderr: UID_MAP_FAILURE });
    const result = runContainmentProbe({ platform: "linux", spawn });

    const emitted = `${result.detail ?? ""}\n${result.remediation ?? ""}`;
    expect(emitted).not.toContain("apparmor_restrict_unprivileged_userns");
    expect(emitted).not.toContain("sysctl");
  });

  test("linux success: ok, and NO detail — there is no evidence to quote", () => {
    const { spawn } = recordingSpawn({ status: 0, stderr: "" });
    const result = runContainmentProbe({ platform: "linux", spawn });

    expect(result).toEqual({ layer: "bwrap", ok: true });
    expect(result.detail).toBeUndefined();
    expect(result.remediation).toBeUndefined();
  });

  test("a launcher that cannot be executed at all reports the spawn error as the detail", () => {
    const { spawn } = recordingSpawn({ status: null, error: new Error("spawnSync /usr/bin/bwrap ENOENT") });
    const result = runContainmentProbe({ platform: "linux", spawn });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ENOENT");
  });

  test("a nonzero exit with silent stderr still fails, and says so rather than inventing a cause", () => {
    const { spawn } = recordingSpawn({ status: 3, stderr: "   " });
    const result = runContainmentProbe({ platform: "linux", spawn });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("exited 3");
  });

  test("the trial runs through the REAL bwrap wrapper, not a hand-written argv", () => {
    // A probe that tests a different boundary from the one being reported on is
    // the original defect in a new place. These flags come from `wrapBwrap`.
    const { spawn, calls } = recordingSpawn({ status: 0, stderr: "" });
    runContainmentProbe({ platform: "linux", launcherPath: "/usr/bin/bwrap", spawn, cwd: "/tmp" });

    expect(calls.length).toBe(1);
    expect(calls[0]!.path).toBe("/usr/bin/bwrap");
    expect(calls[0]!.argv).toContain("--ro-bind");
    expect(calls[0]!.argv).toContain("--unshare-net");
    expect(calls[0]!.argv).toContain("--die-with-parent");
    // …and it ends by exec'ing the trivial trial command (spec §6).
    expect(calls[0]!.argv.at(-1)).toBe("/bin/true");
    expect(calls[0]!.argv.at(-2)).toBe("--");
  });

  test("darwin: probes through sandbox-exec and reports the seatbelt layer", () => {
    const { spawn, calls } = recordingSpawn({ status: 0, stderr: "" });
    const result = runContainmentProbe({ platform: "darwin", spawn, cwd: "/tmp" });

    expect(result).toEqual({ layer: "seatbelt", ok: true });
    expect(calls[0]!.path).toBe("/usr/bin/sandbox-exec");
    expect(calls[0]!.argv).toContain("-p");
    expect(calls[0]!.argv.at(-1)).toBe("/usr/bin/true");
  });

  test("darwin failure carries the launcher's stderr but no remediation — there is none to give", () => {
    const { spawn } = recordingSpawn({ status: 1, stderr: "sandbox-exec: sandbox_apply: Operation not permitted" });
    const result = runContainmentProbe({ platform: "darwin", spawn });

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("sandbox-exec: sandbox_apply: Operation not permitted");
    expect(result.remediation).toBeUndefined();
  });

  test("an unsupported platform is `none`, not-ok, and spawns nothing at all", () => {
    const { spawn, calls } = recordingSpawn({ status: 0, stderr: "" });
    const result = runContainmentProbe({ platform: "win32", spawn });

    expect(result.layer).toBe("none");
    expect(result.ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("falsifiable: a spawn that succeeds and one that fails do not produce the same result", () => {
    // Proves the assertions above are load-bearing rather than reading a
    // constant: the ONLY difference between these two calls is the injected
    // exit status.
    const ok = runContainmentProbe({ platform: "linux", spawn: recordingSpawn({ status: 0, stderr: "" }).spawn });
    const bad = runContainmentProbe({
      platform: "linux",
      spawn: recordingSpawn({ status: 1, stderr: UID_MAP_FAILURE }).spawn,
    });
    expect(ok.ok).not.toBe(bad.ok);
    expect(ok.detail).toBeUndefined();
    expect(bad.detail).toBe(UID_MAP_FAILURE);
  });
});

describe("probeContainment — AC5: at most one probe per process", () => {
  test("a second call spawns nothing and returns the first result", () => {
    const { spawn, calls } = recordingSpawn({ status: 1, stderr: UID_MAP_FAILURE });

    const first = probeContainment({ platform: "linux", spawn });
    const second = probeContainment({ platform: "linux", spawn });
    const third = probeContainment({ platform: "linux", spawn });

    expect(calls.length).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  test("the cache holds even when a later caller passes different options", () => {
    // N4 is a bound on how many contained commands one process may spawn, not a
    // per-argument memo. A caller that could defeat it by varying its options
    // would satisfy the letter of "cached" and none of the requirement.
    const first = recordingSpawn({ status: 1, stderr: UID_MAP_FAILURE });
    const second = recordingSpawn({ status: 0, stderr: "" });

    probeContainment({ platform: "linux", spawn: first.spawn });
    const again = probeContainment({ platform: "darwin", spawn: second.spawn });

    expect(second.calls.length).toBe(0);
    expect(again.ok).toBe(false);
  });

  test("falsifiable: the uncached entry point does spawn every time", () => {
    // Without this, "calls.length === 1" above could be true because the fake
    // spawn is never reached at all.
    const { spawn, calls } = recordingSpawn({ status: 0, stderr: "" });
    runContainmentProbe({ platform: "linux", spawn });
    runContainmentProbe({ platform: "linux", spawn });
    expect(calls.length).toBe(2);
  });

  test("the test-only reset actually clears the slot", () => {
    const first = recordingSpawn({ status: 0, stderr: "" });
    probeContainment({ platform: "linux", spawn: first.spawn });
    resetContainmentProbeCacheForTests();

    const second = recordingSpawn({ status: 1, stderr: UID_MAP_FAILURE });
    const result = probeContainment({ platform: "linux", spawn: second.spawn });

    expect(second.calls.length).toBe(1);
    expect(result.ok).toBe(false);
  });
});

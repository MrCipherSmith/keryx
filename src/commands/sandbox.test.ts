// flow 142 (P4) — `keryx sandbox status` — extended by keryx-linux-containment
// step 1 (R4, R6, R8 / AC6, AC13).
//
// AC2: report, not a gate — exits zero regardless of what it finds.
// AC3: the five findings are five different sentences and never collapse into
// one another — installing something helps in exactly one of them.
// AC6: no capability reads as available unless a probe confirmed it on this
// host, and a Linux `unavailable` row names the KERNEL, not the platform string.
// AC6 (flow 142) covered separately by src/standard/command-registry.test.ts /
// command-registry.coverage.test.ts (registration + routing).
//
// Every case injects `probe`, `kernelRelease` and `existsSync`, so no test in
// this file launches a sandbox or reads this machine's kernel. The injected
// probe is the REAL `runContainmentProbe` over a fake spawn rather than a
// hand-written `ProbeResult`: that keeps the wiring under test instead of
// stubbing it out, while the once-per-process cache (AC5) stays proven in
// probe.test.ts where several outcomes per process are possible.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildSandboxReport,
  renderSandboxReport,
  sandboxCommand,
  CONTAINMENT_UNAVAILABLE_HEADLINE,
  DEFAULT_PROBE_RUNNER,
  LAUNCHER_NOT_INSTALLED,
  NOT_COVERED_BY_PROBE,
  NOT_IMPLEMENTED_ON_PLATFORM,
  PROBED_AND_NOT_WORKING,
  type ProbeRunner,
  type SandboxCapabilityReportRow,
  type SandboxCommandDeps,
} from "./sandbox";
import {
  probeContainment,
  resetContainmentProbeCacheForTests,
  runContainmentProbe,
} from "../harness/process/sandbox/probe";

/** The exact failure measured on Ubuntu 24.04 with no AppArmor profile for bwrap. */
const UID_MAP_FAILURE = "bwrap: setting up uid map: Permission denied";
const TEST_KERNEL = "6.8.0-136-generic";

const SANDBOX_MATRIX_LABELS = ["Filesystem containment", "Network OFF", "Domain allowlist", "Credential masking"];

/** A probe runner backed by a fake spawn — the real probe, no real launcher. */
function probeWith(spawnResult: { status: number | null; stderr?: string }): ProbeRunner {
  return (opts) => runContainmentProbe({ ...opts, spawn: () => spawnResult, cwd: "/tmp" });
}

const probeContained = probeWith({ status: 0, stderr: "" });
const probeUidMapDenied = probeWith({ status: 1, stderr: `${UID_MAP_FAILURE}\n` });

/** Deps that never touch the real filesystem, kernel, or a launcher. */
function deps(overrides: SandboxCommandDeps): SandboxCommandDeps {
  return { kernelRelease: () => TEST_KERNEL, ...overrides };
}

const linuxWithBwrap = {
  platform: "linux",
  env: { PATH: "/usr/bin" },
  existsSync: (p: string) => p === "/usr/bin/bwrap",
};
const linuxWithoutBwrap = { platform: "linux", env: { PATH: "/usr/bin" }, existsSync: () => false };
const darwinWithSeatbelt = { platform: "darwin", existsSync: (p: string) => p === "/usr/bin/sandbox-exec" };

async function runCaptured(fn: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

function byCapability(rows: SandboxCapabilityReportRow[]): Record<string, SandboxCapabilityReportRow> {
  return Object.fromEntries(rows.map((c) => [c.capability, c]));
}

describe("buildSandboxReport", () => {
  test("AC6: linux, bwrap present AND the probe contains — filesystem + network available", () => {
    const report = buildSandboxReport(deps({ ...linuxWithBwrap, probe: probeContained }));
    expect(report.platform).toBe("linux");
    expect(report.launcher.available).toBe(true);
    expect(report.probe?.ok).toBe(true);

    const rows = byCapability(report.capabilities);
    expect(rows["Filesystem containment"]!.kind).toBe("available");
    expect(rows["Network OFF"]!.kind).toBe("available");
    expect(rows["Domain allowlist"]!.kind).toBe("not-implemented");
    expect(rows["Credential masking"]!.kind).toBe("not-implemented");
  });

  test("AC6: THE DEFECT — bwrap present but the probe fails: nothing reads as available", () => {
    // This is the exact host state measured on Ubuntu 24.04 on 2026-08-08:
    // bubblewrap installed, every contained run dying. The old report said
    // "available" for both rows.
    const report = buildSandboxReport(deps({ ...linuxWithBwrap, probe: probeUidMapDenied }));

    expect(report.launcher.available).toBe(true);
    expect(report.probe?.ok).toBe(false);
    expect(report.capabilities.some((c) => c.kind === "available")).toBe(false);

    const rows = byCapability(report.capabilities);
    for (const name of ["Filesystem containment", "Network OFF"]) {
      const row = rows[name]!;
      expect(row.kind).toBe("unavailable");
      expect(row.status).toContain(PROBED_AND_NOT_WORKING);
      // The launcher's own words, verbatim.
      expect(row.detail).toBe(UID_MAP_FAILURE);
      expect(row.remediation).toContain("/etc/apparmor.d/bwrap");
    }
  });

  test("AC6/R6: the `unavailable` reason names the KERNEL and the kernel facility, not the platform string", () => {
    const report = buildSandboxReport(deps({ ...linuxWithBwrap, probe: probeUidMapDenied }));
    const reason = byCapability(report.capabilities)["Filesystem containment"]!.reason ?? "";

    expect(reason).toContain(TEST_KERNEL);
    expect(reason).toContain("unprivileged user namespaces");
    // On Linux it is the kernel that decides — saying "linux" names something
    // the user cannot act on, and something that is not even true (it works on
    // 22.04 and on a 24.04 with the profile installed).
    expect(reason).not.toContain("linux");
  });

  test("R6: a different kernel release is reflected, so the reason is a fact about THIS host", () => {
    const report = buildSandboxReport(
      deps({ ...linuxWithBwrap, probe: probeUidMapDenied, kernelRelease: () => "5.15.0-generic" }),
    );
    const reason = byCapability(report.capabilities)["Filesystem containment"]!.reason ?? "";
    expect(reason).toContain("5.15.0-generic");
    expect(reason).not.toContain(TEST_KERNEL);
  });

  test("R6: an empty kernel release degrades to `unknown release` rather than an empty parenthesis", () => {
    const report = buildSandboxReport(
      deps({ ...linuxWithBwrap, probe: probeUidMapDenied, kernelRelease: () => "" }),
    );
    expect(byCapability(report.capabilities)["Filesystem containment"]!.reason).toContain("unknown release");
  });

  test("a failure the probe could NOT diagnose does not get the kernel reason or the AppArmor remediation", () => {
    // The probe reports what the launcher said; it does not promote every
    // failure to a user-namespace denial. A read-only-filesystem error must not
    // send the user to author an AppArmor profile that cannot help them.
    const report = buildSandboxReport(
      deps({
        ...linuxWithBwrap,
        probe: probeWith({ status: 1, stderr: "bwrap: Can't mkdir /run/user/1000: Read-only file system" }),
      }),
    );
    const row = byCapability(report.capabilities)["Filesystem containment"]!;

    expect(row.kind).toBe("unavailable");
    expect(row.reason).not.toContain("unprivileged user namespaces");
    expect(row.reason).not.toContain(TEST_KERNEL);
    expect(row.remediation).toBeUndefined();
    // …but the launcher's words are still the finding.
    expect(row.detail).toContain("Read-only file system");
  });

  test("AC3: linux without bwrap — launcher-missing, never the other sentences, and NO probe is run", () => {
    let probes = 0;
    const countingProbe: ProbeRunner = (opts) => {
      probes += 1;
      return probeContained(opts);
    };
    const report = buildSandboxReport(deps({ ...linuxWithoutBwrap, probe: countingProbe }));

    expect(report.launcher.available).toBe(false);
    // N4: never probe on a path that is not reporting capability. There is no
    // launcher to trial, so nothing is spawned to learn what is already known.
    expect(probes).toBe(0);
    expect(report.probe).toBeUndefined();

    const rows = byCapability(report.capabilities);
    for (const name of ["Filesystem containment", "Network OFF"]) {
      const row = rows[name]!;
      expect(row.kind).toBe("launcher-missing");
      expect(row.status).toContain(LAUNCHER_NOT_INSTALLED);
      expect(row.status).not.toContain(NOT_IMPLEMENTED_ON_PLATFORM);
      expect(row.status).not.toContain(PROBED_AND_NOT_WORKING);
    }

    // Not implemented on Linux AT ALL — installing bwrap would not change this,
    // and the sentence must say so, not "launcher not installed".
    for (const name of ["Domain allowlist", "Credential masking"]) {
      const row = rows[name]!;
      expect(row.kind).toBe("not-implemented");
      expect(row.status).toContain(NOT_IMPLEMENTED_ON_PLATFORM);
      expect(row.status).not.toContain(LAUNCHER_NOT_INSTALLED);
    }
  });

  test("AC3: the four negative findings are four different sentences, never interchangeable", () => {
    const missing = buildSandboxReport(deps({ ...linuxWithoutBwrap, probe: probeContained }));
    const broken = buildSandboxReport(deps({ ...linuxWithBwrap, probe: probeUidMapDenied }));
    const working = buildSandboxReport(deps({ ...darwinWithSeatbelt, probe: probeContained }));

    const sentences = [
      byCapability(missing.capabilities)["Filesystem containment"]!.status,
      byCapability(broken.capabilities)["Filesystem containment"]!.status,
      byCapability(missing.capabilities)["Domain allowlist"]!.status,
      byCapability(working.capabilities)["Domain allowlist"]!.status,
    ];
    expect(new Set(sentences).size).toBe(4);

    const brokenRow = byCapability(broken.capabilities)["Filesystem containment"]!;
    expect(brokenRow.status).not.toContain(LAUNCHER_NOT_INSTALLED);
    expect(brokenRow.status).not.toContain(NOT_IMPLEMENTED_ON_PLATFORM);
    expect(brokenRow.status).not.toContain(NOT_COVERED_BY_PROBE);
  });

  test("THE OVER-CLAIM: a clean darwin trial confirms only what the trial exercised", () => {
    // A single seatbelt trial with `network: "off"`, no deny-list and no
    // allowlist proves nothing about `--allowed-domains` or `--mask-env`.
    // Reporting all four rows as "confirmed by a trial contained command" was
    // this package's own defect, relocated to macOS.
    const report = buildSandboxReport(deps({ ...darwinWithSeatbelt, probe: probeContained }));
    const rows = byCapability(report.capabilities);

    expect(rows["Filesystem containment"]!.kind).toBe("available");
    expect(rows["Network OFF"]!.kind).toBe("available");

    for (const name of ["Domain allowlist", "Credential masking"]) {
      const row = rows[name]!;
      expect(row.kind).toBe("unprobed");
      expect(row.status).toContain(NOT_COVERED_BY_PROBE);
      // It is implemented — this must not read as "not implemented" …
      expect(row.status).not.toContain(NOT_IMPLEMENTED_ON_PLATFORM);
      // … nor as confirmed.
      expect(row.status).not.toContain("confirmed by a trial");
    }
  });

  test("N5: darwin with a failing probe reports unavailable — macOS is measured too, not assumed", () => {
    const report = buildSandboxReport(
      deps({
        ...darwinWithSeatbelt,
        probe: probeWith({ status: 1, stderr: "sandbox-exec: sandbox_apply: Operation not permitted" }),
      }),
    );
    expect(report.capabilities.every((c) => c.kind === "unavailable")).toBe(true);

    const reason = report.capabilities[0]!.reason ?? "";
    // It says something, and what it says is that a trial was run and failed …
    expect(reason).toContain("a trial contained command was run on this host and it did not contain");
    // … without borrowing the Linux kernel explanation, which would be a cause
    // nobody measured on this platform.
    expect(reason).not.toContain("unprivileged user namespaces");
  });

  test("darwin without sandbox-exec: every capability is launcher-missing, none say not-implemented", () => {
    const report = buildSandboxReport(deps({ platform: "darwin", existsSync: () => false, probe: probeContained }));
    expect(report.launcher.available).toBe(false);
    for (const cap of report.capabilities) {
      expect(cap.kind).toBe("launcher-missing");
      expect(cap.status).toContain(LAUNCHER_NOT_INSTALLED);
    }
  });

  test("unsupported platform: everything is not-implemented, nothing is probed", () => {
    let probes = 0;
    const report = buildSandboxReport(
      deps({
        platform: "win32",
        probe: (opts) => {
          probes += 1;
          return probeContained(opts);
        },
      }),
    );
    expect(probes).toBe(0);
    for (const cap of report.capabilities) {
      expect(cap.kind).toBe("not-implemented");
      expect(cap.status).not.toContain(LAUNCHER_NOT_INSTALLED);
    }
  });

  test("AC5 wiring: the default probe runner is the CACHED entry point", () => {
    // A necessary but weak assertion on its own — it pins the constant, not the
    // use of it. The test below pins the use.
    expect(DEFAULT_PROBE_RUNNER).toBe(probeContainment);
    expect(DEFAULT_PROBE_RUNNER).not.toBe(runContainmentProbe);
  });

  test("AC5 wiring: with no injected probe, the report uses the process-global CACHE", () => {
    // The line that matters is `deps.probe ?? DEFAULT_PROBE_RUNNER` — and every
    // other test in this file injects `probe`, so that fallback was never
    // executed. A regression to `?? runContainmentProbe` would defeat N4's
    // once-per-process bound and keep the whole suite green.
    //
    // Exercised without spawning by priming the cache first: if the report
    // reaches the cached probe, it gets the primed result and the fake spawn is
    // never called a second time. If it reached the UNCACHED probe, it would
    // spawn again and the count would be 2.
    resetContainmentProbeCacheForTests();
    try {
      let spawns = 0;
      const primed = probeContainment({
        platform: "linux",
        spawn: () => {
          spawns += 1;
          return { status: 1, stderr: UID_MAP_FAILURE };
        },
      });
      expect(spawns).toBe(1);

      const report = buildSandboxReport({ ...linuxWithBwrap, kernelRelease: () => TEST_KERNEL });

      expect(spawns).toBe(1);
      expect(report.probe).toBe(primed);
      expect(report.capabilities.some((c) => c.kind === "available")).toBe(false);
    } finally {
      // The cache is process-global; leaving it primed would decide outcomes in
      // whatever file `bun test` runs next.
      resetContainmentProbeCacheForTests();
    }
  });
});

describe("renderSandboxReport", () => {
  test("renders platform, launcher, and every capability row", () => {
    const report = buildSandboxReport(deps({ ...linuxWithoutBwrap, probe: probeContained }));
    const text = renderSandboxReport(report);
    expect(text).toContain("Platform: linux");
    expect(text).toContain("Launcher: not found");
    for (const row of SANDBOX_MATRIX_LABELS) {
      expect(text).toContain(row);
    }
    // Never claims to gate anything.
    expect(text.toLowerCase()).toContain("not a gate");
  });

  test("AC6: the rendered text never says a capability is available when the probe failed", () => {
    const text = renderSandboxReport(buildSandboxReport(deps({ ...linuxWithBwrap, probe: probeUidMapDenied })));

    expect(text).toContain("Containment probe: FAILED");
    expect(text).toContain(CONTAINMENT_UNAVAILABLE_HEADLINE);
    // The launcher's own words, on their own line, attributed to the launcher.
    expect(text).toContain(UID_MAP_FAILURE);
    expect(text).toContain("bwrap said:");
    expect(text).toContain("Remediation:");
    expect(text).toContain("/etc/apparmor.d/bwrap");
    // The sentence that was the defect.
    expect(text).not.toMatch(/containment and network-off are available/i);
  });

  test("multi-line launcher output is quoted line by line, all of it", () => {
    const text = renderSandboxReport(
      buildSandboxReport(
        deps({
          ...linuxWithBwrap,
          probe: probeWith({ status: 1, stderr: "bwrap: setting up uid map: Permission denied\nbwrap: and a second line" }),
        }),
      ),
    );
    expect(text).toContain("    bwrap: setting up uid map: Permission denied");
    expect(text).toContain("    bwrap: and a second line");
  });

  test("an undiagnosed failure says keryx has no remediation rather than offering a guess", () => {
    const text = renderSandboxReport(
      buildSandboxReport(
        deps({ ...linuxWithBwrap, probe: probeWith({ status: 1, stderr: "bwrap: something unfamiliar" }) }),
      ),
    );
    expect(text).toContain("no remediation keyed to that error");
    expect(text).not.toContain("Remediation:");
    expect(text).not.toContain("/etc/apparmor.d/bwrap");
  });

  test("AC6: a clean probe is stated as a measurement, and names the layer", () => {
    const text = renderSandboxReport(buildSandboxReport(deps({ ...linuxWithBwrap, probe: probeContained })));
    expect(text).toContain("Containment probe: OK");
    expect(text).toContain("under bwrap");
    expect(text).toContain("confirmed by a trial contained command on this host");
    expect(text).not.toContain("FAILED");
  });

  test("R6: the kernel release is named in the header on Linux", () => {
    const text = renderSandboxReport(buildSandboxReport(deps({ ...linuxWithBwrap, probe: probeUidMapDenied })));
    expect(text).toContain(`Platform: linux (kernel ${TEST_KERNEL})`);
  });

  test("no launcher: says containment is unavailable and how to install it, exactly once", () => {
    const text = renderSandboxReport(buildSandboxReport(deps({ ...linuxWithoutBwrap, probe: probeContained })));
    expect(text).toContain("Containment probe: not run");
    expect(text).toContain(CONTAINMENT_UNAVAILABLE_HEADLINE);
    expect(text).toMatch(/install it:.*bubblewrap/i);
    // One hint, not two. Two copies is how the wordings drifted apart before —
    // one listed Arch and the other did not, two lines apart in this output.
    expect(text.match(/Install it:/gi)?.length).toBe(1);
  });

  test("AC7: every user-visible finding this command can print is described in the runbook", () => {
    // The doc-sync test next door pins the three CapabilityStatus values, but
    // the report has FIVE findings — the two extra ones (`unprobed` and the
    // launcher-missing sentence) are composed here, not stored in the matrix,
    // so that test cannot see them. `unprobed` shipped undescribed because of
    // exactly that gap: a macOS operator would read a sentence about
    // `--allowed-domains` that the runbook this PR calls the source of truth
    // did not mention.
    const runbook = readFileSync(
      path.join(import.meta.dir, "..", "..", "docs", "verification", "linux-sandbox-verification.md"),
      "utf8",
    ).replace(/\*+/g, "").replace(/\s+/g, " ");

    // Pinned verbatim, because this one is quoted verbatim in the runbook — it
    // is the finding that was introduced with no documentation at all. The
    // other four findings are described there in prose rather than as literal
    // strings, and coupling those to the exact wording here would make every
    // editorial improvement to the runbook a test failure.
    expect(runbook).toContain(NOT_COVERED_BY_PROBE);
    // The runbook must also say what the trial does NOT cover, which is the
    // substance of the finding rather than its label.
    expect(runbook).toContain("--allowed-domains");
    expect(runbook).toContain("--mask-env");

    // Falsifiable: the parse produced real content, so the assertion above is
    // reading the document rather than passing on an empty haystack, and a
    // near-miss wording is absent.
    expect(runbook.length).toBeGreaterThan(1000);
    expect(runbook).toContain("The three capability states");
    expect(runbook).not.toContain(`${NOT_COVERED_BY_PROBE} (mutated)`);
  });

  test("AC13: no rendering path names the machine-wide sysctl, in any state", () => {
    // ADR-0010 rejected `sysctl kernel.apparmor_restrict_unprivileged_userns=0`
    // outright and the advice was deleted from the docs. This asserts it cannot
    // creep back through the one surface a user actually reads.
    const states = [
      buildSandboxReport(deps({ ...linuxWithBwrap, probe: probeUidMapDenied })),
      buildSandboxReport(deps({ ...linuxWithBwrap, probe: probeContained })),
      buildSandboxReport(deps({ ...linuxWithoutBwrap, probe: probeContained })),
      buildSandboxReport(deps({ ...darwinWithSeatbelt, probe: probeContained })),
      buildSandboxReport(deps({ platform: "win32" })),
    ];
    for (const report of states) {
      const text = renderSandboxReport(report);
      expect(text).not.toContain("apparmor_restrict_unprivileged_userns");
      expect(text).not.toContain("sysctl");
    }
  });
});

describe("sandboxCommand — AC2: report, not a gate", () => {
  // These assert AC2's actual claim — the command does not change the exit code
  // at all, in either direction — rather than the identity of the sentinel
  // `undefined`. That distinction matters under `bun test`'s full-suite run
  // (what CI runs): every file shares one process, so whatever
  // `process.exitCode` already is when this test starts is not under this
  // file's control, and a runtime is free to normalise an `undefined`
  // assignment to `0` anyway. Snapshotting the value beforehand and asserting
  // it is unchanged afterward holds regardless of what it started as, and
  // — because it never assigns to `process.exitCode` itself — there is
  // nothing here to restore or leak into whatever test file runs next.
  //
  // Each is wrapped in `runCaptured` even though none asserts on output:
  // otherwise every CI run of this file prints three full sandbox reports,
  // burying the diagnostics that matter when something does fail.
  test("never sets process.exitCode, even when the launcher is missing", async () => {
    const before = process.exitCode;
    await runCaptured(() => sandboxCommand([], deps({ ...linuxWithoutBwrap, probe: probeContained })));
    expect(process.exitCode).toBe(before);
  });

  test("never sets process.exitCode when the probe FAILS either — a broken boundary is still a report", async () => {
    const before = process.exitCode;
    await runCaptured(() => sandboxCommand(["status"], deps({ ...linuxWithBwrap, probe: probeUidMapDenied })));
    expect(process.exitCode).toBe(before);
  });

  test("never sets process.exitCode on an unsupported platform either", async () => {
    const before = process.exitCode;
    await runCaptured(() => sandboxCommand(["status"], deps({ platform: "win32" })));
    expect(process.exitCode).toBe(before);
  });

  test("--json prints valid, parseable JSON with the platform, probe and capabilities", async () => {
    const lines = await runCaptured(() =>
      sandboxCommand(["status", "--json"], deps({ ...linuxWithBwrap, probe: probeUidMapDenied })),
    );
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as {
      platform: string;
      kernelRelease: string;
      capabilities: { kind: string; detail?: string }[];
      probe?: { ok: boolean; layer: string; detail?: string; cause?: string };
    };
    expect(parsed.platform).toBe("linux");
    expect(parsed.kernelRelease).toBe(TEST_KERNEL);
    expect(parsed.capabilities.length).toBe(4);
    // An agent reading this JSON must be able to see the probe outcome, not
    // just a prose sentence — `sandbox status` is an agent-facing input.
    expect(parsed.probe?.ok).toBe(false);
    expect(parsed.probe?.layer).toBe("bwrap");
    expect(parsed.probe?.detail).toBe(UID_MAP_FAILURE);
    expect(parsed.probe?.cause).toBe("unprivileged-userns-denied");
    expect(parsed.capabilities.some((c) => c.kind === "unavailable")).toBe(true);
  });

  test("bare `sandbox` with no subcommand runs the same report as `sandbox status`", async () => {
    const options = deps({ ...darwinWithSeatbelt, probe: probeContained });
    const bare = await runCaptured(() => sandboxCommand([], options));
    const explicit = await runCaptured(() => sandboxCommand(["status"], options));
    expect(bare).toEqual(explicit);
  });

  test("an unknown subcommand exits non-zero and does not silently run the report", async () => {
    // Unlike the AC2 tests above, this path (a genuine argument error) IS
    // supposed to set a nonzero exit code — that is what is under test here,
    // so the global has to be mutated to observe it. `before` is captured so
    // the restore below puts back exactly what was there, not a guess.
    //
    // Deps are injected even though argument validation returns before the
    // report is ever built: relying on that ordering would mean this test
    // spawns a real launcher the day the ordering changes.
    const before = process.exitCode;
    try {
      const lines = await runCaptured(() =>
        sandboxCommand(["frobnicate"], deps({ ...linuxWithoutBwrap, probe: probeContained })),
      );
      expect(process.exitCode).toBe(1);
      expect(lines.join("\n")).not.toContain("Platform:");
    } finally {
      // Node/Bun quirk: `process.exitCode = undefined` does NOT clear a
      // previously-set numeric exit code (the setter no-ops on a non-number) —
      // only assigning an explicit number does. So when `before` was
      // `undefined`, restoring it verbatim would silently fail to undo the
      // `1` this test just caused, leaking a failing exit code into whatever
      // runs after this file in a shared `bun test` process (the same class
      // of bug the AC2 tests above were rewritten to avoid). `0` is the
      // faithful restoration of "no exit code was explicitly set" — it is
      // the value that produces the same (successful) process exit as
      // `undefined` does.
      process.exitCode = before ?? 0;
    }
  });
});

// flow 142 (P4) — `keryx sandbox status` — extended by keryx-linux-containment
// step 1 (R4, R6, R8 / AC6, AC13).
//
// AC2: report, not a gate — exits zero regardless of what it finds.
// AC3: "launcher not installed" and "not implemented on this platform" are
// different sentences, asserted to both exist and to never collapse into one
// another for the same row.
// AC6: no capability reads as available unless a probe confirmed it on this
// host, and a Linux `unavailable` row names the KERNEL, not the platform string.
// AC6 (flow 142) covered separately by src/standard/command-registry.test.ts /
// command-registry.coverage.test.ts (registration + routing).
//
// Every case injects `spawn` and `kernelRelease` alongside `existsSync`, so no
// test in this file launches a sandbox or reads this machine's kernel — the
// report is deterministic and offline. `cacheProbe: false` opts out of the
// once-per-process cache, which exists for production, not for a test file that
// needs several outcomes (the cache itself is asserted in probe.test.ts / AC5).

import { describe, expect, test } from "bun:test";
import {
  buildSandboxReport,
  renderSandboxReport,
  sandboxCommand,
  LAUNCHER_NOT_INSTALLED,
  NOT_IMPLEMENTED_ON_PLATFORM,
  PROBED_AND_NOT_WORKING,
  type SandboxCapabilityReportRow,
  type SandboxCommandDeps,
} from "./sandbox";
import type { ProbeSpawn } from "../harness/process/sandbox/probe";

/** The exact failure measured on Ubuntu 24.04 with no AppArmor profile for bwrap. */
const UID_MAP_FAILURE = "bwrap: setting up uid map: Permission denied";
const TEST_KERNEL = "6.8.0-136-generic";

const spawnContained: ProbeSpawn = () => ({ status: 0, stderr: "" });
const spawnUidMapDenied: ProbeSpawn = () => ({ status: 1, stderr: `${UID_MAP_FAILURE}\n` });

/** Deps that never touch the real filesystem, kernel, or a launcher. */
function deps(overrides: SandboxCommandDeps): SandboxCommandDeps {
  return {
    kernelRelease: () => TEST_KERNEL,
    cacheProbe: false,
    ...overrides,
  };
}

const linuxWithBwrap = { platform: "linux", env: { PATH: "/usr/bin" }, existsSync: (p: string) => p === "/usr/bin/bwrap" };
const linuxWithoutBwrap = { platform: "linux", env: { PATH: "/usr/bin" }, existsSync: () => false };

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
    const report = buildSandboxReport(deps({ ...linuxWithBwrap, spawn: spawnContained }));
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
    const report = buildSandboxReport(deps({ ...linuxWithBwrap, spawn: spawnUidMapDenied }));

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
    const report = buildSandboxReport(deps({ ...linuxWithBwrap, spawn: spawnUidMapDenied }));
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
      deps({ ...linuxWithBwrap, spawn: spawnUidMapDenied, kernelRelease: () => "5.15.0-generic" }),
    );
    const reason = byCapability(report.capabilities)["Filesystem containment"]!.reason ?? "";
    expect(reason).toContain("5.15.0-generic");
    expect(reason).not.toContain(TEST_KERNEL);
  });

  test("AC3: linux without bwrap — launcher-missing, never the not-implemented sentence, and NO probe is run", () => {
    const spawns: number[] = [];
    const countingSpawn: ProbeSpawn = () => {
      spawns.push(1);
      return { status: 0, stderr: "" };
    };
    const report = buildSandboxReport(deps({ ...linuxWithoutBwrap, spawn: countingSpawn }));

    expect(report.launcher.available).toBe(false);
    // N4: never probe on a path that is not reporting capability. There is no
    // launcher to trial, so nothing is spawned to learn what is already known.
    expect(spawns.length).toBe(0);
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

  test("the three negative findings are three different sentences, never interchangeable", () => {
    const missing = buildSandboxReport(deps({ ...linuxWithoutBwrap, spawn: spawnContained }));
    const broken = buildSandboxReport(deps({ ...linuxWithBwrap, spawn: spawnUidMapDenied }));

    const missingRow = byCapability(missing.capabilities)["Filesystem containment"]!;
    const brokenRow = byCapability(broken.capabilities)["Filesystem containment"]!;
    const unimplemented = byCapability(missing.capabilities)["Domain allowlist"]!;

    const sentences = [missingRow.status, brokenRow.status, unimplemented.status];
    expect(new Set(sentences).size).toBe(3);
    // And each says its own thing and not the others'.
    expect(brokenRow.status).not.toContain(LAUNCHER_NOT_INSTALLED);
    expect(brokenRow.status).not.toContain(NOT_IMPLEMENTED_ON_PLATFORM);
  });

  test("darwin, sandbox-exec present and probing clean: every implemented capability available", () => {
    const report = buildSandboxReport(
      deps({ platform: "darwin", existsSync: (p: string) => p === "/usr/bin/sandbox-exec", spawn: spawnContained }),
    );
    expect(report.launcher.available).toBe(true);
    expect(report.capabilities.every((c) => c.kind === "available")).toBe(true);
  });

  test("N5: darwin with a failing probe reports unavailable — macOS is measured too, not assumed", () => {
    const report = buildSandboxReport(
      deps({
        platform: "darwin",
        existsSync: (p: string) => p === "/usr/bin/sandbox-exec",
        spawn: () => ({ status: 1, stderr: "sandbox-exec: sandbox_apply: Operation not permitted" }),
      }),
    );
    expect(report.capabilities.every((c) => c.kind === "unavailable")).toBe(true);
    // No kernel-facility wording on macOS: the Linux phrasing would be a
    // borrowed explanation, which is a species of the defect being fixed.
    const reason = report.capabilities[0]!.reason ?? "";
    expect(reason).not.toContain("unprivileged user namespaces");
  });

  test("darwin without sandbox-exec: every capability is launcher-missing, none say not-implemented", () => {
    const report = buildSandboxReport(deps({ platform: "darwin", existsSync: () => false, spawn: spawnContained }));
    expect(report.launcher.available).toBe(false);
    for (const cap of report.capabilities) {
      expect(cap.kind).toBe("launcher-missing");
      expect(cap.status).toContain(LAUNCHER_NOT_INSTALLED);
    }
  });

  test("unsupported platform: everything is not-implemented, nothing is probed", () => {
    const spawns: number[] = [];
    const report = buildSandboxReport(
      deps({
        platform: "win32",
        spawn: () => {
          spawns.push(1);
          return { status: 0, stderr: "" };
        },
      }),
    );
    expect(spawns.length).toBe(0);
    for (const cap of report.capabilities) {
      expect(cap.kind).toBe("not-implemented");
      expect(cap.status).not.toContain(LAUNCHER_NOT_INSTALLED);
    }
  });
});

describe("renderSandboxReport", () => {
  test("renders platform, launcher, and every capability row", () => {
    const report = buildSandboxReport(deps({ ...linuxWithoutBwrap, spawn: spawnContained }));
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
    const text = renderSandboxReport(buildSandboxReport(deps({ ...linuxWithBwrap, spawn: spawnUidMapDenied })));

    expect(text).toContain("Containment probe: FAILED");
    expect(text).toContain("OS containment is unavailable");
    // The launcher's own words, on their own line, attributed to the launcher.
    expect(text).toContain(UID_MAP_FAILURE);
    expect(text).toContain("bwrap said:");
    expect(text).toContain("Remediation:");
    expect(text).toContain("/etc/apparmor.d/bwrap");
    // The word that was the defect.
    expect(text).not.toMatch(/containment and network-off are available/i);
  });

  test("AC6: a clean probe is stated as a measurement, and names the layer", () => {
    const text = renderSandboxReport(buildSandboxReport(deps({ ...linuxWithBwrap, spawn: spawnContained })));
    expect(text).toContain("Containment probe: OK");
    expect(text).toContain("under bwrap");
    expect(text).toContain("confirmed by a trial contained command on this host");
    expect(text).not.toContain("FAILED");
  });

  test("R6: the kernel release is named in the header on Linux", () => {
    const text = renderSandboxReport(buildSandboxReport(deps({ ...linuxWithBwrap, spawn: spawnUidMapDenied })));
    expect(text).toContain(`Platform: linux (kernel ${TEST_KERNEL})`);
  });

  test("no launcher: says containment is unavailable and how to install it, and never quotes a probe", () => {
    const text = renderSandboxReport(buildSandboxReport(deps({ ...linuxWithoutBwrap, spawn: spawnContained })));
    expect(text).toContain("Containment probe: not run");
    expect(text).toContain("OS containment is unavailable");
    expect(text).toMatch(/install it:.*bubblewrap/i);
  });

  test("AC13: no rendering path names the machine-wide sysctl, in any state", () => {
    // ADR-0010 rejected `sysctl kernel.apparmor_restrict_unprivileged_userns=0`
    // outright and the advice was deleted from the docs. This asserts it cannot
    // creep back through the one surface a user actually reads.
    const states = [
      buildSandboxReport(deps({ ...linuxWithBwrap, spawn: spawnUidMapDenied })),
      buildSandboxReport(deps({ ...linuxWithBwrap, spawn: spawnContained })),
      buildSandboxReport(deps({ ...linuxWithoutBwrap, spawn: spawnContained })),
      buildSandboxReport(deps({ platform: "win32" })),
    ];
    for (const report of states) {
      const text = renderSandboxReport(report);
      expect(text).not.toContain("apparmor_restrict_unprivileged_userns");
      expect(text).not.toContain("sysctl");
    }
  });
});

const SANDBOX_MATRIX_LABELS = ["Filesystem containment", "Network OFF", "Domain allowlist", "Credential masking"];

describe("sandboxCommand — AC2: report, not a gate", () => {
  // These two assert AC2's actual claim — the command does not change the
  // exit code at all, in either direction — rather than the identity of the
  // sentinel `undefined`. That distinction matters under `bun test`'s
  // full-suite run (what CI runs): every file shares one process, so whatever
  // `process.exitCode` already is when this test starts is not under this
  // file's control, and a runtime is free to normalise an `undefined`
  // assignment to `0` anyway. Snapshotting the value beforehand and asserting
  // it is unchanged afterward holds regardless of what it started as, and
  // — because it never assigns to `process.exitCode` itself — there is
  // nothing here to restore or leak into whatever test file runs next.
  test("never sets process.exitCode, even when the launcher is missing", async () => {
    const before = process.exitCode;
    await sandboxCommand([], deps({ ...linuxWithoutBwrap, spawn: spawnContained }));
    expect(process.exitCode).toBe(before);
  });

  test("never sets process.exitCode when the probe FAILS either — a broken boundary is still a report", async () => {
    const before = process.exitCode;
    await sandboxCommand(["status"], deps({ ...linuxWithBwrap, spawn: spawnUidMapDenied }));
    expect(process.exitCode).toBe(before);
  });

  test("never sets process.exitCode on an unsupported platform either", async () => {
    const before = process.exitCode;
    await sandboxCommand(["status"], deps({ platform: "win32" }));
    expect(process.exitCode).toBe(before);
  });

  test("--json prints valid, parseable JSON with the platform, probe and capabilities", async () => {
    const lines = await runCaptured(() =>
      sandboxCommand(["status", "--json"], deps({ ...linuxWithBwrap, spawn: spawnUidMapDenied })),
    );
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as {
      platform: string;
      capabilities: { kind: string; detail?: string }[];
      probe?: { ok: boolean; layer: string; detail?: string };
    };
    expect(parsed.platform).toBe("linux");
    expect(parsed.capabilities.length).toBe(4);
    // An agent reading this JSON must be able to see the probe outcome, not
    // just a prose sentence — `sandbox status` is an agent-facing input.
    expect(parsed.probe?.ok).toBe(false);
    expect(parsed.probe?.layer).toBe("bwrap");
    expect(parsed.probe?.detail).toBe(UID_MAP_FAILURE);
    expect(parsed.capabilities.some((c) => c.kind === "unavailable")).toBe(true);
  });

  test("bare `sandbox` with no subcommand runs the same report as `sandbox status`", async () => {
    const options = deps({ platform: "darwin", existsSync: () => true, spawn: spawnContained });
    const bare = await runCaptured(() => sandboxCommand([], options));
    const explicit = await runCaptured(() => sandboxCommand(["status"], options));
    expect(bare).toEqual(explicit);
  });

  test("an unknown subcommand exits non-zero and does not silently run the report", async () => {
    // Unlike the two AC2 tests above, this path (a genuine argument error) IS
    // supposed to set a nonzero exit code — that is what is under test here,
    // so the global has to be mutated to observe it. `before` is captured so
    // the restore below puts back exactly what was there, not a guess.
    const before = process.exitCode;
    try {
      const lines = await runCaptured(() => sandboxCommand(["frobnicate"]));
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

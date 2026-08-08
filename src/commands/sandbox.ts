// `keryx sandbox status` (flow 142, P4, AC2/AC3/AC6 — then keryx-linux-containment
// step 1, R4/R6/R8, AC6).
//
// Benchmark finding P4: filesystem containment and network-off are
// implemented on Linux and both need bubblewrap, and nothing — installer,
// CLI, or output — told a user whether it was present. This command answered
// that question on demand.
//
// It then answered it WRONGLY, in the way that matters most. "Present" was
// reported as "available": on Ubuntu 23.10+ bubblewrap installs cleanly and
// every contained run dies with `bwrap: setting up uid map: Permission denied`,
// and this command printed "available" throughout. A command that exists to
// stop keryx claiming untested capability was making exactly that claim.
//
// So availability is now a MEASUREMENT. `probe.ts` runs one trivial contained
// command through the real launcher wrapper and this command reports its
// outcome. No row reads `available` unless a probe confirmed it here, now.
//
// AC2 — a REPORT, not a gate: this command never sets `process.exitCode`.
// AC3 — the subtle part: "launcher not installed" (installing it would help)
// and "not implemented on this platform" (installing it would NOT help) are
// different findings and must read as different sentences. The probe adds a
// third: "installed, and it does not work here" — which is neither of the
// above, and which conflating with either would put the original defect back.

import {
  detectSandboxLauncher,
  type SandboxLauncherInfo,
} from "../harness/process/sandbox/detect";
import {
  SANDBOX_CAPABILITY_MATRIX,
  capabilityStatusFor,
  isKnownSandboxPlatform,
  linuxKernelUnavailableReason,
  type SandboxPlatform,
} from "../harness/process/sandbox/capability-matrix";
import {
  probeContainment,
  runContainmentProbe,
  type ProbeResult,
  type ProbeSpawn,
} from "../harness/process/sandbox/probe";
import { release as realKernelRelease } from "node:os";

export interface SandboxCommandDeps {
  env?: Record<string, string | undefined>;
  platform?: string;
  existsSync?: (p: string) => boolean;
  /**
   * Injected trial-containment spawn. Every unit test supplies one, so the test
   * suite never spawns a launcher — the same seam `existsSync` gives detection.
   */
  spawn?: ProbeSpawn;
  /** Injected `os.release()`; the Linux `unavailable` reason names it (R6). */
  kernelRelease?: () => string;
  /**
   * Use the process-global probe cache (N4: at most one probe per process).
   * Tests pass `false` so several outcomes can be exercised in one process.
   */
  cacheProbe?: boolean;
}

export type SandboxCapabilityKind =
  /** A probe confirmed it, on this host, in this process. */
  | "available"
  /** Implemented and the launcher is installed — and the trial run did not contain. */
  | "unavailable"
  /** Implemented, but the launcher is absent. Installing it may help. */
  | "launcher-missing"
  /** No code path on this platform. Installing anything would not help. */
  | "not-implemented";

export interface SandboxCapabilityReportRow {
  capability: string;
  flag?: string;
  kind: SandboxCapabilityKind;
  /** Human-readable status sentence. See AC3 comment above for why this is not one string for both kinds. */
  status: string;
  /** For `unavailable`: why, phrased with the kernel as the subject on Linux (R6). */
  reason?: string;
  /** For `unavailable`: the launcher's own stderr, verbatim. */
  detail?: string;
  /** For `unavailable`: what the user can do about it, where anything can be. */
  remediation?: string;
}

export interface SandboxReport {
  platform: string;
  /** `os.release()`. On Linux it is the kernel, not the platform, that decides (R6). */
  kernelRelease?: string;
  launcher: SandboxLauncherInfo;
  launcherName: string | undefined;
  /**
   * The trial containment run, or `undefined` when there was nothing to trial —
   * no launcher, or no launcher on this platform at all. N4: the probe is never
   * invoked on a path that is not reporting capability.
   */
  probe?: ProbeResult;
  capabilities: SandboxCapabilityReportRow[];
}

const LAUNCHER_NAME: Record<SandboxPlatform, string> = {
  linux: "bubblewrap (bwrap)",
  darwin: "Seatbelt (sandbox-exec)",
};

/** The literal sentence fragment AC3's test pins for "launcher absent, would help". */
export const LAUNCHER_NOT_INSTALLED = "launcher not installed";
/** The literal sentence fragment AC3's test pins for "absent by design, installing would not help". */
export const NOT_IMPLEMENTED_ON_PLATFORM = "not implemented on this platform";
/**
 * The literal sentence fragment for the third finding: installed, probed, did
 * not contain. Pinned as its own constant because the whole point is that it is
 * neither of the two above.
 */
export const PROBED_AND_NOT_WORKING = "installed but NOT working on this host";
/**
 * The sentence a capability gets only after a trial run confirmed it. The word
 * "available" appears in exactly one place in this module, and this is it.
 */
export const PROBE_CONFIRMED = "available — confirmed by a trial contained command on this host.";
/** The installer's headline for "no containment here". `install-global.test.ts` pins it. */
export const CONTAINMENT_UNAVAILABLE_HEADLINE = "OS containment is unavailable";

/**
 * Build the report.
 *
 * Impure in exactly two places, both injected: `detectSandboxLauncher`'s
 * filesystem check, and the probe's one trial spawn. The probe runs only where
 * a capability is actually being reported on — an absent launcher and an
 * unsupported platform spawn nothing.
 */
export function buildSandboxReport(deps: SandboxCommandDeps = {}): SandboxReport {
  const info = detectSandboxLauncher(deps);
  const platform = info.platform;
  const known = isKnownSandboxPlatform(platform);
  const kernelRelease = (deps.kernelRelease ?? realKernelRelease)();

  // N4 — nothing to trial: no launcher to run, or no launcher exists for this
  // platform at all. Probing here would spawn to learn something already known.
  const probe: ProbeResult | undefined =
    known && info.available
      ? runProbe(deps, platform, info.path)
      : undefined;

  const makeRow = (
    row: (typeof SANDBOX_CAPABILITY_MATRIX)[number],
    kind: SandboxCapabilityKind,
    status: string,
    extra: { reason?: string; detail?: string; remediation?: string } = {},
  ): SandboxCapabilityReportRow => ({
    capability: row.capability,
    kind,
    status,
    // `exactOptionalPropertyTypes` treats `flag: undefined` as distinct from
    // the key being absent — spread conditionally rather than always setting it.
    ...(row.flag !== undefined ? { flag: row.flag } : {}),
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
    ...(extra.remediation !== undefined ? { remediation: extra.remediation } : {}),
  });

  const capabilities: SandboxCapabilityReportRow[] = SANDBOX_CAPABILITY_MATRIX.map((row) => {
    if (!known) {
      return makeRow(
        row,
        "not-implemented",
        `${NOT_IMPLEMENTED_ON_PLATFORM} ("${platform}") — the OS sandbox has no support for this platform at all.`,
      );
    }

    const status = capabilityStatusFor(row, platform);
    if (status === "not-implemented") {
      return makeRow(
        row,
        "not-implemented",
        `${NOT_IMPLEMENTED_ON_PLATFORM} — installing the OS sandbox launcher would not change this.`,
      );
    }

    if (!info.available) {
      return makeRow(row, "launcher-missing", `requires ${LAUNCHER_NAME[platform]}; ${LAUNCHER_NOT_INSTALLED}.`);
    }

    // The launcher is installed. That used to end the question; it is now where
    // the question starts.
    if (probe === undefined || !probe.ok) {
      const reason =
        platform === "linux"
          ? linuxKernelUnavailableReason(row.linuxKernelFacility, kernelRelease)
          : "a trial contained command was run on this host and it did not contain";
      return makeRow(row, "unavailable", `${PROBED_AND_NOT_WORKING} — ${reason}.`, {
        reason,
        ...(probe?.detail !== undefined ? { detail: probe.detail } : {}),
        ...(probe?.remediation !== undefined ? { remediation: probe.remediation } : {}),
      });
    }

    return makeRow(row, "available", PROBE_CONFIRMED);
  });

  return {
    platform,
    kernelRelease,
    launcher: info,
    launcherName: known ? LAUNCHER_NAME[platform] : undefined,
    ...(probe !== undefined ? { probe } : {}),
    capabilities,
  };
}

function runProbe(deps: SandboxCommandDeps, platform: string, launcherPath: string | undefined): ProbeResult {
  const opts = {
    platform,
    ...(launcherPath !== undefined ? { launcherPath } : {}),
    ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
  };
  // Default: the cached, once-per-process probe (N4). Only tests opt out, so
  // that one process can exercise several outcomes; no production caller sets
  // `cacheProbe`.
  return deps.cacheProbe === false ? runContainmentProbe(opts) : probeContainment(opts);
}

/** Human-readable rendering for `keryx sandbox status` (no `--json`). */
export function renderSandboxReport(report: SandboxReport): string {
  const lines: string[] = [];
  lines.push("keryx sandbox status");
  lines.push("");
  lines.push(
    report.platform === "linux" && report.kernelRelease
      ? // R6: on Linux the kernel decides, so the kernel is named up front and
        // not buried in a per-row reason.
        `Platform: ${report.platform} (kernel ${report.kernelRelease})`
      : `Platform: ${report.platform}`,
  );

  if (report.launcher.available) {
    lines.push(`Launcher: installed (${report.launcherName ?? "unknown"}${report.launcher.path ? ` at ${report.launcher.path}` : ""})`);
  } else {
    lines.push(`Launcher: not found${report.launcherName ? ` (${report.launcherName})` : ""} — ${report.launcher.reason ?? "unavailable"}`);
  }

  lines.push(...renderProbe(report));

  lines.push("");
  lines.push("Capability matrix (this host):");
  for (const cap of report.capabilities) {
    const flagNote = cap.flag ? ` (${cap.flag})` : "";
    lines.push(`  - ${cap.capability}${flagNote}: ${cap.status}`);
  }
  lines.push("");
  lines.push(
    "This is a report, not a gate — it always exits 0. A contained run still fails closed " +
      "regardless of what this prints; nothing here changes that behaviour.",
  );
  return lines.join("\n");
}

function renderProbe(report: SandboxReport): string[] {
  const lines: string[] = [];

  if (report.probe === undefined) {
    // No launcher to trial. Say what is missing and how to get it — and say
    // that containment is unavailable, because it is.
    lines.push(`Containment probe: not run — ${CONTAINMENT_UNAVAILABLE_HEADLINE} on this host.`);
    if (report.platform === "linux") {
      lines.push(
        "  Install it: apt install bubblewrap (Debian/Ubuntu) | dnf install bubblewrap (Fedora) | pacman -S bubblewrap (Arch)",
      );
    }
    return lines;
  }

  if (report.probe.ok) {
    lines.push(`Containment probe: OK — a trial contained command ran under ${report.probe.layer} and was contained.`);
    return lines;
  }

  lines.push(
    `Containment probe: FAILED — ${CONTAINMENT_UNAVAILABLE_HEADLINE} on this host. ` +
      `The launcher is installed and a trial contained command did not contain.`,
  );
  if (report.probe.detail) {
    // Verbatim, and labelled as the launcher's words rather than keryx's. This
    // is the evidence (spec §6): `bwrap: setting up uid map: Permission denied`
    // is a better diagnostic than any sentence keryx could compose, and it is
    // what the remediation below is keyed on.
    lines.push(`  ${report.probe.layer} said:`);
    for (const line of report.probe.detail.split("\n")) {
      lines.push(`    ${line}`);
    }
  }
  if (report.probe.remediation) {
    lines.push(`  Remediation: ${report.probe.remediation}`);
  }
  return lines;
}

function printHelp(): void {
  console.log(`keryx sandbox status [--json] — OS sandbox containment, measured on this host

Usage:
  keryx sandbox status [--json]

Runs ONE trivial contained command through the real launcher and reports what
happened, then renders the per-capability containment matrix against that
result. A capability is never reported available on the strength of a binary
existing on PATH — on Ubuntu 23.10+ bubblewrap installs cleanly and contains
nothing, which is the defect this command was corrected for.

Each capability reads as exactly one of: available (a probe confirmed it here),
installed but not working on this host (with the launcher's own error and the
remediation), launcher not installed (installing it may help), or not
implemented on this platform (installing anything would not help). Those are
different findings and are never worded the same way.

This command always exits 0: it is a report, not a gate. Installation prints
the same report once, up front, from this same source.
`);
}

export async function sandboxCommand(args: string[] = [], deps: SandboxCommandDeps = {}): Promise<void> {
  const subcommand = args[0];

  if (subcommand === "--help" || subcommand === "-h") {
    printHelp();
    return;
  }

  // `status` is the only subcommand today; bare `keryx sandbox` runs it too so
  // the common case needs no extra word, matching `keryx dash` aliasing
  // `dashboard open`.
  if (subcommand !== undefined && subcommand !== "status" && subcommand !== "--json") {
    console.error(`Unknown sandbox command: ${subcommand}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const json = args.includes("--json");
  const report = buildSandboxReport(deps);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderSandboxReport(report));
  }
  // AC2: report, not a gate. Deliberately never touches process.exitCode here.
}

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
// command through the real platform dispatcher and this command reports its
// outcome. No row reads `available` unless a probe confirmed it here, now.
//
// AC2 — a REPORT, not a gate: this command never sets `process.exitCode`.
// AC3 — the subtle part: four findings that must never be worded the same way,
// because installing something helps in exactly one of them:
//   available          a probe confirmed it here
//   unprobed           implemented, launcher works, this trial did not cover it
//   unavailable        implemented, launcher installed, and it did not contain
//   launcher-missing   implemented, nothing installed to run it
//   not-implemented    no code path on this platform, ever
// Conflating any two of these puts the original defect back in a new place.

import { release as realKernelRelease } from "node:os";
import {
  detectSandboxLauncher,
  probeContainment,
  SANDBOX_CAPABILITY_MATRIX,
  capabilityStatusFor,
  isKnownSandboxPlatform,
  linuxKernelFacilityClause,
  type ProbeOptions,
  type ProbeResult,
  type SandboxCapabilityRow,
  type SandboxLauncherInfo,
  type SandboxPlatform,
} from "../harness/process/sandbox";

/** Runs the trial containment. Injected so tests never spawn a launcher. */
export type ProbeRunner = (opts: ProbeOptions) => ProbeResult;

/**
 * The runner production uses: the cached, once-per-process probe (N4).
 *
 * Exported so a test can pin the production wiring by identity. AC5 itself is
 * proven against `probeContainment` in `probe.test.ts`; what this constant lets
 * a test assert is that `sandbox status` is wired to the CACHED entry point and
 * not the uncached one — the composition step that a `cacheProbe: boolean` flag
 * previously hid, and that no test could reach.
 */
export const DEFAULT_PROBE_RUNNER: ProbeRunner = probeContainment;

export interface SandboxCommandDeps {
  env?: Record<string, string | undefined>;
  platform?: string;
  existsSync?: (p: string) => boolean;
  /**
   * Injected trial containment. Every unit test supplies one — the same seam
   * `existsSync` gives detection, and the same shape as `kernelRelease`.
   */
  probe?: ProbeRunner;
  /** Injected `os.release()`; the Linux `unavailable` reason names it (R6). */
  kernelRelease?: () => string;
}

export type SandboxCapabilityKind =
  /** A probe confirmed it, on this host, in this process. */
  | "available"
  /** Implemented and the launcher works — but this trial did not exercise it. */
  | "unprobed"
  /** Implemented and the launcher is installed — and the trial did not contain. */
  | "unavailable"
  /** Implemented, but the launcher is absent. Installing it may help. */
  | "launcher-missing"
  /** No code path on this platform. Installing anything would not help. */
  | "not-implemented";

export interface SandboxCapabilityReportRow {
  capability: string;
  flag?: string;
  kind: SandboxCapabilityKind;
  /** Human-readable status sentence. See AC3 comment above for why this is not one string for several kinds. */
  status: string;
  /** For `unavailable`: why, phrased with the kernel as the subject on Linux (R6). */
  reason?: string;
  /** For `unavailable`: the launcher's own stderr, verbatim. */
  detail?: string;
  /** For `unavailable`: what the user can do about it, when the probe identified a cause. */
  remediation?: string;
}

export interface SandboxReport {
  platform: string;
  /** `os.release()`. On Linux it is the kernel, not the platform, that decides (R6). */
  kernelRelease: string;
  launcher: SandboxLauncherInfo;
  launcherName: string | undefined;
  /**
   * The trial containment run, or absent when there was nothing to trial — no
   * launcher, or no launcher on this platform at all. N4: the probe is never
   * invoked on a path that is not reporting capability.
   */
  probe?: ProbeResult;
  capabilities: SandboxCapabilityReportRow[];
}

const LAUNCHER_NAME: Record<SandboxPlatform, string> = {
  linux: "bubblewrap (bwrap)",
  darwin: "Seatbelt (sandbox-exec)",
};

// The pinned sentence fragments. All are bare fragments without terminal
// punctuation, so every composition site supplies its own — a constant that
// carried its own full stop meant callers had to remember which ones did.

/** AC3's fragment for "launcher absent, installing it would help". */
export const LAUNCHER_NOT_INSTALLED = "launcher not installed";
/** AC3's fragment for "absent by design, installing would not help". */
export const NOT_IMPLEMENTED_ON_PLATFORM = "not implemented on this platform";
/** The fragment for "installed, probed, did not contain" — neither of the two above. */
export const PROBED_AND_NOT_WORKING = "installed but NOT working on this host";
/** The fragment a capability gets only after a trial run confirmed it. */
export const PROBE_CONFIRMED = "available — confirmed by a trial contained command on this host";
/** The fragment for "the launcher works, but this trial proved nothing about THIS capability". */
export const NOT_COVERED_BY_PROBE = "implemented, and NOT covered by this probe";
/** The installer's headline for "no containment here". `install-global.test.ts` pins it. */
export const CONTAINMENT_UNAVAILABLE_HEADLINE = "OS containment is unavailable";

/** Drop keys whose value is undefined — `exactOptionalPropertyTypes` treats those as present. */
function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function makeRow(
  row: SandboxCapabilityRow,
  kind: SandboxCapabilityKind,
  status: string,
  extra: { reason?: string; detail?: string; remediation?: string } = {},
): SandboxCapabilityReportRow {
  return definedOnly({
    capability: row.capability,
    kind,
    status,
    flag: row.flag,
    reason: extra.reason,
    detail: extra.detail,
    remediation: extra.remediation,
  });
}

/** Everything the per-row decision needs, gathered once. */
interface CapabilityContext {
  platform: string;
  known: boolean;
  launcherInstalled: boolean;
  kernelRelease: string;
  probe: ProbeResult | undefined;
}

/**
 * Decide one row's finding. The order is the whole contract: a question that is
 * already settled by the platform is never re-asked of the launcher, and a
 * question already settled by the launcher is never re-asked of the probe.
 */
function describeCapability(row: SandboxCapabilityRow, ctx: CapabilityContext): SandboxCapabilityReportRow {
  if (!ctx.known) {
    return makeRow(
      row,
      "not-implemented",
      `${NOT_IMPLEMENTED_ON_PLATFORM} ("${ctx.platform}") — the OS sandbox has no support for this platform at all.`,
    );
  }

  if (capabilityStatusFor(row, ctx.platform as SandboxPlatform) === "not-implemented") {
    return makeRow(
      row,
      "not-implemented",
      `${NOT_IMPLEMENTED_ON_PLATFORM} — installing the OS sandbox launcher would not change this.`,
    );
  }

  if (!ctx.launcherInstalled) {
    return makeRow(
      row,
      "launcher-missing",
      `requires ${LAUNCHER_NAME[ctx.platform as SandboxPlatform]}; ${LAUNCHER_NOT_INSTALLED}.`,
    );
  }

  // The launcher is installed. That used to end the question; it is now where
  // the question starts. `probe` is always defined here — the caller only
  // probes on this path — and the type says so, so an unevidenced failure claim
  // cannot be expressed.
  const probe = ctx.probe;
  if (probe === undefined || !probe.ok) {
    const reason = unavailableReason(row, ctx, probe);
    return makeRow(row, "unavailable", `${PROBED_AND_NOT_WORKING} — ${reason}.`, {
      reason,
      detail: probe?.detail,
      remediation: probe?.remediation,
    });
  }

  // The trial contained. That is evidence about what the trial exercised, and
  // about nothing else.
  if (!row.coveredByProbe) {
    return makeRow(
      row,
      "unprobed",
      `${NOT_COVERED_BY_PROBE} — the trial run confirmed the launcher, not this capability.`,
    );
  }

  return makeRow(row, "available", `${PROBE_CONFIRMED}.`);
}

/**
 * Why an implemented capability is `unavailable` here.
 *
 * On Linux the kernel is the subject (R6) — but only when the probe actually
 * identified a kernel cause. A mount error or a missing binary is not a
 * user-namespace denial, and naming one as the reason would be a diagnosis
 * nobody made, which is the defect this package removes.
 */
function unavailableReason(
  row: SandboxCapabilityRow,
  ctx: CapabilityContext,
  probe: ProbeResult | undefined,
): string {
  const measured = "a trial contained command was run on this host and it did not contain";
  if (ctx.platform === "linux" && probe?.cause === "unprivileged-userns-denied") {
    return `${measured}: ${linuxKernelFacilityClause(row.linuxKernelFacility, ctx.kernelRelease)} were refused`;
  }
  return measured;
}

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
  const probe = known && info.available ? runProbe(deps, platform, info.path) : undefined;

  const ctx: CapabilityContext = {
    platform,
    known,
    launcherInstalled: info.available,
    kernelRelease,
    probe,
  };

  return definedOnly({
    platform,
    kernelRelease,
    launcher: info,
    launcherName: known ? LAUNCHER_NAME[platform] : undefined,
    probe,
    capabilities: SANDBOX_CAPABILITY_MATRIX.map((row) => describeCapability(row, ctx)),
  });
}

function runProbe(deps: SandboxCommandDeps, platform: string, launcherPath: string | undefined): ProbeResult {
  const run = deps.probe ?? DEFAULT_PROBE_RUNNER;
  return run(definedOnly({ platform, launcherPath }));
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
    lines.push(
      `Launcher: installed (${report.launcherName ?? "unknown"}${report.launcher.path ? ` at ${report.launcher.path}` : ""})`,
    );
  } else {
    lines.push(
      `Launcher: not found${report.launcherName ? ` (${report.launcherName})` : ""} — ${report.launcher.reason ?? "unavailable"}`,
    );
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
    // No launcher to trial. Say that containment is unavailable, because it is.
    // How to install the launcher is already on the `Launcher:` line above —
    // `detectSandboxLauncher`'s reason carries BWRAP_INSTALL_HINT, and printing
    // it twice was how the two wordings drifted apart in the first place.
    lines.push(`Containment probe: not run — ${CONTAINMENT_UNAVAILABLE_HEADLINE} on this host.`);
    return lines;
  }

  if (report.probe.ok) {
    lines.push(`Containment probe: OK — a trial contained command ran under ${report.probe.layer} and was contained.`);
    return lines;
  }

  lines.push(
    `Containment probe: FAILED — ${CONTAINMENT_UNAVAILABLE_HEADLINE} on this host. ` +
      "The launcher is installed and a trial contained command did not contain.",
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
  } else {
    // No remediation means the probe did not identify a cause it knows a fix
    // for. Saying nothing here is deliberate: a generic suggestion would be a
    // guess wearing the clothes of a diagnosis.
    lines.push("  keryx has no remediation keyed to that error — the launcher's own message above is the finding.");
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
not covered by this probe (the launcher works, the trial did not exercise this
capability), installed but not working on this host (with the launcher's own
error and, where the cause is known, the remediation), launcher not installed
(installing it may help), or not implemented on this platform (installing
anything would not help). Those are different findings and are never worded the
same way.

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

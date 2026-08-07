// `keryx sandbox status` (flow 142, P4, AC2/AC3/AC6).
//
// Benchmark finding P4: filesystem containment and network-off are
// implemented on Linux and both need bubblewrap, and nothing — installer,
// CLI, or output — told a user whether it was present. This command answers
// that question on demand, without spawning anything: it reuses the same
// detection `harness exec` already uses (`detectSandboxLauncher`, flow 093)
// and the shared capability matrix (`capability-matrix.ts`, AC4) so the
// answer here and the doc's table cannot drift apart.
//
// AC2 — a REPORT, not a gate: this command never sets `process.exitCode`.
// AC3 — the subtle part: "launcher not installed" (installing it would help)
// and "not implemented on this platform" (installing it would NOT help) are
// different findings and must read as different sentences. Conflating them —
// e.g. telling a Linux user without bwrap that `--allowed-domains` is simply
// "unavailable" — is exactly the ambiguity the benchmark flagged, reproduced
// in a new place.

import {
  detectSandboxLauncher,
  type SandboxLauncherInfo,
} from "../harness/process/sandbox/detect";
import {
  SANDBOX_CAPABILITY_MATRIX,
  capabilityStatusFor,
  isKnownSandboxPlatform,
  type SandboxPlatform,
} from "../harness/process/sandbox/capability-matrix";

export interface SandboxCommandDeps {
  env?: Record<string, string | undefined>;
  platform?: string;
  existsSync?: (p: string) => boolean;
}

export type SandboxCapabilityKind = "available" | "launcher-missing" | "not-implemented";

export interface SandboxCapabilityReportRow {
  capability: string;
  flag?: string;
  kind: SandboxCapabilityKind;
  /** Human-readable status sentence. See AC3 comment above for why this is not one string for both kinds. */
  status: string;
}

export interface SandboxReport {
  platform: string;
  launcher: SandboxLauncherInfo;
  launcherName: string | undefined;
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

/** Build the report. Pure aside from `detectSandboxLauncher`'s filesystem check — no spawn, ever. */
export function buildSandboxReport(deps: SandboxCommandDeps = {}): SandboxReport {
  const info = detectSandboxLauncher(deps);
  const platform = info.platform;
  const known = isKnownSandboxPlatform(platform);

  const makeRow = (
    row: (typeof SANDBOX_CAPABILITY_MATRIX)[number],
    kind: SandboxCapabilityKind,
    status: string,
  ): SandboxCapabilityReportRow => ({
    capability: row.capability,
    kind,
    status,
    // `exactOptionalPropertyTypes` treats `flag: undefined` as distinct from
    // the key being absent — spread conditionally rather than always setting it.
    ...(row.flag !== undefined ? { flag: row.flag } : {}),
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

    return makeRow(row, "available", "available.");
  });

  return {
    platform,
    launcher: info,
    launcherName: known ? LAUNCHER_NAME[platform] : undefined,
    capabilities,
  };
}

/** Human-readable rendering for `keryx sandbox status` (no `--json`). */
export function renderSandboxReport(report: SandboxReport): string {
  const lines: string[] = [];
  lines.push("keryx sandbox status");
  lines.push("");
  lines.push(`Platform: ${report.platform}`);
  if (report.launcher.available) {
    lines.push(`Launcher: available (${report.launcherName ?? "unknown"}${report.launcher.path ? ` at ${report.launcher.path}` : ""})`);
  } else {
    lines.push(`Launcher: not found${report.launcherName ? ` (${report.launcherName})` : ""} — ${report.launcher.reason ?? "unavailable"}`);
  }
  lines.push("");
  lines.push("Capability matrix (this platform):");
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

function printHelp(): void {
  console.log(`keryx sandbox status [--json] — OS sandbox launcher availability and the per-capability containment matrix

Usage:
  keryx sandbox status [--json]

Reports, for the current platform, whether the OS sandbox launcher (bubblewrap
on Linux, Seatbelt on macOS) is installed, and for each containment capability
(filesystem containment, network-off, domain allowlist, credential masking)
whether it is available, blocked only on the launcher being missing, or not
implemented on this platform at all — those are different findings and are
never worded the same way. This command never runs a contained command and
always exits 0: it is a report, not a gate. Run it any time; installation also
prints this same information once, up front.
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

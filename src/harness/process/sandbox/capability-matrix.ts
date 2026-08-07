// Single source of truth for the OS-sandbox per-capability matrix (flow 142,
// P4, AC4).
//
// Before this file, the matrix existed as two hand-typed Markdown tables —
// one in docs/verification/linux-sandbox-verification.md, one in
// docs/requirements/keryx-shell-remediation-v2/specification.md — with no
// mechanism keeping them in sync. `keryx sandbox status` (src/commands/sandbox.ts)
// renders FROM this module, and
// capability-matrix.doc-sync.test.ts parses the verification runbook's table
// and asserts it still says the same thing. Edit here first; the doc-sync
// test is what proves the runbook did not drift.
//
// Detection itself is NOT this module's job — see `detect.ts`. This module
// only answers "is capability X implemented on platform Y at all", which is a
// static fact independent of whether the launcher happens to be installed on
// the machine asking.

/** The two platforms the OS sandbox targets today. Anything else has no row. */
export type SandboxPlatform = "linux" | "darwin";

export type CapabilityStatus = "supported" | "not-implemented";

export interface SandboxCapabilityRow {
  /** Matches the verification doc's leftmost column (capability name, no flag). */
  capability: string;
  /** CLI flag this capability corresponds to, when it has one. */
  flag?: string;
  linux: CapabilityStatus;
  darwin: CapabilityStatus;
}

/**
 * The four rows from docs/verification/linux-sandbox-verification.md's
 * "Scope on Linux" table, § references stripped (those are doc-only
 * annotations, not part of the fact being recorded).
 */
export const SANDBOX_CAPABILITY_MATRIX: readonly SandboxCapabilityRow[] = [
  { capability: "Filesystem containment", linux: "supported", darwin: "supported" },
  { capability: "Network OFF", linux: "supported", darwin: "supported" },
  { capability: "Domain allowlist", flag: "--allowed-domains", linux: "not-implemented", darwin: "supported" },
  { capability: "Credential masking", flag: "--mask-env", linux: "not-implemented", darwin: "supported" },
];

/** Look up one row's status for a platform. */
export function capabilityStatusFor(row: SandboxCapabilityRow, platform: SandboxPlatform): CapabilityStatus {
  return platform === "linux" ? row.linux : row.darwin;
}

/**
 * The verification doc's cell text for a status — "yes" or the fails-closed
 * sentence — verbatim (minus the doc's `**bold**` markers, which are
 * presentation, not content). The doc-sync test compares against this, so
 * changing the wording here is changing the doc's contract, not just this
 * module's.
 */
export function statusCellText(status: CapabilityStatus): string {
  return status === "supported" ? "yes" : "not implemented — fails closed";
}

/** Is `platform` one this matrix has rows for at all? */
export function isKnownSandboxPlatform(platform: string): platform is SandboxPlatform {
  return platform === "linux" || platform === "darwin";
}

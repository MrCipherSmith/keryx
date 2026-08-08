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
//
// THE THIRD STATE (keryx-linux-containment, spec §5). Two states could not say
// the thing that mattered most: "implemented, and not functional on THIS
// host". On Ubuntu 23.10+ bubblewrap installs cleanly and every contained run
// dies, so `supported` was true as a statement about the codebase and false as
// a statement about the machine. `unavailable` is that third state. It is NOT
// stored in the table below — it is not static — it is produced by the probe
// (`probe.ts`) and composed at report time by `src/commands/sandbox.ts`. The
// table stays exactly what its heading says it is: a record of what is
// implemented. `sandbox status` must never present a static row as a host fact.

/** The two platforms the OS sandbox targets today. Anything else has no row. */
export type SandboxPlatform = "linux" | "darwin";

export type CapabilityStatus =
  /** Implemented, and a probe confirmed it on this host. */
  | "supported"
  /** No code path exists on this platform, ever. Installing anything is irrelevant. */
  | "not-implemented"
  /** Implemented, but not functional on THIS host. Carries a reason, and a remediation where one exists. */
  | "unavailable";

/**
 * Every `CapabilityStatus`, as a value. The doc-sync test iterates this so a
 * fourth state added to the type without a runbook entry fails a test rather
 * than shipping undocumented.
 */
export const CAPABILITY_STATUSES: readonly CapabilityStatus[] = [
  "supported",
  "not-implemented",
  "unavailable",
];

/**
 * The kernel facility a Linux row's containment actually rests on.
 *
 * R6: Linux capability reporting is keyed on the kernel, not on the string
 * `"linux"` — because on Linux it is the kernel that decides. bubblewrap builds
 * its boundary out of unprivileged user namespaces, which is precisely what
 * Ubuntu withdrew in 23.10; telling that user "unavailable on linux" names the
 * wrong thing entirely, and names something they cannot act on.
 *
 * Landlock's ABI joins this axis in step 3 without reshaping it.
 */
export type LinuxKernelFacility = "unprivileged-user-namespaces" | "none";

/** How each facility is named in output. Kept here so one wording serves every surface. */
export const LINUX_KERNEL_FACILITY_LABEL: Record<LinuxKernelFacility, string> = {
  "unprivileged-user-namespaces": "unprivileged user namespaces",
  none: "no kernel facility",
};

export interface SandboxCapabilityRow {
  /** Matches the verification doc's leftmost column (capability name, no flag). */
  capability: string;
  /** CLI flag this capability corresponds to, when it has one. */
  flag?: string;
  linux: CapabilityStatus;
  darwin: CapabilityStatus;
  /**
   * What the Linux side of this row needs FROM THE KERNEL (R6). `none` where the
   * row is not implemented on Linux at all — there is no facility to name,
   * because there is no code path to run.
   */
  linuxKernelFacility: LinuxKernelFacility;
}

/**
 * The four rows from docs/verification/linux-sandbox-verification.md's
 * "Scope on Linux" table, § references stripped (those are doc-only
 * annotations, not part of the fact being recorded).
 *
 * No row is ever `unavailable` here. That state is a fact about a host, and
 * this table is a fact about the codebase — see the module comment.
 */
export const SANDBOX_CAPABILITY_MATRIX: readonly SandboxCapabilityRow[] = [
  {
    capability: "Filesystem containment",
    linux: "supported",
    darwin: "supported",
    linuxKernelFacility: "unprivileged-user-namespaces",
  },
  {
    capability: "Network OFF",
    linux: "supported",
    darwin: "supported",
    linuxKernelFacility: "unprivileged-user-namespaces",
  },
  {
    capability: "Domain allowlist",
    flag: "--allowed-domains",
    linux: "not-implemented",
    darwin: "supported",
    linuxKernelFacility: "none",
  },
  {
    capability: "Credential masking",
    flag: "--mask-env",
    linux: "not-implemented",
    darwin: "supported",
    linuxKernelFacility: "none",
  },
];

/** Look up one row's status for a platform. */
export function capabilityStatusFor(row: SandboxCapabilityRow, platform: SandboxPlatform): CapabilityStatus {
  return platform === "linux" ? row.linux : row.darwin;
}

/**
 * The verification doc's cell text for a status, verbatim (minus the doc's
 * `**bold**` markers, which are presentation, not content). The doc-sync test
 * compares against this, so changing the wording here is changing the doc's
 * contract, not just this module's.
 *
 * `unavailable` has cell text even though no table cell ever holds it: the
 * runbook documents the three states in its own section, and the doc-sync test
 * pins that section against these strings so the third state cannot be
 * introduced in code and left undescribed for a reader following the runbook.
 */
export function statusCellText(status: CapabilityStatus): string {
  switch (status) {
    case "supported":
      return "yes";
    case "not-implemented":
      return "not implemented — fails closed";
    case "unavailable":
      return "implemented, but not functional on this host — fails closed";
  }
}

/** Is `platform` one this matrix has rows for at all? */
export function isKnownSandboxPlatform(platform: string): platform is SandboxPlatform {
  return platform === "linux" || platform === "darwin";
}

/**
 * Why an implemented Linux capability is `unavailable` on this host, phrased so
 * the KERNEL is the subject (R6, AC6).
 *
 * "Filesystem containment is unavailable on linux" is both wrong and useless:
 * it is not unavailable on Linux — it is unavailable on kernels configured to
 * withhold the facility it rests on, and the user can act on that. The kernel
 * release is included because it is the thing that differs between the host
 * where this works and the host where it does not.
 *
 * Pure: the release string is supplied by the caller (`os.release()`, injected),
 * never read here.
 */
export function linuxKernelUnavailableReason(
  facility: LinuxKernelFacility,
  kernelRelease: string | undefined,
): string {
  const release = kernelRelease !== undefined && kernelRelease.length > 0 ? kernelRelease : "unknown release";
  return (
    `this kernel (${release}) did not permit ${LINUX_KERNEL_FACILITY_LABEL[facility]}, ` +
    "which is what the launcher builds its boundary from — a trial contained command was run on this host and it did not contain"
  );
}

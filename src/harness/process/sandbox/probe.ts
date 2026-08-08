// Containment probe (keryx-linux-containment, step 1 — R4, spec §6).
//
// The defect this module exists to fix: `keryx sandbox status` and
// `scripts/install.sh` both decided whether OS containment worked by asking
// whether a binary was on PATH. On Ubuntu 23.10+ that answer is "yes" and
// containment does not work — `kernel.apparmor_restrict_unprivileged_userns=1`
// withdrew the unprivileged user namespaces bubblewrap builds its boundary
// from, so every contained run dies with
//
//   bwrap: setting up uid map: Permission denied
//
// while both surfaces printed "Filesystem containment and network-off are
// available." Presence of a mechanism is not a finding about containment.
//
// So: run one trivial contained command and report what actually happened.
//
// This is the ONLY impure module added by step 1. It spawns, so — exactly as
// `detect.ts` injects `existsSync` — the spawn is injectable and every unit
// test runs offline. N4 caps the cost: at most one probe per process, cached,
// and callers must never probe on a path that is not reporting capability (a
// normal contained run does not pre-probe; it runs and reports its own
// outcome).
//
// Landlock (`layer: "landlock"`) is part of the same contract but is NOT
// implemented here — it is step 3 of the implementation plan and depends on a
// separate `bun:ffi` spike. The layer name exists so the probe's shape does not
// change when it lands.

import { spawnSync as realSpawnSync } from "node:child_process";
import type { SandboxProfile } from "./profile";
import { wrapBwrap, BWRAP_PROGRAM } from "./bwrap";
import { wrapSeatbelt } from "./seatbelt";

/** The containment layers a probe can report on. `landlock` is reserved for step 3. */
export type SandboxLayer = "landlock" | "bwrap" | "seatbelt" | "none";

export interface ProbeResult {
  layer: SandboxLayer;
  ok: boolean;
  /** Verbatim launcher stderr when `ok === false` — this is the evidence. */
  detail?: string;
  remediation?: string;
}

/** What an injected spawn must return. A subset of `SpawnSyncReturns`. */
export interface ProbeSpawnResult {
  status: number | null;
  stderr?: string;
  /** Set when the launcher could not be executed at all (ENOENT, EACCES…). */
  error?: Error;
}

export type ProbeSpawn = (
  path: string,
  argv: string[],
  options: { cwd: string; timeoutMs: number },
) => ProbeSpawnResult;

export interface ProbeOptions {
  platform?: string;
  /** Absolute launcher path, as resolved by `detectSandboxLauncher`. */
  launcherPath?: string;
  /** Injected for tests; defaults to a real `spawnSync`. */
  spawn?: ProbeSpawn;
  /** Working directory for the trial run. Defaults to the process cwd. */
  cwd?: string;
}

/**
 * The trial command. `/bin/true`-class per spec §6: it must prove the launcher
 * can establish its boundary and exec, and nothing else. Anything heavier would
 * make the probe's failures ambiguous — a probe whose failure could mean either
 * "containment is broken" or "the trial command is broken" is not evidence.
 */
const TRIAL_PROGRAM = "/bin/true";
const DARWIN_TRIAL_PROGRAM = "/usr/bin/true";

/**
 * A launcher that cannot establish a boundary fails immediately; one that hangs
 * is also a failure, and an unbounded probe would hang `sandbox status` with it.
 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * The remediation for a bubblewrap probe failure.
 *
 * Deliberately NOT the machine-wide sysctl. `sysctl
 * kernel.apparmor_restrict_unprivileged_userns=0` disables the restriction for
 * every process on the machine to fix one program; ADR-0010 rejected it
 * outright and it was removed from the verification runbook and the operator
 * guide. It must not reappear here — `probe.sysctl.test.ts` asserts that.
 *
 * The profile below is the same shape Ubuntu ships for Chrome, Brave and ~40
 * other applications: the namespace is granted to `/usr/bin/bwrap` alone.
 */
export const BWRAP_APPARMOR_REMEDIATION =
  "grant the user namespace to /usr/bin/bwrap alone with an AppArmor profile at " +
  "/etc/apparmor.d/bwrap (the same shape Ubuntu ships for Chrome, Brave and ~40 other " +
  "applications), then reload it with `sudo apparmor_parser -r /etc/apparmor.d/bwrap`. " +
  "Full profile text: docs/verification/linux-sandbox-verification.md §1.";

/**
 * The profile the trial runs under: the strictest posture the probe can assert
 * without depending on anything about the host. No writable roots, no secrets
 * to mask, network off — so on Linux this exercises `--unshare-net` too, which
 * is the other half of what `sandbox status` reports as available.
 */
function trialProfile(): SandboxProfile {
  return {
    mode: "read-only",
    network: "off",
    writableRoots: [],
    readDenyList: [],
    allowedDomains: [],
    required: true,
  };
}

/**
 * Run one trial contained command and report what happened. **Uncached** — see
 * {@link probeContainment} for the cached entry point production uses. Exported
 * because tests need several outcomes in one process, which a process-global
 * cache by definition cannot give them.
 */
export function runContainmentProbe(opts: ProbeOptions = {}): ProbeResult {
  const platform = opts.platform ?? process.platform;
  const spawn = opts.spawn ?? defaultSpawn;
  const cwd = opts.cwd ?? process.cwd();
  const profile = trialProfile();

  if (platform === "linux") {
    // `wrapBwrap` — the same pure builder the product spawns through. A
    // hand-written argv here would probe a different boundary from the one
    // being reported on, which is the defect being fixed, in a new place.
    const launcherPath = opts.launcherPath ?? BWRAP_PROGRAM;
    const wrapped = wrapBwrap(
      { path: TRIAL_PROGRAM, argv: [TRIAL_PROGRAM], env: {}, cwd },
      profile,
      launcherPath,
    );
    return evaluate("bwrap", spawn(wrapped.path, wrapped.argv.slice(1), { cwd, timeoutMs: PROBE_TIMEOUT_MS }), {
      remediation: BWRAP_APPARMOR_REMEDIATION,
    });
  }

  if (platform === "darwin") {
    const wrapped = wrapSeatbelt(
      { path: DARWIN_TRIAL_PROGRAM, argv: [DARWIN_TRIAL_PROGRAM], env: {}, cwd },
      profile,
    );
    return evaluate("seatbelt", spawn(wrapped.path, wrapped.argv.slice(1), { cwd, timeoutMs: PROBE_TIMEOUT_MS }));
  }

  return {
    layer: "none",
    ok: false,
    detail: `the OS sandbox has no launcher on platform "${platform}"`,
  };
}

function evaluate(
  layer: SandboxLayer,
  result: ProbeSpawnResult,
  extra: { remediation?: string } = {},
): ProbeResult {
  if (result.error === undefined && result.status === 0) {
    // Success carries no `detail`: there is no evidence to quote, and an
    // explanatory sentence here would be keryx's words presented where the
    // launcher's words go.
    return { layer, ok: true };
  }

  // The launcher's own words. `bwrap: setting up uid map: Permission denied` is
  // a better diagnostic than any sentence keryx could compose, and it is what
  // the AppArmor remediation is keyed on (spec §6).
  const stderr = (result.stderr ?? "").trim();
  const detail =
    stderr.length > 0
      ? stderr
      : result.error !== undefined
        ? // The launcher could not be executed at all, so it has no words of its
          // own; the spawn error is the closest thing to evidence there is.
          result.error.message
        : `the launcher exited ${result.status ?? "with no status"} and wrote nothing to stderr`;

  return {
    layer,
    ok: false,
    detail,
    ...(extra.remediation !== undefined ? { remediation: extra.remediation } : {}),
  };
}

const defaultSpawn: ProbeSpawn = (path, argv, options) => {
  const result = realSpawnSync(path, argv, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    encoding: "utf8",
    // The trial writes nothing on success and its stderr IS the finding on
    // failure, so both streams are captured rather than inherited.
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
};

/**
 * The process-global probe slot. N4: "at most one probe per process, cached".
 *
 * Deliberately not keyed on the options — a per-options memo would satisfy the
 * letter of the cache and not the requirement, which is a bound on how many
 * contained commands `keryx sandbox status` may spawn. Tests that need several
 * outcomes call {@link runContainmentProbe} directly, or reset the slot.
 */
let cached: ProbeResult | undefined;

/** Probe containment, at most once per process (N4). */
export function probeContainment(opts: ProbeOptions = {}): ProbeResult {
  if (cached === undefined) {
    cached = runContainmentProbe(opts);
  }
  return cached;
}

/**
 * Clear the cached probe. **Test-only** — production has no reason to probe
 * twice, and a caller reaching for this in `src/` is describing a bug.
 */
export function resetContainmentProbeCacheForTests(): void {
  cached = undefined;
}

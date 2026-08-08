// Containment probe (keryx-linux-containment, step 1 — R4, spec §6).
//
// The defect this module exists to fix: `keryx sandbox status` and
// `scripts/install.sh` both decided whether OS containment worked by asking
// whether a binary was on PATH. On Ubuntu 23.10+ that answer is "yes" and
// containment does not work — the distribution withdrew the unprivileged user
// namespaces bubblewrap builds its boundary from, so every contained run dies
// with
//
//   bwrap: setting up uid map: Permission denied
//
// while both surfaces printed "Filesystem containment and network-off are
// available." Presence of a mechanism is not a finding about containment.
//
// So: run one trivial contained command and report what actually happened.
//
// This is the ONLY impure module in the sandbox package that spawns. It is
// therefore injectable — exactly as `detect.ts` injects `existsSync` — and
// every unit test runs offline. N4 caps the cost: at most one probe per
// process, cached, and callers must never probe on a path that is not
// reporting capability (a normal contained run does not pre-probe; it runs and
// reports its own outcome).
//
// Landlock (`layer: "landlock"`) is part of the same contract but is NOT
// implemented here — it is step 3 of the implementation plan and depends on a
// separate `bun:ffi` spike. The layer name exists so the probe's shape does not
// change when it lands.

import { spawnSync as realSpawnSync } from "node:child_process";
import type { ContainedCommand } from "../executor";
import type { SandboxProfile } from "./profile";
import { wrapWithSandbox } from "./wrap";

/** The containment layers a probe can report on. `landlock` is reserved for step 3. */
export type SandboxLayer = "landlock" | "bwrap" | "seatbelt" | "none";

/**
 * What the probe was able to conclude about WHY the trial failed.
 *
 * This exists because attaching a cause to every failure would repeat the
 * defect being fixed. A mount error, an ENOENT on the launcher and a timeout
 * are not user-namespace denials, and diagnosing them as one would send the
 * user to author an AppArmor profile that cannot help them.
 */
export type ProbeFailureCause =
  /** The launcher's own words identify a user-namespace / uid-map denial. */
  | "unprivileged-userns-denied"
  /** It failed, and the probe will not guess further than the launcher said. */
  | "unknown";

export interface ProbeResult {
  layer: SandboxLayer;
  ok: boolean;
  /** Verbatim launcher stderr when `ok === false` — this is the evidence. */
  detail?: string;
  /** Set only when `ok === false`. See {@link ProbeFailureCause}. */
  cause?: ProbeFailureCause;
  remediation?: string;
}

/** What an injected spawn must return. A subset of `SpawnSyncReturns`. */
export interface ProbeSpawnResult {
  status: number | null;
  stderr?: string;
  /** Set when the launcher could not be executed at all (ENOENT, EACCES…). */
  error?: Error;
}

export interface ProbeSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export type ProbeSpawn = (path: string, argv: string[], options: ProbeSpawnOptions) => ProbeSpawnResult;

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
 * is also a failure, and an unbounded probe would hang `sandbox status` — and,
 * through it, `scripts/install.sh` — with it.
 */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * Cap on quoted launcher output. The stderr is printed verbatim to a terminal,
 * into `--json`, and into installer/CI logs; `spawnSync` will hand us up to its
 * 1 MB buffer, and a launcher that floods it should not flood the operator.
 */
const MAX_DETAIL_CHARS = 4_000;

/**
 * The remediation for a bubblewrap probe failure **caused by a user-namespace
 * denial**. Not attached to any other failure — see {@link ProbeFailureCause}.
 *
 * Deliberately NOT the machine-wide sysctl. `sysctl
 * kernel.apparmor_restrict_unprivileged_userns=0` disables the restriction for
 * every process on the machine to fix one program; ADR-0010 rejected it
 * outright and it was removed from the verification runbook and the operator
 * guide. It must not reappear here — the "R8 / AC13" case in `probe.test.ts`
 * asserts that, as does the AC13 case in `src/commands/sandbox.test.ts`.
 *
 * The profile below is the same shape Ubuntu ships for Chrome, Brave and ~40
 * other applications: the namespace is granted to `/usr/bin/bwrap` alone.
 */
export const BWRAP_APPARMOR_REMEDIATION =
  "grant the user namespace to /usr/bin/bwrap alone with an AppArmor profile at " +
  "/etc/apparmor.d/bwrap (the same shape Ubuntu ships for Chrome, Brave and ~40 other " +
  "applications), then reload it with `sudo apparmor_parser -r /etc/apparmor.d/bwrap`. " +
  "The full profile text is under \"Prerequisites\" in docs/verification/linux-sandbox-verification.md.";

/**
 * Phrases in a launcher's own output that identify a user-namespace denial.
 *
 * Matching on the launcher's words rather than on the exit code is the point:
 * the remediation is only correct for this cause, and the probe would rather
 * say "it failed, here is what it said" than name a cause it did not observe.
 */
const USERNS_DENIAL_MARKERS = [
  // The measured Ubuntu 23.10+ failure.
  "setting up uid map",
  // bwrap's other phrasings for the same withdrawal.
  "creating new namespace",
  "create new namespace",
  "unshare",
  "user namespace",
  "userns",
];

/**
 * The profile the trial runs under: the strictest posture the probe can assert
 * without depending on anything about the host. No writable roots, no secrets
 * to mask, network off — so on Linux this exercises `--unshare-net` too.
 *
 * The empty `readDenyList` is load-bearing for purity: `wrapBwrap` classifies
 * deny-list entries with a real `statSync`, and an empty list never reaches it.
 *
 * It also bounds what the probe may claim. This profile exercises filesystem
 * containment and network-off; it does NOT exercise the domain allowlist
 * (which needs `network: "restricted"` and a live proxy) or credential masking
 * (which needs a deny-list). `capability-matrix.ts` records which capabilities
 * this covers, and `sandbox status` refuses to say "confirmed" about the rest.
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

/** Which layer `wrapWithSandbox` will have used for `platform`. */
function layerForPlatform(platform: string): SandboxLayer {
  if (platform === "linux") return "bwrap";
  if (platform === "darwin") return "seatbelt";
  return "none";
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

  const trial: ContainedCommand = {
    path: platform === "darwin" ? DARWIN_TRIAL_PROGRAM : TRIAL_PROGRAM,
    argv: [platform === "darwin" ? DARWIN_TRIAL_PROGRAM : TRIAL_PROGRAM],
    env: {},
    cwd,
  };

  // `wrapWithSandbox` — the platform dispatcher the product actually spawns
  // through, not `wrapBwrap`/`wrapSeatbelt` directly. Going through the
  // dispatcher is what keeps the probe honest when step 3 adds the Landlock
  // branch to it: a probe that re-implemented the dispatch would keep trialling
  // bubblewrap on a host whose real runs had moved to Landlock, which is this
  // package's own defect one layer down.
  const wrapped = wrapWithSandbox(trial, trialProfile(), {
    platform,
    ...(opts.launcherPath !== undefined ? { bwrapPath: opts.launcherPath } : {}),
  });

  if (!wrapped.ok) {
    return { layer: "none", ok: false, detail: wrapped.reason, cause: "unknown" };
  }
  if (!wrapped.wrapped) {
    // Only `danger-full-access` reaches this, and `trialProfile()` never sets
    // it. Reported as a failure rather than silently as a success, because an
    // unwrapped command proves nothing about containment.
    return {
      layer: "none",
      ok: false,
      detail: "the trial command was not wrapped, so nothing was contained",
      cause: "unknown",
    };
  }

  const layer = layerForPlatform(platform);
  const command = wrapped.command;
  // `argv[0]` is the launcher name by convention (see `wrapBwrap`/`wrapSeatbelt`);
  // the spawn takes the real arguments only.
  const result = spawn(command.path, command.argv.slice(1), {
    cwd,
    env: command.env,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return toProbeResult(layer, result);
}

function toProbeResult(layer: SandboxLayer, result: ProbeSpawnResult): ProbeResult {
  if (result.error === undefined && result.status === 0) {
    // Success carries no `detail`: there is no evidence to quote, and an
    // explanatory sentence here would be keryx's words presented where the
    // launcher's words go.
    return { layer, ok: true };
  }

  const detail = probeDetail(result);
  const cause = classifyFailure(detail);
  return {
    layer,
    ok: false,
    detail,
    cause,
    // The remediation is attached to the CAUSE, not to the failure. An AppArmor
    // profile fixes a user-namespace denial and nothing else; offering it for a
    // mount error or a missing binary would be a diagnosis the probe never made.
    ...(layer === "bwrap" && cause === "unprivileged-userns-denied"
      ? { remediation: BWRAP_APPARMOR_REMEDIATION }
      : {}),
  };
}

/**
 * The launcher's own words, in preference order. `bwrap: setting up uid map:
 * Permission denied` is a better diagnostic than any sentence keryx could
 * compose, and it is what the remediation is keyed on (spec §6).
 */
function probeDetail(result: ProbeSpawnResult): string {
  const stderr = sanitizeDetail(result.stderr ?? "");
  if (stderr.length > 0) {
    return stderr;
  }
  if (result.error !== undefined) {
    // The launcher could not be executed at all, so it has no words of its own;
    // the spawn error is the closest thing to evidence there is.
    return sanitizeDetail(result.error.message);
  }
  return `the launcher exited ${result.status ?? "with no status"} and wrote nothing to stderr`;
}

/**
 * Trim, bound, and strip control characters other than newline and tab.
 *
 * The text is quoted verbatim into a terminal and into CI logs. "Verbatim" is a
 * promise about the launcher's *words*, not about its ability to emit ANSI
 * escape sequences into an operator's terminal.
 */
function sanitizeDetail(raw: string): string {
  const stripped = raw
    // C0 controls except tab and newline, DEL, and the C1 range. Stripping
    // them is the point of this function, so the rule forbidding control
    // characters in a regex is disabled for this line only.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .trim();
  return stripped.length > MAX_DETAIL_CHARS
    ? `${stripped.slice(0, MAX_DETAIL_CHARS)}\u2026 (truncated)`
    : stripped;
}

function classifyFailure(detail: string): ProbeFailureCause {
  const haystack = detail.toLowerCase();
  return USERNS_DENIAL_MARKERS.some((marker) => haystack.includes(marker))
    ? "unprivileged-userns-denied"
    : "unknown";
}

const defaultSpawn: ProbeSpawn = (path, argv, options) => {
  const result = realSpawnSync(path, argv, {
    cwd: options.cwd,
    // The profile the trial claims to run under says the environment is empty;
    // running it under the parent's environment instead would make the probe
    // less faithful than the thing it reports on.
    env: options.env,
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
 *
 * The slot is never invalidated. No production caller renders the report twice
 * in one process today (`keryx sandbox status` runs once and exits). A future
 * caller that re-renders — a TUI panel, a long-lived agent session — would want
 * an explicit invalidation rather than reaching for the test-only reset below.
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

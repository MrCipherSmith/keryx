// Sandbox profile + mapping from the policy profile (flow 093, T1).
//
// The OS sandbox is a SEPARATE enforcement layer under the existing policy
// engine: the policy profile decides WHAT a shell command may do (allow/ask/
// deny per capability); this profile projects that decision onto OS-level
// filesystem/network boundaries the launcher (`sandbox-exec` / `bwrap`) enforces
// on the running process regardless of what the model chose to run.
//
// Pure and deterministic: no clock, randomness, network, or filesystem access —
// path values arrive from the caller (cwd/tmp/home), never read here.

import path from "node:path";
import type { PolicyProfile } from "../../policy/types";

/** OS-sandbox filesystem posture. */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/**
 * Network posture:
 * - `off`        — no network at all.
 * - `on`         — unrestricted host network.
 * - `restricted` — network allowed ONLY to `allowedDomains` via the loopback
 *   allowlist proxy (the OS layer denies all direct network except the proxy
 *   socket, and the process is pointed at it through HTTP(S)_PROXY).
 */
export type SandboxNetwork = "off" | "on" | "restricted";

/** The resolved OS-sandbox profile a launcher builder consumes. */
export interface SandboxProfile {
  mode: SandboxMode;
  network: SandboxNetwork;
  /** Absolute roots writable in `workspace-write` (empty for `read-only`). */
  writableRoots: string[];
  /** Absolute paths whose READ is denied even under the broad read default. */
  readDenyList: string[];
  /** Allowed domains when `network === "restricted"` (else empty). */
  allowedDomains: string[];
  /**
   * Loopback proxy address for `network === "restricted"`, filled in by the run
   * wiring once the proxy is listening. Absent means the proxy is not up yet, so
   * a `restricted` profile denies all network (fail-safe).
   */
  proxy?: { host: string; port: number };
  /**
   * When true, an unavailable/failed sandbox launcher MUST fail closed (refuse
   * to run) rather than fall back to an unsandboxed spawn. Derived from the
   * policy's `requiredControls.isolation === "required-fail-closed"`.
   */
  required: boolean;
}

/** Inputs to {@link sandboxProfileFromPolicy}. */
export interface SandboxProfileInput {
  policy: PolicyProfile;
  /** Absolute working directory (writable root in workspace-write). */
  cwd: string;
  /** Absolute session temp directory (writable root in workspace-write). */
  tmpDir: string;
  /** Absolute home directory, used to expand the default secret read-deny list. */
  home?: string;
  /**
   * When present and network is not denied, switch to `restricted` network:
   * only these domains are reachable (via the loopback allowlist proxy).
   */
  allowedDomains?: string[];
  /**
   * Explicit escape hatch: bypass OS containment entirely. Only ever set from a
   * trusted, approved caller (mirrors Claude Code's `dangerouslyDisableSandbox`).
   */
  dangerFullAccess?: boolean;
}

/**
 * Secret paths (relative to home) whose reads are denied by default.
 *
 * `.local/share/keryx` holds `auth.json` AND `permissions.json` — the agent's
 * own credentials and its approval allowlist. It was missing here while
 * `.config/keryx` was listed, so the file that governs the approval gate was
 * readable and writable by a contained command (flow 115).
 *
 * This is defence in depth only: it applies to a CONTAINED child, and shell
 * containment is opt-in (ADR-0006). The barrier that holds in the default
 * configuration is `touchesAgentCredentials` in the approval gate.
 */
const DEFAULT_SECRET_SUBPATHS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gh",
  ".config/keryx",
  ".local/share/keryx",
  ".netrc",
];

/** Build the default secret read-deny list under `home` (absolute paths). */
export function defaultReadDenyList(home: string | undefined): string[] {
  if (!home) {
    return [];
  }
  return DEFAULT_SECRET_SUBPATHS.map((sub) => path.join(home, sub));
}

/**
 * Project a policy profile onto an OS-sandbox profile.
 *
 * - `dangerFullAccess` (escape hatch) ⇒ `danger-full-access`, network on, not
 *   required, no roots/deny-list (the launcher wrap is skipped entirely).
 * - `defaults.write === "deny"` ⇒ `read-only` (no writable roots).
 * - otherwise ⇒ `workspace-write` (writable = cwd + tmp).
 * - `defaults.network === "allow"` ⇒ network `on`; anything else ⇒ `off`.
 * - `requiredControls.isolation === "required-fail-closed"` ⇒ `required`.
 */
export function sandboxProfileFromPolicy(input: SandboxProfileInput): SandboxProfile {
  if (input.dangerFullAccess === true) {
    return {
      mode: "danger-full-access",
      network: "on",
      writableRoots: [],
      readDenyList: [],
      allowedDomains: [],
      required: false,
    };
  }

  const mode: SandboxMode =
    input.policy.defaults.write === "deny" ? "read-only" : "workspace-write";
  const networkAllowed = input.policy.defaults.network === "allow";
  const allowedDomains = input.allowedDomains?.filter((d) => d.trim().length > 0) ?? [];
  // A domain allowlist narrows an otherwise-open network to `restricted`; with no
  // allowlist it stays fully on/off per the policy.
  const network: SandboxNetwork = !networkAllowed
    ? "off"
    : allowedDomains.length > 0
      ? "restricted"
      : "on";
  const writableRoots = mode === "workspace-write" ? dedupe([input.cwd, input.tmpDir]) : [];
  const required = input.policy.requiredControls.isolation === "required-fail-closed";

  return {
    mode,
    network,
    writableRoots,
    readDenyList: defaultReadDenyList(input.home),
    allowedDomains: network === "restricted" ? dedupe(allowedDomains) : [],
    required,
  };
}

/**
 * The v1 default OS-sandbox profile when no policy is in play: workspace-write
 * (cwd + tmp writable), network OFF, not fail-closed-required. This is the
 * recommended default posture for prod v1.
 */
export function defaultSandboxProfile(cwd: string, tmpDir: string, home?: string): SandboxProfile {
  return {
    mode: "workspace-write",
    network: "off",
    writableRoots: dedupe([cwd, tmpDir]),
    readDenyList: defaultReadDenyList(home),
    allowedDomains: [],
    required: false,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

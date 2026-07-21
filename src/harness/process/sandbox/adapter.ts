// SandboxedProcessAdapter (flow 093, T4).
//
// A `ProcessAdapter` decorator that OS-contains every command before delegating
// to an inner real adapter. It slots into `runContainedProcess` unchanged — the
// existing structural guard / env-allowlist / budget gates still run on the
// ORIGINAL command (approval semantics untouched); this layer only rewrites the
// command's launcher right before the single side-effecting spawn.
//
// Fail-closed: when the launcher is unavailable or the platform is unsupported,
// a `required` profile (or `failIfUnavailable`, default true) yields a
// `spawn-error` observation — which `runContainedProcess` classifies as
// `blocked` — instead of silently running unsandboxed.

import { createHash } from "node:crypto";
import type { ContainedCommand, ProcessAdapter, ProcessObservation } from "../executor";
import type { SandboxProfile } from "./profile";
import { wrapWithSandbox } from "./wrap";

export interface SandboxedProcessAdapterOptions {
  /** The resolved OS-sandbox profile for this run. */
  profile: SandboxProfile;
  /** The real adapter that performs the actual spawn. */
  inner: ProcessAdapter;
  /** `process.platform` value. */
  platform: string;
  /** Whether the platform launcher (sandbox-exec / bwrap) is present. */
  launcherAvailable: boolean;
  /** Resolved absolute bwrap path (Linux). */
  bwrapPath?: string;
  /**
   * When the sandbox cannot be applied, refuse to run rather than fall back to
   * an unsandboxed spawn. Defaults to true (prod-safe). A `required` profile
   * always fails closed regardless of this flag.
   */
  failIfUnavailable?: boolean;
}

function spawnError(command: ContainedCommand, message: string): ProcessObservation {
  return {
    kind: "spawn-error",
    observedHash: createHash("sha256")
      .update(`${command.path}\n${command.argv.join(" ")}`, "utf8")
      .digest("hex"),
    errorMessage: message,
  };
}

export class SandboxedProcessAdapter implements ProcessAdapter {
  private readonly opts: SandboxedProcessAdapterOptions;

  constructor(opts: SandboxedProcessAdapterOptions) {
    this.opts = opts;
  }

  spawn(command: ContainedCommand): ProcessObservation {
    const { profile, inner, platform, launcherAvailable, bwrapPath } = this.opts;
    const failClosed = profile.required || (this.opts.failIfUnavailable ?? true);

    // Escape hatch: explicit full access ⇒ no containment.
    if (profile.mode === "danger-full-access") {
      return inner.spawn(command);
    }

    // Launcher missing ⇒ fail closed (prod) or best-effort (only when relaxed).
    if (!launcherAvailable) {
      if (failClosed) {
        return spawnError(
          command,
          `OS sandbox launcher unavailable on ${platform} for program "${command.path}"; failing closed (install bubblewrap on Linux, or relax failIfUnavailable to run unsandboxed).`,
        );
      }
      return inner.spawn(command);
    }

    const wrap = wrapWithSandbox(command, profile, {
      platform,
      ...(bwrapPath !== undefined ? { bwrapPath } : {}),
    });
    if (!wrap.ok) {
      if (failClosed) {
        return spawnError(
          command,
          `sandbox wrap refused program "${command.path}" on ${platform}: ${wrap.reason}`,
        );
      }
      return inner.spawn(command);
    }

    const observation = inner.spawn(wrap.command);
    // Launcher started but reported a spawn-class failure: keep the structured
    // errorMessage and prefix with original program path so harness JSON is not
    // a bare exit code (AC-H2 / exit-71 class diagnostics).
    if (observation.kind === "spawn-error") {
      const detail = observation.errorMessage ?? "unknown spawn error";
      return spawnError(
        command,
        `sandbox spawn failed for "${command.path}" via ${platform} launcher: ${detail}`,
      );
    }
    // clean-exit with 71 (EX_OSERR) after seatbelt/bwrap wrap is almost always a
    // helper/path/exec problem inside the sandbox, not a successful program run.
    if (
      observation.kind === "clean-exit" &&
      observation.exitCode === 71 &&
      wrap.wrapped
    ) {
      return spawnError(
        command,
        `sandbox launcher returned exit 71 (EX_OSERR) for "${command.path}" on ${platform}; often missing/non-executable helper or path denied inside the sandbox`,
      );
    }
    return observation;
  }
}

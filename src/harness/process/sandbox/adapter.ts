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
//
// A `restricted` network posture fails closed unconditionally, and that is not
// the same judgement call as the rest of the flag. `KERYX_SANDBOX_ALLOW_UNSANDBOXED`
// exists so a host without bubblewrap can still run: containment is weaker than
// asked for, the operator set the variable, they know the trade. A domain
// allowlist is different. By the time this adapter is reached the proxy is
// already listening and `HTTP(S)_PROXY` is already merged into the command env
// (`commands/harness.ts`), so falling through to an unsandboxed spawn hands the
// process an allowlist proxy it is free to ignore — no egress restriction at all,
// wearing the shape of one. That is not weaker than the request, it is the
// opposite of it, so no environment variable reaches it.

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
  /** The kernel's Landlock ABI, when the caller measured one (Linux). */
  landlockAbi?: number;
  /** Absolute path of the Bun that runs the Landlock applier. */
  bunPath?: string;
  /** Absolute path of the bundled `landlock-exec` entry point. */
  landlockExecPath?: string;
  /** Absolute `$HOME`. Granted by nothing; see the grant model (§4.4). */
  home?: string;
  /** Read-only hierarchies beyond the system ones, each measured. */
  extraReadRoots?: readonly string[];
  /**
   * Called with the layer that actually wrapped a command.
   *
   * The layer is reported from this decision — the parent's — and never from the
   * contained command's exit status, which it is free to choose. 125 means
   * "the launcher failed" only because keryx says so here.
   */
  onLayer?: (layer: "seatbelt" | "landlock" | "bwrap") => void;
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
    // `network === "restricted"` is checked here rather than only on the profile
    // because `setupNetworkRun` spreads an incoming profile to attach the proxy
    // and never sets `required` — enforcing the invariant at the single spawn
    // boundary means no construction path can route around it.
    const failClosed =
      profile.required ||
      profile.network === "restricted" ||
      (this.opts.failIfUnavailable ?? true);

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
      ...(this.opts.landlockAbi !== undefined ? { landlockAbi: this.opts.landlockAbi } : {}),
      ...(this.opts.bunPath !== undefined ? { bunPath: this.opts.bunPath } : {}),
      ...(this.opts.landlockExecPath !== undefined
        ? { landlockExecPath: this.opts.landlockExecPath }
        : {}),
      ...(this.opts.home !== undefined ? { home: this.opts.home } : {}),
      ...(this.opts.extraReadRoots !== undefined
        ? { extraReadRoots: this.opts.extraReadRoots }
        : {}),
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

    if (wrap.layer !== undefined) {
      this.opts.onLayer?.(wrap.layer);
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

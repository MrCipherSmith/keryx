// Platform dispatcher for OS-sandbox command wrapping (flow 093, T4).
//
// Pure: given a contained command + resolved sandbox profile + platform, returns
// the launcher-wrapped command (macOS seatbelt / Linux Landlock or bwrap), an
// explicit "no containment" pass-through for the `danger-full-access` escape
// hatch, or a fail-closed reason. No spawning, no fs, no kernel — the Landlock
// ABI and both launcher paths arrive as options, so this module can be tested on
// a host that has neither launcher (keryx-linux-containment §4.2).
//
// Linux is a choice between two layers now, and it is made per **profile**, not
// per host: the same machine serves a workspace-write profile with Landlock and
// a `network: "off"` profile with bubblewrap, because Landlock's network rights
// are TCP-only and cannot express network-off (§4.3).

import type { ContainedCommand } from "../executor";
import type { SandboxProfile } from "./profile";
import { wrapSeatbelt } from "./seatbelt";
import { wrapBwrap } from "./bwrap";
import { buildLandlockRuleset } from "./landlock";
import type { LandlockInexpressible } from "./landlock";

export type WrapResult =
  | { ok: true; command: ContainedCommand; wrapped: boolean; layer?: WrapLayer }
  | { ok: false; reason: string };

/** Which OS mechanism the returned command is wrapped with. */
export type WrapLayer = "seatbelt" | "landlock" | "bwrap";

export interface WrapOptions {
  /** `process.platform` value ("darwin" | "linux" | "win32" | …). */
  platform: string;
  /** Resolved absolute bwrap path (Linux); falls back to PATH lookup. */
  bwrapPath?: string;
  /**
   * The kernel's Landlock ABI, as measured by `landlock-abi.ts`. Absent means
   * "not measured", which selects bubblewrap rather than assuming either way —
   * this module never guesses at a kernel it is forbidden from asking.
   */
  landlockAbi?: number;
  /** Absolute path of the Bun that runs the applier. */
  bunPath?: string;
  /** Absolute path of the bundled `landlock-exec` entry point. */
  landlockExecPath?: string;
  /** Absolute `$HOME`; never granted, and named in a refusal so it reads. */
  home?: string;
  /**
   * Read-only hierarchies beyond the system ones — the Bun install directory,
   * and every measured `$HOME` entry. Each is a reviewed widening (§4.4).
   */
  extraReadRoots?: readonly string[];
}

/**
 * Translation failures that mean "another layer should serve this profile",
 * rather than "this profile cannot be served at all".
 *
 * The distinction is the whole of layer selection. A profile Landlock cannot
 * express because of the *kernel* or because of an axis Landlock does not have
 * is bubblewrap's; one it cannot express because of the profile's own shape —
 * a malformed root, the escape hatch — is nobody's, and falling through to
 * bubblewrap there would hand a broken profile to a second launcher.
 */
const FALLBACK_CODES: ReadonlySet<string> = new Set([
  "network-off-requires-seccomp",
  "read-deny-list-requires-mount-view",
  "landlock-unavailable",
  "abi-unreadable",
  "abi-too-low",
]);

/**
 * Wrap `command` for OS containment under `profile`.
 * - `danger-full-access` ⇒ pass-through, `wrapped:false` (containment skipped).
 * - `darwin` ⇒ seatbelt-wrapped.
 * - `linux` ⇒ bwrap-wrapped.
 * - anything else ⇒ fail-closed reason (unsupported platform).
 */
export function wrapWithSandbox(
  command: ContainedCommand,
  profile: SandboxProfile,
  opts: WrapOptions,
): WrapResult {
  if (profile.mode === "danger-full-access") {
    return { ok: true, command, wrapped: false };
  }

  if (opts.platform === "darwin") {
    return { ok: true, command: wrapSeatbelt(command, profile), wrapped: true, layer: "seatbelt" };
  }

  if (opts.platform === "linux") {
    // `restricted` needs a network namespace + relay to force traffic through the
    // proxy; neither layer can (bwrap would either cut the proxy with
    // --unshare-net or leave the network fully open, and Landlock gates TCP by
    // port rather than by name). Fail closed rather than ship a false boundary —
    // Linux restricted lands with the netns+socat follow-up (flow 099).
    if (profile.network === "restricted") {
      return {
        ok: false,
        reason:
          "network=restricted is not yet enforced on Linux (needs a network namespace + proxy relay); use network off/on or run inside a container.",
      };
    }

    const landlock = tryLandlock(command, profile, opts);
    if (landlock.ok) {
      return landlock;
    }
    if (landlock.failures !== undefined && !landlock.failures.every((f) => FALLBACK_CODES.has(f.code))) {
      // The profile itself is the problem, so a second launcher would be handed
      // the same broken input. Report Landlock's own words: they name the field.
      return {
        ok: false,
        reason: `this profile has no Landlock representation: ${landlock.failures.map((f) => f.detail).join(" ")}`,
      };
    }

    const wrapped = opts.bwrapPath
      ? wrapBwrap(command, profile, opts.bwrapPath)
      : wrapBwrap(command, profile);
    return { ok: true, command: wrapped, wrapped: true, layer: "bwrap" };
  }

  return {
    ok: false,
    reason: `OS sandbox is unsupported on platform "${opts.platform}"; run inside WSL2 or a container, or use an explicit danger-full-access override.`,
  };
}

/**
 * Build the Landlock command, or say why not.
 *
 * `failures` is present only when the *translation* refused; a missing ABI, Bun
 * path or applier path is not a statement about the profile at all, so it
 * carries none and falls through to bubblewrap. Distinguishing the two is what
 * keeps "keryx was not told where its own applier is" from being reported to an
 * operator as "your profile cannot be contained".
 */
function tryLandlock(
  command: ContainedCommand,
  profile: SandboxProfile,
  opts: WrapOptions,
):
  | { ok: true; command: ContainedCommand; wrapped: true; layer: "landlock" }
  | { ok: false; failures?: readonly LandlockInexpressible[] } {
  const { landlockAbi, bunPath, landlockExecPath } = opts;
  if (landlockAbi === undefined || bunPath === undefined || landlockExecPath === undefined) {
    return { ok: false };
  }

  const translation = buildLandlockRuleset(profile, landlockAbi, {
    workspace: command.cwd,
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    ...(opts.extraReadRoots !== undefined ? { extraReadRoots: opts.extraReadRoots } : {}),
  });
  if (!translation.ok) {
    return { ok: false, failures: translation.failures };
  }

  return {
    ok: true,
    wrapped: true,
    layer: "landlock",
    command: {
      path: bunPath,
      // `argv[0]` stays the launcher, as in `wrapBwrap`. The ruleset travels as
      // one JSON argument: this module returns a command and creates no files,
      // and the contents are paths and right names rather than secrets.
      argv: [
        bunPath,
        landlockExecPath,
        "--ruleset",
        JSON.stringify(translation.ruleset),
        "--",
        command.path,
        ...command.argv.slice(1),
      ],
      env: command.env,
      cwd: command.cwd,
    },
  };
}

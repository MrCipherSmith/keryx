// Platform dispatcher for OS-sandbox command wrapping (flow 093, T4).
//
// Pure: given a contained command + resolved sandbox profile + platform, returns
// the launcher-wrapped command (macOS seatbelt / Linux bwrap), an explicit
// "no containment" pass-through for the `danger-full-access` escape hatch, or a
// fail-closed reason for an unsupported platform. No spawning, no fs.

import type { ContainedCommand } from "../executor";
import type { SandboxProfile } from "./profile";
import { wrapSeatbelt } from "./seatbelt";
import { wrapBwrap } from "./bwrap";

export type WrapResult =
  | { ok: true; command: ContainedCommand; wrapped: boolean }
  | { ok: false; reason: string };

export interface WrapOptions {
  /** `process.platform` value ("darwin" | "linux" | "win32" | …). */
  platform: string;
  /** Resolved absolute bwrap path (Linux); falls back to PATH lookup. */
  bwrapPath?: string;
}

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
    return { ok: true, command: wrapSeatbelt(command, profile), wrapped: true };
  }

  if (opts.platform === "linux") {
    // `restricted` needs a network namespace + relay to force traffic through the
    // proxy; bwrap alone cannot (it would either cut the proxy with --unshare-net
    // or leave the network fully open). Fail closed rather than ship a false
    // boundary — Linux restricted lands with the netns+socat follow-up (flow 099).
    if (profile.network === "restricted") {
      return {
        ok: false,
        reason:
          "network=restricted is not yet enforced on Linux (needs a network namespace + proxy relay); use network off/on or run inside a container.",
      };
    }
    const wrapped = opts.bwrapPath
      ? wrapBwrap(command, profile, opts.bwrapPath)
      : wrapBwrap(command, profile);
    return { ok: true, command: wrapped, wrapped: true };
  }

  return {
    ok: false,
    reason: `OS sandbox is unsupported on platform "${opts.platform}"; run inside WSL2 or a container, or use an explicit danger-full-access override.`,
  };
}

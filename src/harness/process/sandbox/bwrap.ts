// Linux bubblewrap (bwrap) launcher builder (flow 093, T3).
//
// Pure: builds the `bwrap` argv for a workspace-write / read-only OS sandbox. No
// spawning, no fs, no clock.
//
// Boundary model:
//   --ro-bind / /        whole host filesystem, READ-ONLY
//   --bind <root> <root> re-bind each writable root (cwd + session tmp) RW
//   --tmpfs <secret-dir> mask each secret DIRECTORY with an empty tmpfs (deny-read)
//   --ro-bind /dev/null <secret-file>  mask each secret FILE as empty
//   --unshare-net        no network namespace ⇒ network OFF (when profile off)
//   --dev /dev --proc /proc  minimal device + proc for tool compatibility
//   --die-with-parent --new-session --unshare-ipc  hardening (no orphan, no
//                        TIOCSTI tty injection, ipc isolation)
//
// Landlock/seccomp are a follow-up hardening layer; `--ro-bind` + `--unshare-net`
// already enforce the v1 filesystem + network boundary. Real-kernel behavior is
// validated by the flag-gated live smoke (T7). `danger-full-access` never
// reaches this module — the wrap dispatcher skips containment for it.

import { statSync } from "node:fs";
import type { ContainedCommand } from "../executor";
import type { SandboxProfile } from "./profile";

/** Default launcher program name (resolved via PATH; detect.ts confirms it). */
export const BWRAP_PROGRAM = "bwrap";

/** What a read-deny path actually is on disk — decides how it gets masked. */
export type MaskTargetKind = "dir" | "file" | "missing";

/**
 * Classify a read-deny path on the host filesystem. Masking has to know this:
 * bwrap mounts over an EXISTING mount point, and because `/` is bound read-only
 * it cannot create a missing one — `--tmpfs /home/runner/.ssh` on a machine
 * without an `.ssh` dir aborts the whole sandbox with
 * `Can't mkdir …: Read-only file system` (observed on GitHub's ubuntu runners).
 */
export function inspectMaskTarget(target: string): MaskTargetKind {
  try {
    return statSync(target).isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}

/**
 * Build the `bwrap` argument list (everything up to and including `--`, before
 * the wrapped command). Deterministic given the profile and the mask-target
 * classification (injectable so unit tests stay off the real filesystem).
 */
export function buildBwrapArgs(
  profile: SandboxProfile,
  inspect: (target: string) => MaskTargetKind = inspectMaskTarget,
): string[] {
  const args: string[] = [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    // Ephemeral scratch /tmp; explicit writable roots re-bind over it below.
    "--tmpfs",
    "/tmp",
  ];

  // Re-bind writable roots RW (order after --ro-bind / and --tmpfs /tmp wins).
  for (const root of profile.writableRoots) {
    args.push("--bind", root, root);
  }

  // Mask secrets so reads see nothing (deny-read). A directory gets an empty
  // tmpfs; a regular file is bound over with /dev/null (reads as empty). A path
  // that does not exist is skipped — there is nothing to leak, and mounting over
  // it would abort the sandbox (see inspectMaskTarget).
  for (const secret of profile.readDenyList) {
    const kind = inspect(secret);
    if (kind === "dir") {
      args.push("--tmpfs", secret);
    } else if (kind === "file") {
      args.push("--ro-bind", "/dev/null", secret);
    }
  }

  if (profile.network === "off") {
    args.push("--unshare-net");
  }

  args.push("--unshare-ipc", "--die-with-parent", "--new-session");
  return args;
}

/**
 * Wrap a contained command under `bwrap <args...> -- <cmd> [args...]`.
 * `env`/`cwd` are preserved; `argv[0]` stays the launcher name by convention.
 * `launcherPath` defaults to `bwrap` (PATH-resolved) but a caller that resolved
 * an absolute path (detect.ts) may pass it.
 */
export function wrapBwrap(
  command: ContainedCommand,
  profile: SandboxProfile,
  launcherPath: string = BWRAP_PROGRAM,
): ContainedCommand {
  return {
    path: launcherPath,
    argv: [BWRAP_PROGRAM, ...buildBwrapArgs(profile), "--", command.path, ...command.argv.slice(1)],
    env: command.env,
    cwd: command.cwd,
  };
}

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
//   --tmpfs /run         host IPC services (D-Bus, systemd user manager, docker.sock)
//                        are unix sockets under /run; --unshare-net does not isolate
//                        them and a read-only mount does not refuse connect(), so
//                        the directory is hidden (also /var/run and XDG_RUNTIME_DIR)
//   --ro-bind <git ctl>  <cwd>/.git/hooks + config stay read-only inside the
//                        writable root: the host runs them on its next git command
//   --unshare-net        no network namespace ⇒ network OFF (when profile off)
//   --dev /dev --proc /proc  minimal device + proc for tool compatibility
//   --unshare-pid        own PID namespace ⇒ the host process table is neither
//                        visible nor signalable (requires the --proc mount above)
//   --die-with-parent --new-session --unshare-ipc  hardening (no orphan, no
//                        TIOCSTI tty injection, ipc isolation)
//
// Landlock/seccomp are a follow-up hardening layer; `--ro-bind` + `--unshare-net`
// already enforce the v1 filesystem + network boundary. Real-kernel behavior is
// validated by the flag-gated live smoke (T7). `danger-full-access` never
// reaches this module — the wrap dispatcher skips containment for it.

import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ContainedCommand } from "../executor";
import { resolveGitProtectedPaths } from "./git-protect";
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

/** Host-dependent inputs of {@link buildBwrapArgs}, injectable so tests stay off the real filesystem. */
export interface BwrapHostOptions {
  /** Read-only paths inside the writable roots (git hooks/config), see git-protect.ts. */
  gitProtected: readonly string[];
  /** Host directories hidden behind an empty tmpfs: the IPC socket homes. */
  ipcDirs: readonly string[];
  /** Real target of /etc/resolv.conf to bind back read-only (network on only), when it lives in a hidden dir. */
  resolvConf?: string;
}

function isRealDir(p: string): boolean {
  try {
    return statSync(p).isDirectory() && realpathSync(p) === path.resolve(p);
  } catch {
    return false;
  }
}

/** Resolve {@link BwrapHostOptions} from the real host. `env` supplies XDG_RUNTIME_DIR. */
export function hostBwrapOptions(
  profile: SandboxProfile,
  env: Record<string, string | undefined> = process.env,
): BwrapHostOptions {
  // /run and (when it is a real directory, not the usual symlink to /run)
  // /var/run hold the host's service sockets. XDG_RUNTIME_DIR is hidden too in
  // case it lives outside /run.
  const ipcDirs = ["/run", "/var/run"].filter(isRealDir);
  const runtimeDir = env["XDG_RUNTIME_DIR"];
  if (runtimeDir !== undefined && runtimeDir.length > 0 && isRealDir(runtimeDir)) {
    const real = realpathSync(runtimeDir);
    if (!ipcDirs.some((d) => real === d || real.startsWith(`${d}${path.sep}`))) ipcDirs.push(real);
  }
  const options: BwrapHostOptions = {
    gitProtected: resolveGitProtectedPaths(profile.writableRoots),
    ipcDirs,
  };
  if (profile.network === "on") {
    // /etc/resolv.conf is often a symlink into /run (systemd-resolved's stub);
    // with /run hidden it would dangle. Bind the FILE back, never the directory.
    try {
      const resolv = realpathSync("/etc/resolv.conf");
      const hidden = ipcDirs.some((d) => resolv.startsWith(`${d}${path.sep}`));
      if (hidden && existsSync(resolv) && !statSync(resolv).isDirectory()) options.resolvConf = resolv;
    } catch {
      // no resolv.conf: nothing to bind back
    }
  }
  return options;
}

/**
 * Build the `bwrap` argument list (everything up to and including `--`, before
 * the wrapped command). Deterministic given the profile, the mask-target
 * classification and the host options (both injectable so unit tests stay off
 * the real filesystem).
 */
export function buildBwrapArgs(
  profile: SandboxProfile,
  inspect: (target: string) => MaskTargetKind = inspectMaskTarget,
  host: BwrapHostOptions = hostBwrapOptions(profile),
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

  // Hide the host IPC socket homes before anything is bound back, so a writable
  // root that lives under one of them (a session tmp in $XDG_RUNTIME_DIR) still
  // re-binds on top of the empty tmpfs.
  for (const dir of host.ipcDirs) {
    args.push("--tmpfs", dir);
  }
  if (host.resolvConf !== undefined) {
    args.push("--ro-bind", host.resolvConf, host.resolvConf);
  }

  // Re-bind writable roots RW (order after --ro-bind / and --tmpfs /tmp wins).
  for (const root of profile.writableRoots) {
    args.push("--bind", root, root);
  }

  // Re-protect the repository control files the host would later execute. After
  // the RW binds so the read-only mount wins; existing paths only (bwrap cannot
  // create a mount point on the read-only root).
  for (const guarded of host.gitProtected) {
    args.push("--ro-bind", guarded, guarded);
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

  // `--unshare-pid` gives the contained process its own PID namespace, so it
  // cannot enumerate — or signal — processes on the host. Without it the whole
  // host process table was visible from inside containment (stress finding S4).
  //
  // It is safe here only because `--proc /proc` is mounted above: a new PID
  // namespace without a fresh /proc leaves the process reading the HOST's, which
  // would make the flag cosmetic. bwrap becomes PID 1 in the namespace and reaps
  // children, which is the documented pairing with `--die-with-parent`.
  args.push("--unshare-pid", "--unshare-ipc", "--die-with-parent", "--new-session");
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
  const host = hostBwrapOptions(profile, { ...process.env, ...command.env });
  return {
    path: launcherPath,
    argv: [BWRAP_PROGRAM, ...buildBwrapArgs(profile, inspectMaskTarget, host), "--", command.path, ...command.argv.slice(1)],
    env: command.env,
    cwd: command.cwd,
  };
}

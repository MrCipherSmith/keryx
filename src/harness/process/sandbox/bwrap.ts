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
//                        the directory is hidden (also /var/run and XDG_RUNTIME_DIR);
//                        PATH entries under it (NixOS /run/current-system/sw/bin,
//                        /run/wrappers/bin) are bound back read-only, one bin dir
//                        each, never a dir holding a socket
//   --bind <git dir>     each git dir (and its parents inside the root) becomes a
//                        mount point, so rename(2) refuses it (EBUSY): `.git`
//                        cannot be moved away and replaced
//   --ro-bind <git ctl>  .git/hooks, config, config.worktree, commondir stay
//                        read-only inside the writable root: the host runs them on
//                        its next git command (see git-protect.ts; a missing one
//                        gets an empty read-only mount point, except commondir)
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

import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ContainedCommand } from "../executor";
import { resolveGitProtection, type GitProtection } from "./git-protect";
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
  /** Git control paths and anchors inside the writable roots, see git-protect.ts. */
  git: GitProtection;
  /** Host directories hidden behind an empty tmpfs: the IPC socket homes. */
  ipcDirs: readonly string[];
  /** PATH entries inside a hidden dir, bound back read-only so the tools on them still run. */
  pathBinds?: readonly string[];
  /** Real target of /etc/resolv.conf to bind back read-only (network on only), when it lives in a hidden dir. */
  resolvConf?: string;
}

/** Nothing to protect: the writable roots hold no git repository. */
export const NO_GIT_PROTECTION: GitProtection = { controls: [], anchors: [] };

function isRealDir(p: string): boolean {
  try {
    return statSync(p).isDirectory() && realpathSync(p) === path.resolve(p);
  } catch {
    return false;
  }
}

function within(dir: string, p: string): boolean {
  return p === dir || p.startsWith(`${dir}${path.sep}`);
}

/** What {@link pathEntriesUnderHidden} needs from the host, injectable for tests. */
export interface PathBindProbe {
  /** Real path of an existing directory; undefined when it is missing or not a directory. */
  realDir(p: string): string | undefined;
  /** Does the directory hold a unix socket (one level deep)? */
  hasSocket(dir: string): boolean;
}

const hostPathBindProbe: PathBindProbe = {
  realDir(p) {
    try {
      return statSync(p).isDirectory() ? realpathSync(p) : undefined;
    } catch {
      return undefined;
    }
  },
  hasSocket(dir) {
    try {
      return readdirSync(dir).some((name) => {
        try {
          return lstatSync(path.join(dir, name)).isSocket();
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  },
};

/**
 * PATH entries the IPC hide would take away (NixOS keeps the system PATH in
 * `/run/current-system/sw/bin` and the setuid wrappers in `/run/wrappers/bin`).
 * Each is bound back on its own — never a parent — and only when doing so cannot
 * re-expose a socket home: an entry that resolves to a hidden dir (or a parent of
 * one) or holds a socket stays hidden. `sensitive` is the hidden dirs plus the
 * user runtime dir, which usually sits INSIDE /run and so is not in the hidden list.
 */
export function pathEntriesUnderHidden(
  pathEnv: string | undefined,
  hidden: readonly string[],
  sensitive: readonly string[],
  probe: PathBindProbe = hostPathBindProbe,
): string[] {
  const out: string[] = [];
  for (const entry of (pathEnv ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue;
    const p = path.resolve(entry);
    if (!hidden.some((d) => p !== d && within(d, p))) continue;
    const real = probe.realDir(p);
    if (real === undefined) continue;
    if ([...hidden, ...sensitive].some((d) => within(real, d) || within(p, d))) continue;
    if (probe.hasSocket(real)) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * bwrap mounts that keep the git control paths read-only (see git-protect.ts).
 * Placed AFTER the writable-root binds so they win.
 *
 *   - every anchor (a git dir, and each directory between it and the root) is
 *     bound onto itself: a mount point cannot be renamed (EBUSY), so `.git`
 *     cannot be moved away and replaced by a fresh one with a hook in it;
 *   - every existing control path is bound read-only over itself;
 *   - a missing one needs a mount point to hold the protection, and bwrap creates
 *     it through the writable bind — so it is left behind on the host. Only
 *     where that leftover is inert: an empty read-only `hooks` dir (what
 *     `git init` makes anyway), an empty `config` / `config.worktree` (an empty
 *     config file is valid). A missing `commondir` gets NO mount: an empty or
 *     directory `commondir` makes git die ("failed to read .git/commondir"),
 *     inside the sandbox and on the host afterwards. That one path stays
 *     creatable on Linux — see the wiki page (os-sandbox.md).
 */
export function gitProtectBwrapArgs(git: GitProtection): string[] {
  const args: string[] = [];
  for (const anchor of git.anchors) args.push("--bind", anchor, anchor);
  for (const control of git.controls) {
    if (control.kind !== "missing") {
      args.push("--ro-bind", control.real, control.real);
    } else if (control.entry === "hooks") {
      args.push("--tmpfs", control.path, "--remount-ro", control.path);
    } else if (control.entry === "config" || control.entry === "config.worktree") {
      args.push("--ro-bind", "/dev/null", control.path);
    }
  }
  return args;
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
  const sensitive: string[] = [];
  const runtimeDir = env["XDG_RUNTIME_DIR"];
  if (runtimeDir !== undefined && runtimeDir.length > 0 && isRealDir(runtimeDir)) {
    const real = realpathSync(runtimeDir);
    sensitive.push(real);
    if (!ipcDirs.some((d) => real === d || real.startsWith(`${d}${path.sep}`))) ipcDirs.push(real);
  }
  const options: BwrapHostOptions = {
    git: resolveGitProtection(profile.writableRoots),
    ipcDirs,
    pathBinds: pathEntriesUnderHidden(env["PATH"], ipcDirs, sensitive),
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
  for (const bin of host.pathBinds ?? []) {
    args.push("--ro-bind", bin, bin);
  }

  // Re-bind writable roots RW (order after --ro-bind / and --tmpfs /tmp wins).
  for (const root of profile.writableRoots) {
    args.push("--bind", root, root);
  }

  // Re-protect the repository control paths the host would later execute, and
  // pin the git dirs in place. After the RW binds so these mounts win.
  args.push(...gitProtectBwrapArgs(host.git));

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

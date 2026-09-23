// Flow 290 T13 (AC13): the hardened OS sandbox for UNATTENDED runs — a
// dispatched `flow-next` agent's `shell_exec`, and the health gate that runs
// the code that agent wrote.
//
// The interactive `KERYX_SANDBOX_SHELL=workspace` profile was built for a
// person who approves every command: network on, the operator's environment
// minus keryx's own saved keys, $HOME readable except a DENY list of known
// secret paths, and the real /tmp re-bound writable. A security review showed
// each of those is a way out when nobody is watching: exported tokens passed
// through, `~/.config/gh-work` (a real path on the reviewer's machine, absent
// from the deny list) was readable, the SSH agent socket was reachable.
//
// So this profile is built the other way round — ALLOW lists, not deny lists:
//
//   filesystem  `/` read-only; $HOME and /run (every host service socket:
//               D-Bus, systemd-resolved, tailscaled, libvirt, snapd, Docker,
//               ssh-agent…) hidden WHOLESALE behind an empty tmpfs; then only what the run
//               needs is bound back — toolchain roots detected from PATH
//               (read-only), the repository's git dir (read-only), the keryx
//               package itself (read-only), the worktree and a scratch HOME
//               (read-write). The known-secret deny list is still applied on
//               top, inside anything bound back.
//   /tmp        a private tmpfs; the host's /tmp is never re-bound.
//   network     OFF unless the trigger entry says `dispatch.network: true`.
//   env         an allowlist (PATH, locale, TERM, TZ, colour flags), HOME and
//               the XDG dirs pointed at the scratch home, TMPDIR=/tmp. No
//               SSH_AUTH_SOCK, no tokens — nothing the operator exported.
//   sockets     `--unshare-net` isolates abstract sockets only, never AF_UNIX
//               path sockets — those are unreachable because /run is hidden.
//
// Linux (bubblewrap) only in this version. macOS `sandbox-exec` would need the
// same allow-list shape expressed in SBPL, and nothing here can test it, so a
// `trust` dispatch on macOS refuses rather than running on an unproven
// profile. `planUnattendedSandbox` is the one place that decides; its refusal
// reasons are what the run record carries.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { detectSandboxLauncher, type DetectOptions } from "./detect";
import { keryxConfigDir } from "../../../lib/config-dir";
import { defaultReadDenyList } from "./profile";

/** Environment variables an unattended command inherits, by name. Nothing else passes. */
export const UNATTENDED_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TERM",
  "TZ",
  "NO_COLOR",
  "FORCE_COLOR",
];

export interface UnattendedSandboxInput {
  /** The run's worktree — the command's cwd, read-write. */
  readonly worktree: string;
  /** A scratch directory used as HOME, read-write, discarded after the run. */
  readonly scratchHome: string;
  /** `dispatch.network` — default false. */
  readonly network: boolean;
  /** Extra read-only roots (the repository's git dir, the keryx package, `node_modules`). */
  readonly readOnly: readonly string[];
  /**
   * Flow 295: directories hidden behind an empty tmpfs, like $HOME, before the worktree
   * and scratch home are bound back. Pass the shared parent of every run's scratch
   * directory, and one run then cannot read another's, even when TMPDIR is not `/tmp`
   * (a host `/var/tmp` is otherwise visible read-only through `--ro-bind / /`).
   */
  readonly hide?: readonly string[];
  /** The operator's environment — read for PATH/locale and the opt-outs, never passed through. */
  readonly env: Record<string, string | undefined>;
  readonly home: string;
  readonly uid?: number;
  readonly platform?: string;
  /** Test seams. */
  readonly detect?: DetectOptions;
  readonly probe?: (launcher: string) => boolean;
}

export type UnattendedSandboxPlan =
  | {
      readonly ok: true;
      readonly launcher: string;
      /** bwrap arguments up to (not including) `--`. */
      readonly args: readonly string[];
      readonly env: Record<string, string>;
      /** Wrap an argv so it runs inside the sandbox. */
      readonly wrap: (argv: readonly string[]) => string[];
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Toolchain roots to bind back read-only, derived from PATH entries that live
 * under the hidden home. `~/.bun/bin` → `~/.bun`; `~/.nvm/versions/node/v22/bin`
 * → `~/.nvm/versions/node/v22`; `~/.local/bin` → itself only (its parent holds
 * `share/keryx` credentials). Nothing is hard-coded to one machine.
 */
export function toolchainRoots(pathEnv: string | undefined, home: string): string[] {
  const out = new Set<string>();
  const homeResolved = path.resolve(home);
  for (const entry of (pathEnv ?? "").split(path.delimiter)) {
    if (entry.length === 0) continue;
    const resolved = path.resolve(entry);
    if (resolved !== homeResolved && !resolved.startsWith(`${homeResolved}${path.sep}`)) continue;
    const parent = path.dirname(resolved);
    const root =
      path.basename(resolved) === "bin" && parent !== homeResolved && parent !== path.join(homeResolved, ".local")
        ? parent
        : resolved;
    if (root === homeResolved) continue;
    if (existsSync(root)) out.add(root);
  }
  return [...out];
}

/** Does bwrap actually work here (user namespaces can be disabled even when the binary exists)? */
function defaultProbe(launcher: string): boolean {
  try {
    execFileSync(launcher, ["--ro-bind", "/", "/", "--unshare-net", "--", "/bin/true"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Decide whether an unattended command can be contained here, and how. A
 * refusal names the reason; the caller must not fall back to running
 * uncontained (`trust` refuses the whole dispatch on it).
 */
export function planUnattendedSandbox(input: UnattendedSandboxInput): UnattendedSandboxPlan {
  const platform = input.platform ?? process.platform;
  if (input.env["KERYX_DANGEROUSLY_DISABLE_SANDBOX"] === "1") {
    return { ok: false, reason: "KERYX_DANGEROUSLY_DISABLE_SANDBOX=1 is set — an unattended run never runs without containment" };
  }
  const shellMode = input.env["KERYX_SANDBOX_SHELL"]?.trim().toLowerCase();
  if (shellMode === "off" || shellMode === "0" || shellMode === "false") {
    return { ok: false, reason: `KERYX_SANDBOX_SHELL=${input.env["KERYX_SANDBOX_SHELL"]} disables the shell sandbox — an unattended run never runs without containment` };
  }
  if (platform !== "linux") {
    return {
      ok: false,
      reason: `the hardened unattended sandbox is implemented for Linux (bubblewrap) only; this is "${platform}"`,
    };
  }
  const launcher = detectSandboxLauncher({ platform, env: input.env, ...input.detect });
  if (!launcher.available || launcher.path === undefined) {
    return { ok: false, reason: `no sandbox launcher: ${launcher.reason ?? "bwrap not found"}` };
  }
  if (!(input.probe ?? defaultProbe)(launcher.path)) {
    return {
      ok: false,
      reason: `bwrap at ${launcher.path} is present but cannot create a sandbox here (unprivileged user namespaces disabled?)`,
    };
  }

  const home = path.resolve(input.home);
  const args: string[] = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];

  // Hide wholesale, the same allow-list way as $HOME:
  //
  //   /run (and /var/run when it is a real directory rather than the usual
  //   symlink to /run) — the host's service sockets live there: the system
  //   D-Bus, systemd-resolved (a DNS exfiltration channel), tailscaled (the
  //   operator's whole tailnet, off-box), libvirt (VMs with host devices),
  //   snapd, lxd, Docker, fail2ban, the per-user runtime dir with ssh-agent and
  //   gpg-agent. `--unshare-net` does NOT isolate AF_UNIX path sockets — a
  //   security re-review reached every one of these from a network-off
  //   sandbox. Masking them by name was a deny list; hiding the directory is
  //   the fix. Nothing under /run is bound back for a network-off run; see the
  //   resolv.conf note below for the one file a network-on run needs.
  //   $HOME, and $XDG_RUNTIME_DIR in case it lives outside /run.
  const hidden = new Set<string>();
  for (const runDir of ["/run", "/var/run"]) {
    if (isDir(runDir) && real(runDir) === path.resolve(runDir)) hidden.add(runDir);
  }
  if (isDir(home)) hidden.add(home);
  const runtimeDir = input.env["XDG_RUNTIME_DIR"];
  if (runtimeDir !== undefined && runtimeDir.length > 0 && isDir(runtimeDir)) {
    const resolved = real(runtimeDir);
    if (![...hidden].some((dir) => resolved === dir || resolved.startsWith(`${dir}${path.sep}`))) hidden.add(resolved);
  }
  // Flow 295 (N4): keryx's own config directory (auth.json, provider keys, the
  // schedule signing key) is hidden ALWAYS. It usually sits under $HOME, which is
  // hidden already, but `XDG_DATA_HOME` may point anywhere, and `--ro-bind / /` would
  // then expose it to every unattended command (with network `full`, off the box too).
  const configDir = keryxConfigDir();
  for (const extra of [configDir, ...(input.hide ?? [])]) {
    if (isDir(extra)) hidden.add(real(extra));
  }
  for (const dir of hidden) args.push("--tmpfs", dir);

  // `dispatch.network: true` only: /etc/resolv.conf is usually a symlink into
  // /run (systemd-resolved's stub file). With /run hidden it would dangle and
  // name resolution would fail. The FILE is bound back read-only — never the
  // directory holding the resolver's sockets.
  if (input.network) {
    const resolv = real("/etc/resolv.conf");
    if (resolv !== "/etc/resolv.conf" && exists(resolv) && !isDir(resolv)) args.push("--ro-bind", resolv, resolv);
  }

  // Bind back read-only what the run needs, then read-write the worktree and
  // the scratch home. Order matters: later mounts win.
  const readOnly = new Set<string>();
  for (const root of toolchainRoots(input.env["PATH"], home)) readOnly.add(root);
  for (const extra of input.readOnly) if (exists(extra)) readOnly.add(real(extra));
  for (const root of readOnly) args.push("--ro-bind", root, root);
  for (const rw of [input.worktree, input.scratchHome]) args.push("--bind", real(rw), real(rw));

  // Known secret paths, masked inside anything bound back (e.g. a toolchain
  // root that happens to hold a credentials file).
  for (const secret of defaultReadDenyList(home)) {
    const inside = [...readOnly].some((root) => secret === root || secret.startsWith(`${root}${path.sep}`));
    if (!inside || !exists(secret)) continue;
    if (isDir(secret)) args.push("--tmpfs", secret);
    else args.push("--ro-bind", "/dev/null", secret);
  }

  if (!input.network) args.push("--unshare-net");
  args.push("--unshare-pid", "--unshare-ipc", "--die-with-parent", "--new-session", "--chdir", real(input.worktree));

  const env: Record<string, string> = {};
  for (const name of UNATTENDED_ENV_ALLOWLIST) {
    const value = input.env[name];
    if (value !== undefined) env[name] = value;
  }
  const scratch = real(input.scratchHome);
  env["HOME"] = scratch;
  env["XDG_CONFIG_HOME"] = path.join(scratch, ".config");
  env["XDG_CACHE_HOME"] = path.join(scratch, ".cache");
  env["XDG_DATA_HOME"] = path.join(scratch, ".local", "share");
  env["BUN_INSTALL_CACHE_DIR"] = path.join(scratch, ".bun-cache");
  env["TMPDIR"] = "/tmp";
  // The same marker every `shell_exec` child carries (agent bus D-13).
  env["KERYX_TOOL_CALL"] = "1";

  const launcherPath = launcher.path;
  return {
    ok: true,
    launcher: launcherPath,
    args,
    env,
    wrap: (argv) => [launcherPath, ...args, "--", ...argv],
  };
}

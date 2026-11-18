// The hardened UNATTENDED sandbox on macOS — the Seatbelt (`sandbox-exec`) twin of
// the bubblewrap profile in unattended.ts.
//
// Pure: builds the SBPL text from paths the planner already resolved. The planner
// (`planUnattendedSandbox` in unattended.ts) does every host read.
//
// The interactive Seatbelt profile (seatbelt.ts) is allow-default with a DENY list of
// known secret paths — fine for a person who approves each command. This one keeps
// allow-default for process machinery (dyld, mach bootstrap, /usr, /System) but turns
// every boundary that matters into an ALLOW list, like the Linux profile:
//
//   writes      everything denied; only the worktree and the scratch HOME (whose
//               `tmp/` is TMPDIR) are writable, plus stdio devices. Git control
//               paths inside them stay read-only (git-protect.ts).
//   reads       $HOME, keryx's config dir, the shared scratch parent, /private/tmp,
//               /private/var/tmp and /private/var/folders (every user's temp and
//               cache dirs) are hidden WHOLESALE. Only what the run needs is let back
//               in: toolchain roots from PATH, the caller's read-only roots, the
//               worktree and the scratch home. The known-secret deny list is applied
//               again on top, inside anything let back in. Ancestors of a let-back
//               path keep only `stat` (path resolution needs it), never a listing.
//   network     off: every socket denied, AF_UNIX included. full: TCP/UDP allowed,
//               AF_UNIX denied except the system DNS resolver socket — macOS keeps
//               ssh-agent, Docker and other host services on UNIX sockets, which
//               the Linux profile hides with /run. `allowlist` is refused by the
//               planner: Seatbelt has no private network namespace for the
//               in-sandbox forwarder.
//   IPC         the keychain (securityd), the pasteboard and LaunchServices are
//               denied by mach service name; `open`, `osascript`, `launchctl`,
//               `security`, `crontab`, `at`, `pbcopy`/`pbpaste` cannot be executed.
//   processes   no signal to a process outside the run's own tree.

import { sbplString, seatbeltDeviceWriteRule, seatbeltGitProtectionRules, seatbeltLaunchHandoffRules } from "./seatbelt";
import type { GitProtection } from "./git-protect";

/** System DNS resolver socket — the one AF_UNIX endpoint a `network: full` run may reach. */
export const DARWIN_DNS_SOCKET = "/private/var/run/mDNSResponder";

/** Host directories hidden wholesale on every unattended macOS run, besides $HOME. */
export const DARWIN_HIDDEN_SYSTEM_DIRS: readonly string[] = ["/private/tmp", "/private/var/tmp", "/private/var/folders"];

/** Programs that hand work to something outside the profile, or read the keychain / pasteboard. */
export const DARWIN_UNATTENDED_DENIED_BINARIES: readonly string[] = [
  "/bin/launchctl",
  "/usr/bin/security",
  "/usr/bin/crontab",
  "/usr/bin/at",
  "/usr/bin/batch",
  "/usr/bin/pbcopy",
  "/usr/bin/pbpaste",
];

/** Keychain and pasteboard mach services. */
const DENIED_MACH_GLOBAL_NAMES = ["com.apple.SecurityServer", "com.apple.securityd.xpc"];
const DENIED_MACH_PREFIXES = ["com.apple.pasteboard"];

export interface UnattendedSeatbeltSpec {
  /** Canonical read-write roots (worktree, scratch home). */
  readonly writable: readonly string[];
  /** Canonical directories hidden wholesale (reads and writes). */
  readonly hidden: readonly string[];
  /** Canonical roots let back in read-only (toolchains, keryx, the repository). */
  readonly readBack: readonly string[];
  /** Secret paths denied again after the let-back (inside a read-only root). */
  readonly secrets: readonly string[];
  /** Directories that must stay `stat`-able so let-back paths resolve. */
  readonly metadataAncestors: readonly string[];
  /**
   * The user's own temp dir (`getconf DARWIN_USER_TEMP_DIR`), canonical. Apple's
   * `/usr/bin/git` shim (xcrun) writes its lookup cache there whatever TMPDIR says;
   * only those `xcrun_db*` files are let back in, so it stays quiet.
   */
  readonly userTempDir?: string;
  readonly network: "off" | "full";
  readonly git: GitProtection;
}

/** Escape every POSIX ERE metacharacter so `value` matches only itself. */
function regexLiteral(value: string): string {
  return value.replace(/[.[\]()*+?{}|^$\\]/g, "\\$&");
}

/** The xcrun lookup-cache files directly inside `userTempDir`, and nothing else there. */
function xcrunCacheRegex(userTempDir: string): string {
  return `^${regexLiteral(userTempDir)}/xcrun_db(-[^/]+)?$`;
}

/** Build the SBPL profile text for an unattended macOS run. Rules are evaluated last-match-wins. */
export function buildUnattendedSeatbeltProfile(spec: UnattendedSeatbeltSpec): string {
  const subpaths = (paths: readonly string[]): string => paths.map((p) => `(subpath ${sbplString(p)})`).join(" ");
  const lines: string[] = [
    "(version 1)",
    "(allow default)",
    "",
    ";; --- reads: hide host directories wholesale, then let back only what the run needs ---",
  ];
  if (spec.hidden.length > 0) lines.push(`(deny file-read* file-write* ${subpaths(spec.hidden)})`);
  if (spec.metadataAncestors.length > 0) {
    lines.push(`(allow file-read-metadata ${spec.metadataAncestors.map((p) => `(literal ${sbplString(p)})`).join(" ")})`);
  }
  if (spec.readBack.length > 0) lines.push(`(allow file-read* ${subpaths(spec.readBack)})`);
  if (spec.userTempDir !== undefined) {
    lines.push(`(allow file-read* (regex ${sbplString(xcrunCacheRegex(spec.userTempDir))}))`);
  }

  lines.push("", ";; --- writes: deny everything, then re-allow the worktree and the scratch home ---", '(deny file-write* (subpath "/"))');
  if (spec.writable.length > 0) lines.push(`(allow file-read* file-write* ${subpaths(spec.writable)})`);
  lines.push(seatbeltDeviceWriteRule());
  if (spec.userTempDir !== undefined) {
    lines.push(`(allow file-write* (regex ${sbplString(xcrunCacheRegex(spec.userTempDir))}))`);
  }
  lines.push(...seatbeltGitProtectionRules(spec.git));

  if (spec.secrets.length > 0) {
    lines.push("", ";; --- known secrets stay hidden inside anything let back in ---", `(deny file-read* file-write* ${subpaths(spec.secrets)})`);
  }

  lines.push("", ...seatbeltLaunchHandoffRules(DARWIN_UNATTENDED_DENIED_BINARIES));
  lines.push(
    "",
    ";; --- no keychain, no pasteboard ---",
    `(deny mach-lookup ${[
      ...DENIED_MACH_GLOBAL_NAMES.map((n) => `(global-name ${sbplString(n)})`),
      ...DENIED_MACH_PREFIXES.map((p) => `(global-name-prefix ${sbplString(p)})`),
    ].join(" ")})`,
    "",
    ";; --- no signal outside the run's own process tree ---",
    "(deny signal (target others))",
  );

  if (spec.network === "off") {
    lines.push("", ";; --- network off (AF_UNIX included) ---", "(deny network*)");
  } else {
    lines.push(
      "",
      ";; --- network full: IP only; host UNIX sockets (ssh-agent, Docker, …) stay unreachable ---",
      "(deny network-outbound (remote unix-socket))",
      `(allow network-outbound (remote unix-socket (path-literal ${sbplString(DARWIN_DNS_SOCKET)})))`,
    );
  }
  return `${lines.join("\n")}\n`;
}

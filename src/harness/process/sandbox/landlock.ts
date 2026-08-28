// Linux Landlock ruleset builder (flows 145, 146) — requirements package
// `keryx-linux-containment`, specification §4, acceptance criteria AC1/AC2.
//
// Pure: a `SandboxProfile`, the grants the host offers and the kernel's Landlock
// ABI version in, a ruleset *description* out. No syscall, no `bun:ffi`, no
// spawn, no filesystem, no `process.platform`. Applying a ruleset to a process
// is a different module (`landlock-exec.ts`); this one mirrors `bwrap.ts` — data
// in, data out, offline-testable.
//
// ## The model, and why it decides everything below
//
// `landlock_create_ruleset` takes `handled_access_fs`: the set of access rights
// the ruleset *restricts*. A right that is not handled stays completely
// unrestricted. Rules then add back allowances for path hierarchies, and they
// are cumulative along the path — kernel documentation, *Layers of file path
// access rights*: "one policy layer grants access to a file path if at least one
// of its rules encountered on the path grants the access". There are no deny
// rules, and `landlock_add_rule` rejects an empty `allowed_access` (`ENOMSG`),
// so a deeper rule cannot narrow a shallower one.
//
// ### Grant, do not deny (specification §4.4)
//
// The first version of this module handled only the write rights, left every
// read unrestricted, and refused any profile carrying a `readDenyList`. That was
// a faithful reading of the old design and it made the layer useless:
// `sandboxProfileFromPolicy` and `defaultSandboxProfile` both call
// `defaultReadDenyList(home)`, so **every profile the product actually builds**
// carries one. The layer would have served nothing.
//
// Landlock cannot express "everything is readable except these fifteen paths" —
// nesting adds rights to a subtree and can never remove them. So the deny list is
// not translated, it is **inverted**:
//
// | | bubblewrap | Landlock |
// |---|---|---|
// | Starting point | `--ro-bind / /` — everything readable | nothing readable |
// | Secrets handled by | punching holes (`--tmpfs` over each path) | never granting `$HOME` |
//
// Read is granted to the system roots, the directories the command's `PATH`
// names, the workspace and the session temp directory. `$HOME` is not granted,
// so every path in `readDenyList` is unreachable because it was never reachable.
// That is strictly stronger than the list — it also covers the credential file
// nobody thought to list.
//
// It is not automatic, and this module does not assume it. A deny path that
// falls inside a granted root (a secret outside `$HOME`, or a `$HOME` that IS
// the workspace) would stay readable, so {@link buildLandlockRuleset} checks
// every deny path against every grant and **fails** (AC2) rather than quietly
// leaving it open.
//
// Four further consequences, each load-bearing:
//
// 1. **The ABI floor is derived, not chosen.** `landlock_create_ruleset` fails
//    with `EINVAL` on a mask containing bits the running kernel does not know.
//    The common workaround is to mask the request down to the kernel's ABI —
//    best-effort, which is another word for approximate. Instead the required
//    rights produce a `minimumAbi`, and a kernel below it is an explicit
//    failure that names the ABI (PRD R6), never a downgraded ruleset.
// 2. **A subtree that needs more rights gets its own nested rule — never a
//    wider ancestor.** Rights accumulate downwards, so widening an ancestor to
//    reach one descendant grants the widened set to *every* descendant. The
//    step-2 spike (flow 143) hit this on `/dev`: widening all of `/dev` to make
//    `/dev/shm` writable also bought the ability to unlink device nodes. The
//    correct shape is a narrow rule deeper in the tree, so `pathRules` is an
//    ordered list that may contain a path beneath another path with a different
//    `allow` set, and nothing here merges, sorts or de-duplicates rules by
//    prefix. The applier must add every rule exactly as given.
//
//    The asymmetry is the whole model in one line: nesting can *add* rights to a
//    subtree and can never *remove* them. That is why (2) works and a deny list
//    cannot.
// 3. **A rule on a regular file may carry only the file-applicable rights.**
//    Measured, not inferred: `landlock_add_rule` on `~/.gitconfig` with
//    `read_dir` in the mask returns `EINVAL`, and the same rule with `read_file`
//    alone installs and works. See {@link FILE_APPLICABLE_RIGHTS}.
// 4. **A denial is not an absence.** bubblewrap mounts an empty tmpfs over a
//    secret, so a tool sees "no such file" and moves on. Landlock returns
//    `EACCES` on the real file, and some tools treat that as fatal — measured:
//    `git` exits 128 with "fatal: unknown error occurred while reading the
//    configuration files" when `~/.gitconfig` exists and cannot be read. That is
//    why {@link landlockHomeReadFiles} exists, and why every entry in it is a
//    measurement rather than a guess.
//
// ## What this ruleset does not reach, stated rather than hidden
//
// - **Metadata mutation.** Landlock has no access right for `chmod`, `chown`,
//   `setxattr` or `utime` at any ABI, nor for `ioctl` on a regular file, so they
//   stay permitted wherever DAC already permits them — including outside the
//   writable roots. bubblewrap's `--ro-bind / /` refuses those with `EROFS`, so
//   **layer 1's filesystem boundary is data-only and layer 2's is not**, and the
//   two are not interchangeable. This is not expressible as a translation
//   failure without deleting the Landlock layer outright, so it is named instead
//   — mechanically, in {@link LANDLOCK_RESIDUAL_ACTIONS}, so a reporting layer
//   cannot omit it by forgetting a comment. That list also carries `fcntl` and
//   `flock`, which neither layer restricts and which do not cross a write
//   boundary at all; it says so per entry rather than averaging the claim.
// - **`ioctl` on a device, which is the same syscall at a different
//   granularity.** `LANDLOCK_ACCESS_FS_IOCTL_DEV` (ABI 5) covers an opened
//   character or block device and nothing else, so "the kernel cannot restrict
//   ioctl" is false from ABI 5 for devices and true at every ABI for regular
//   files. Both halves are recorded, separately. Not handling the device half is
//   a keryx deferral: the handled set would have to grant it back on the
//   controlling terminal or ordinary `TIOCGWINSZ`-class calls would fail, and
//   `SandboxProfile` carries nothing that says which terminal that is.
//   bubblewrap covers the sharp edge (tty injection) with `--new-session`, which
//   Landlock has no equivalent of.
// - **Descriptors opened before the ruleset was applied.** Landlock evaluates at
//   `open`, not at `write` — the same fact that makes inherited stdio work
//   without a rule. A descriptor the process already holds when it calls
//   `landlock_restrict_self` stays usable whatever the ruleset says. It is a
//   property of the mechanism rather than of a syscall, so it is stated here and
//   not in the residue list.
// - **PID / IPC / session isolation.** bubblewrap's `--unshare-pid`,
//   `--unshare-ipc` and `--new-session` have no `SandboxProfile` representation.
//   Landlock ABI 6 scoping could carry part of it later; nothing here pretends
//   it already does.
// - **Network, entirely.** Landlock's network access types cover TCP
//   `bind`/`connect` and nothing else; UDP (including DNS), raw and unix-domain
//   sockets are outside them. Specification §4.3 and PRD R2 make `network:
//   "off"` a bubblewrap profile until a seccomp filter closes that gap, and
//   `network: "restricted"` needs a proxy Landlock cannot force traffic through.
//   Both are translation failures, so no ruleset carries a network rule and
//   {@link LandlockRuleset}'s network fields are typed `readonly never[]` — the
//   guard against a second false green is the type, not a convention.

import { posix as posixPath } from "node:path";
import type { SandboxProfile } from "./profile";

/**
 * A Landlock filesystem access right, by kernel name (lower-cased, without the
 * `LANDLOCK_ACCESS_FS_` prefix).
 */
export type LandlockFsAccess =
  | "execute"
  | "write_file"
  | "read_file"
  | "read_dir"
  | "remove_dir"
  | "remove_file"
  | "make_char"
  | "make_dir"
  | "make_reg"
  | "make_sock"
  | "make_fifo"
  | "make_block"
  | "make_sym"
  | "refer"
  | "truncate"
  | "ioctl_dev";

/** Bit position of each filesystem right in `landlock_ruleset_attr.handled_access_fs`. */
export const LANDLOCK_FS_ACCESS_BIT: Readonly<Record<LandlockFsAccess, number>> = Object.freeze({
  execute: 0,
  write_file: 1,
  read_file: 2,
  read_dir: 3,
  remove_dir: 4,
  remove_file: 5,
  make_char: 6,
  make_dir: 7,
  make_reg: 8,
  make_sock: 9,
  make_fifo: 10,
  make_block: 11,
  make_sym: 12,
  refer: 13,
  truncate: 14,
  ioctl_dev: 15,
});

/** The Landlock ABI version in which each filesystem right first exists. */
export const LANDLOCK_FS_ACCESS_MIN_ABI: Readonly<Record<LandlockFsAccess, number>> = Object.freeze({
  execute: 1,
  write_file: 1,
  read_file: 1,
  read_dir: 1,
  remove_dir: 1,
  remove_file: 1,
  make_char: 1,
  make_dir: 1,
  make_reg: 1,
  make_sock: 1,
  make_fifo: 1,
  make_block: 1,
  make_sym: 1,
  refer: 2,
  truncate: 3,
  ioctl_dev: 5,
});

/**
 * The rights a rule whose target is a **regular file** may carry.
 *
 * Measured on Ubuntu 24.04 / kernel 6.8, Landlock ABI 4: a `path_beneath` rule on
 * `~/.gitconfig` carrying `execute | read_file | read_dir` is rejected with
 * `EINVAL`; the same rule carrying `read_file` alone installs, and the file then
 * reads while its directory stays closed. The kernel's own wording is that a
 * rule may only allow accesses "applicable to the file type"; directory-only
 * rights on a file are not applicable.
 *
 * `ioctl_dev` is absent because this module never handles it (module header).
 */
export const FILE_APPLICABLE_RIGHTS: readonly LandlockFsAccess[] = Object.freeze([
  "execute",
  "write_file",
  "read_file",
  "truncate",
]);

/** One action a ruleset from this module leaves unrestricted, and why. */
export interface LandlockResidualAction {
  /** The action, at the granularity Landlock's access rights distinguish. */
  readonly action: string;
  /**
   * The Landlock ABI from which the kernel *could* restrict it, or `null` when
   * no ABI can.
   *
   * The distinction is the point of this field: `null` is a kernel limitation,
   * a number is a keryx decision, and reporting a decision as a limitation is
   * the same class of untrue statement this package exists to remove.
   */
  readonly restrictableFromAbi: number | null;
  /**
   * Whether bubblewrap's `--ro-bind / /` refuses it with `EROFS`. Where this is
   * true, layer 2's boundary is genuinely stronger than layer 1's and the two
   * must not be reported as equivalent. Where it is false, neither layer stops
   * it and the action is simply outside what either expresses.
   */
  readonly refusedByBubblewrap: boolean;
  readonly note: string;
}

/**
 * Everything a ruleset from this module does not restrict, as data.
 *
 * Every entry of the kernel's `landlock(7)` CAVEATS list that acts on a file.
 * That list also names `chdir`, `stat` and `access`, which act on the process or
 * merely answer a question, so there is nothing for a ruleset to have missed;
 * they are deliberately absent.
 *
 * Whether an entry crosses a write boundary is `refusedByBubblewrap`, not a
 * criterion for being here — `fcntl` and `flock` are listed precisely so a
 * reporting layer can say that neither layer restricts them and neither needs
 * to.
 *
 * `ioctl` appears **twice, at different granularity**, because Landlock splits
 * it and a single entry cannot be true of both halves.
 *
 * Exported so `sandbox status` and the capability matrix can state the residue
 * from a value rather than from a comment someone has to remember to read.
 */
export const LANDLOCK_RESIDUAL_ACTIONS: readonly LandlockResidualAction[] = Object.freeze([
  Object.freeze({
    action: "chmod",
    restrictableFromAbi: null,
    refusedByBubblewrap: true,
    note: "no Landlock access right covers mode changes at any ABI.",
  }),
  Object.freeze({
    action: "chown",
    restrictableFromAbi: null,
    refusedByBubblewrap: true,
    note: "no Landlock access right covers ownership changes at any ABI.",
  }),
  Object.freeze({
    action: "setxattr",
    restrictableFromAbi: null,
    refusedByBubblewrap: true,
    note: "no Landlock access right covers extended attributes at any ABI.",
  }),
  Object.freeze({
    action: "utime",
    restrictableFromAbi: null,
    refusedByBubblewrap: true,
    note: "the utime/utimensat family; no Landlock access right covers timestamps at any ABI.",
  }),
  Object.freeze({
    action: "ioctl on a regular file or directory",
    restrictableFromAbi: null,
    refusedByBubblewrap: true,
    note: "LANDLOCK_ACCESS_FS_IOCTL_DEV covers devices only, so commands such as FS_IOC_SETFLAGS through an O_RDONLY descriptor are restrictable at no ABI.",
  }),
  Object.freeze({
    action: "ioctl on a character or block device",
    restrictableFromAbi: 5,
    refusedByBubblewrap: false,
    note: "LANDLOCK_ACCESS_FS_IOCTL_DEV. Not handled: the ruleset would have to grant it back on the controlling terminal or ordinary TIOCGWINSZ-class calls fail, and SandboxProfile does not say which terminal that is.",
  }),
  Object.freeze({
    action: "fcntl",
    restrictableFromAbi: null,
    refusedByBubblewrap: false,
    note: "descriptor flags and advisory locks are kernel state, not filesystem content, so a read-only bind does not refuse them either; it does not cross the write boundary.",
  }),
  Object.freeze({
    action: "flock",
    restrictableFromAbi: null,
    refusedByBubblewrap: false,
    note: "an advisory lock succeeds on a read-only mount, so bubblewrap does not refuse it either; it does not cross the write boundary.",
  }),
]);

/**
 * The rights that constitute reading: opening a file, listing a directory, and
 * executing a program. Handled by every ruleset this module builds, which is
 * what makes the grant list a boundary rather than a suggestion.
 *
 * `execute` is here rather than in the write set because it is a *read* of a
 * program image: withholding it is how a contained command is stopped from
 * running a binary out of an ungranted directory.
 */
const READ_ACCESS_RIGHTS: readonly LandlockFsAccess[] = Object.freeze([
  "execute",
  "read_file",
  "read_dir",
]);

/**
 * The rights that together constitute "modifying file *data* or directory
 * structure", and therefore what a `read-only` or `workspace-write` profile
 * bounds as far as Landlock can reach.
 *
 * `refer` is in the set on purpose. Without handling it, cross-directory rename
 * and link are denied outright — stricter than the profile asks for, and it
 * would break an ordinary `mv` inside the workspace. `truncate` is in the set
 * because without it a contained command can empty a file outside the writable
 * roots, which is a hole in the boundary rather than a convenience.
 *
 * `ioctl_dev` is absent for the reason given in the module header.
 */
const WRITE_ACCESS_RIGHTS: readonly LandlockFsAccess[] = Object.freeze([
  "write_file",
  "remove_dir",
  "remove_file",
  "make_char",
  "make_dir",
  "make_reg",
  "make_sock",
  "make_fifo",
  "make_block",
  "make_sym",
  "refer",
  "truncate",
]);

/**
 * Everything a ruleset from this module restricts. Read and write together:
 * under the grant model reads are bounded too, so `read_file`, `read_dir` and
 * `execute` are handled and given back only beneath the granted roots.
 */
const HANDLED_FS_RIGHTS: readonly LandlockFsAccess[] = Object.freeze([
  ...READ_ACCESS_RIGHTS,
  ...WRITE_ACCESS_RIGHTS,
]);

/**
 * The system directories a command needs merely to *start*, measured on Ubuntu
 * 24.04 (kernel 6.8, Landlock ABI 4) rather than copied from a container image.
 *
 * `/run/systemd/resolve` is the one entry that is not about starting a process:
 * on a systemd host `/etc/resolv.conf` is a symlink into it, a rule path is
 * resolved when it is opened, and without the grant every name lookup fails —
 * measured as `curl: (6) Could not resolve host`. Landlock only ever serves a
 * profile whose network is **on** (§4.3 sends `off` and `restricted` to
 * bubblewrap), so DNS is not an edge case for this layer, it is the normal case.
 *
 * Every entry is `skip`-on-missing: `/lib64` does not exist on aarch64 and
 * `/run/systemd/resolve` does not exist off systemd, and dropping a rule for a
 * directory that is not there can only ever over-restrict.
 *
 * Deliberately absent: `/tmp` (the session temp directory is granted by name, so
 * a contained command cannot read another session's scratch), `/home`, `/root`,
 * `/var`, `/opt`, `/srv`, `/mnt`, `/media`, `/run` at large.
 */
export const LANDLOCK_SYSTEM_READ_ROOTS: readonly string[] = Object.freeze([
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/etc",
  "/proc",
  "/sys",
  "/run/systemd/resolve",
]);

/**
 * The `$HOME` files a ruleset grants read on, and nothing else under `$HOME`.
 *
 * **Every entry here is a reviewed widening of the boundary, and every entry was
 * measured against a real command** (specification §4.4, consequence 2;
 * implementation plan step 3). The measurement runbook and its output are in
 * `docs/requirements/keryx-linux-containment/measure/`.
 *
 * | Path | The command | What was measured without the grant |
 * |---|---|---|
 * | `~/.gitconfig` | `git status`, `git log`, `git commit` | exit **128**, `fatal: unknown error occurred while reading the configuration files` — git treats `EACCES` on an existing config as fatal, where bubblewrap's empty tmpfs makes it merely absent |
 * | `~/.config/git` | the same three, with the config at git's XDG location | the same exit 128 |
 *
 * Both are granted **read only, on the file or directory itself** — never on
 * `~/.config`, which holds `gh`, `gcloud` and keryx's own credentials and is on
 * the deny list. A grant of `~/.config` would be caught by
 * {@link buildLandlockRuleset}'s deny-overlap check and refused, which is the
 * intended safety net rather than a hypothetical.
 *
 * Nothing else is here. `~/.ssh`, `~/.aws`, `~/.npmrc`, `~/.cache`, `~/.local`
 * and the rest of `$HOME` stay unreachable, which is the entire point of §4.4.
 */
export function landlockHomeReadFiles(home: string | undefined): string[] {
  if (home === undefined || home.length === 0) {
    return [];
  }
  return [posixPath.join(home, ".gitconfig")];
}

/**
 * The `$HOME` directories a ruleset grants read on. See
 * {@link landlockHomeReadFiles} for the measurement and the rule about what may
 * be added here.
 */
export function landlockHomeReadDirs(home: string | undefined): string[] {
  if (home === undefined || home.length === 0) {
    return [];
  }
  return [posixPath.join(home, ".config/git")];
}

/**
 * Character devices that stay writable regardless of mode, mirroring
 * `seatbelt.ts`'s `DEVICE_WRITE_LITERALS`. `2>/dev/null` has to keep working
 * under a write-deny or containment is unusable rather than strict.
 *
 * Three deliberate omissions relative to the nine-entry macOS list — count them
 * against `seatbelt.ts` when auditing, because that is what this list is for:
 *
 * - `/dev/dtracehelper`, which does not exist on Linux.
 * - `/dev/stdin`, `/dev/stdout`, `/dev/stderr`. Landlock checks `open`, not
 *   `write`, so **inherited** stdio needs no rule at all. Opening those paths
 *   explicitly does need one — but on Linux they are symlinks into
 *   `/proc/self/fd`, and a rule path is resolved when the applier opens it, so
 *   the rule would land on whatever the descriptor currently points at and grant
 *   write there. That is a hole, not a carve-out.
 * - `/dev/random`, `/dev/urandom`. Reads are covered by the `/dev` read grant.
 */
const DEVICE_WRITE_PATHS: readonly string[] = Object.freeze(["/dev/null", "/dev/zero", "/dev/tty"]);

/**
 * What a device carve-out grants: writing the device, and `truncate` because
 * `> /dev/null` opens with `O_TRUNC`. Never `ioctl_dev`, which is unhandled.
 * Read comes from the `/dev` rule below, cumulatively.
 */
const DEVICE_WRITE_RIGHTS: readonly LandlockFsAccess[] = Object.freeze(["write_file", "truncate"]);

/** The device tree itself: readable and listable, never writable as a whole. */
const DEVICE_READ_RIGHTS: readonly LandlockFsAccess[] = Object.freeze(["read_file", "read_dir"]);

/**
 * `/dev/shm` is a tmpfs on which `shm_open`/`sem_open` create and unlink
 * ordinary files, so Chromium, Python multiprocessing and libpq fail with
 * `EACCES` under a device-only `/dev` grant. The fix is this **nested** rule and
 * not a wider `/dev`: widening `/dev` would let a contained process unlink
 * device nodes to solve a shared-memory problem (flow 143, `verify.sh` §6c).
 *
 * It is a write grant, so a `read-only` profile does not get it.
 */
const SHARED_MEMORY_PATH = "/dev/shm";

/**
 * What the applier does with a rule whose path does not exist when it opens it.
 *
 * - `fail` — abort, do not run the command. A writable root that is absent means
 *   the workspace is not there; running anyway would silently drop the rule and
 *   leave the command with no writable directory at all.
 * - `skip` — drop the rule and continue. Only ever over-restrictive, and used
 *   for the system roots (`/lib64` is absent on aarch64) and the device
 *   carve-outs (a container without `/dev/tty` has nothing to allow).
 *   `bwrap.ts` takes the same position on a missing mask target.
 */
export type LandlockMissingPathDisposition = "fail" | "skip";

/** What a rule's path is expected to be on disk. */
export type LandlockRuleTarget = "directory" | "file";

/**
 * One `landlock_add_rule(fd, LANDLOCK_RULE_PATH_BENEATH, …)` call.
 *
 * Rules may nest: a rule's `path` may lie beneath another rule's `path`, with a
 * different and possibly narrower `allow` set. Rights accumulate downwards, so a
 * nested rule adds to whatever an ancestor already granted and can never subtract
 * from it — see consequence (2) in the module header. The applier issues every
 * rule; it must not drop one because an ancestor exists, and it must never widen
 * an ancestor to reach a descendant.
 */
export interface LandlockPathRule {
  /**
   * Absolute, canonical path of the hierarchy root; the applier opens it
   * `O_PATH`. Symlinks are resolved by that open, so the rule binds to the
   * target — callers must pass paths they intend resolved.
   */
  readonly path: string;
  /** Rights allowed beneath `path`. Always a non-empty subset of `handledFs`. */
  readonly allow: readonly LandlockFsAccess[];
  /** What to do when `path` does not exist at apply time. */
  readonly onMissing: LandlockMissingPathDisposition;
  /**
   * What `path` is expected to be. A `file` rule may carry only
   * {@link FILE_APPLICABLE_RIGHTS} — the kernel answers a directory-only right
   * on a file with `EINVAL`, which reads like a permissions bug and is not one.
   * The applier verifies the target matches and fails closed if it does not.
   */
  readonly target: LandlockRuleTarget;
}

/**
 * A complete Landlock ruleset, as data.
 *
 * There is deliberately no `notEnforced`, `partial` or `bestEffort` field. A
 * value of this type handles every access right Landlock has that the profile
 * bounds, except the ones in {@link LANDLOCK_RESIDUAL_ACTIONS}; anything less
 * is a {@link LandlockInexpressible}, not a weaker ruleset. A per-translation
 * field for recording "and this part is not covered" is exactly where an
 * approximated boundary would hide, and the boundary would then be reported as
 * real — the defect ADR-0010 exists to remove.
 */
export interface LandlockRuleset {
  /**
   * Lowest kernel Landlock ABI that can enforce this ruleset faithfully — the
   * maximum first-ABI over every handled right. Not a preference: below it,
   * `landlock_create_ruleset` rejects the mask. When network rights are one day
   * handled, they must be folded into this maximum too.
   */
  readonly minimumAbi: number;
  /** `landlock_ruleset_attr.handled_access_fs`, by name. Never empty. */
  readonly handledFs: readonly LandlockFsAccess[];
  /**
   * `landlock_ruleset_attr.handled_access_net`. Typed empty: Landlock's network
   * rights are TCP-only and no profile may be served by them (§4.3, PRD R2), so
   * the impossibility is a type error rather than a convention. The flow that
   * pairs Landlock with a seccomp filter widens this.
   */
  readonly handledNet: readonly never[];
  /**
   * Path-beneath allow-rules, in a deterministic order. May contain nested
   * paths with differing `allow` sets ({@link LandlockPathRule}); the order is
   * stable for reporting and diffing, and carries no precedence — Landlock
   * accumulates, so no ordering of these rules changes what they grant.
   */
  readonly pathRules: readonly LandlockPathRule[];
  /** Net-port allow-rules. Typed empty for the same reason as `handledNet`. */
  readonly netRules: readonly never[];
}

/**
 * The host facts a translation needs and `SandboxProfile` does not carry.
 *
 * Injected rather than read, so this module stays pure and every test is offline
 * (AC1). `SandboxProfile` is unchanged by this package (specification §8), and
 * these are not profile fields: they describe the machine, not the policy.
 */
export interface LandlockGrants {
  /**
   * Absolute directories granted read + list + execute, whose **absence is not
   * an error**: the system roots, the directories on the command's `PATH` and
   * the measured `$HOME` directories. `/lib64` is absent on aarch64 and a `PATH`
   * entry that does not exist is ordinary, so a missing one drops its rule,
   * which can only ever over-restrict. {@link landlockReadRoots} composes them.
   */
  readonly readRoots: readonly string[];
  /**
   * Absolute directories granted read + list + execute whose **absence is an
   * error**: the working directory, and anything else the command genuinely
   * cannot run without. Under `workspace-write` these are usually also writable
   * roots, in which case the writable rule subsumes them and no read rule is
   * emitted; under `read-only` this is the only thing that makes the workspace
   * readable at all.
   */
  readonly requiredReadRoots?: readonly string[];
  /**
   * Absolute regular files granted read, and only read. Bounded to what
   * {@link landlockHomeReadFiles} measured; a directory here would be refused by
   * the kernel with `EINVAL`.
   */
  readonly readFiles?: readonly string[];
  /**
   * `$HOME`, when known. Used for one check only: **no grant may be `$HOME` or
   * an ancestor of it**. Without it the deny-overlap check still catches a
   * populated `readDenyList`, but a profile with an empty one (a caller that
   * built a profile without a home) would slip through, and "grant everything
   * except `$HOME`" would silently become "grant everything".
   */
  readonly home?: string;
}

/**
 * Compose the read grants for a host.
 *
 * Pure and order-stable: system roots first (they are the same on every run),
 * then the `PATH` directories in the order the command's own `PATH` names them,
 * then the workspace roots. Duplicates are dropped, keeping the first
 * occurrence.
 *
 * `pathDirs` is how a program installed under `$HOME` stays runnable without
 * granting `$HOME`. It is a **reviewed widening**: `PATH` is the only statement
 * keryx has about where executables legitimately come from, and it arrives from
 * the command's own environment, which the harness composed. Measured: with
 * `~/.bun/bin` granted, `bun --version` and `bun -e …` run; without it, `execve`
 * fails `EACCES` and the launcher exits 125 rather than running anything. A
 * `PATH` entry that would expose a deny-listed path is refused by
 * {@link buildLandlockRuleset}, not silently accepted.
 */
export function landlockReadRoots(input: {
  readonly pathDirs?: readonly string[];
  readonly systemRoots?: readonly string[];
  readonly homeReadDirs?: readonly string[];
}): string[] {
  return [
    ...new Set([
      ...(input.systemRoots ?? LANDLOCK_SYSTEM_READ_ROOTS),
      ...(input.pathDirs ?? []),
      ...(input.homeReadDirs ?? []),
    ]),
  ];
}

/**
 * Why a profile has no faithful Landlock representation. Machine-readable so a
 * caller can route on the cause — most usefully, to the bubblewrap layer. Each
 * `detail` carries the full reasoning; this list records only the disposition.
 *
 * - `danger-full-access-is-not-contained` — the escape hatch is not a
 *   containment profile. Terminal; no other reason is evaluated.
 * - `network-off-requires-seccomp` — specification §4.3 / PRD R2. Falls back to
 *   the bubblewrap layer.
 * - `network-restricted-requires-proxy-layer` — ADR-0010 defers a domain
 *   allowlist to the container layer.
 * - `read-deny-path-inside-grant` — a path whose read must be denied lies inside
 *   (or contains) a path this ruleset would grant. Specification §4.4's last
 *   paragraph, and AC2: the grant construction covers `$HOME` and must be
 *   *checked* for everything else, never assumed.
 * - `grant-would-expose-home` — a grant is `$HOME` or an ancestor of it, which
 *   would make the whole inversion vacuous.
 * - `no-read-grant` — nothing is readable, so nothing could run. A ruleset with
 *   no read rule is not a strict boundary, it is a broken one.
 * - `path-not-absolute`, `path-contains-nul`, `path-not-canonical` — the applier
 *   resolves a rule path by opening it; none of these forms can be opened
 *   predictably, and a non-canonical one would print differently from what it
 *   enforces.
 * - `landlock-unavailable` — the kernel reports ABI 0.
 * - `abi-unreadable` — the ABI value is not an ABI version at all, which is a
 *   statement about the reader and not about the kernel.
 * - `abi-too-low` — Landlock exists but lacks a right this profile's boundary
 *   depends on. The reason names the ABI, not the operating system (PRD R6).
 */
export type LandlockInexpressibleCode =
  | "danger-full-access-is-not-contained"
  | "network-off-requires-seccomp"
  | "network-restricted-requires-proxy-layer"
  | "read-deny-path-inside-grant"
  | "grant-would-expose-home"
  | "no-read-grant"
  | "path-not-absolute"
  | "path-contains-nul"
  | "path-not-canonical"
  | "landlock-unavailable"
  | "abi-unreadable"
  | "abi-too-low";

/** One reason a profile cannot be expressed as a Landlock ruleset. */
export interface LandlockInexpressible {
  readonly code: LandlockInexpressibleCode;
  /**
   * The input the failure is about. `"abi"` is the kernel and `"grants"` the
   * host paths; neither is a profile field.
   */
  readonly field: keyof SandboxProfile | "abi" | "grants";
  /** Operator-readable; safe to surface verbatim in `sandbox status`. */
  readonly detail: string;
}

/**
 * The result of translating a profile. Either a ruleset that covers everything
 * Landlock can reach of the profile, or the reasons it cannot — never both, and
 * never a ruleset that covers only part of what Landlock *can* reach.
 */
export type LandlockTranslation =
  | { readonly ok: true; readonly ruleset: LandlockRuleset }
  | { readonly ok: false; readonly failures: readonly LandlockInexpressible[] };

/** Fold filesystem rights into the `__u64` bitmask the kernel expects. */
export function landlockFsMask(access: readonly LandlockFsAccess[]): bigint {
  return access.reduce((mask, a) => mask | (1n << BigInt(LANDLOCK_FS_ACCESS_BIT[a])), 0n);
}

/**
 * The lowest Landlock ABI that can carry any containment profile this module
 * builds — `truncate`, ABI 3.
 *
 * It applies to `read-only` as much as to `workspace-write`, and that is not an
 * oversight. A `read-only` profile denies every write, so it handles the write
 * rights with no rule granting them back; a handled set without `truncate`
 * would leave `open(O_TRUNC)` and `truncate(2)` unrestricted **filesystem-wide**
 * while the profile claimed to permit no writes at all. Dropping `truncate` to
 * reach kernel 5.15 was rejected twice in flow 145's review and again in flow
 * 146: below ABI 3 a containment profile selects bubblewrap.
 */
export const LANDLOCK_MINIMUM_ABI: number = Math.max(
  ...HANDLED_FS_RIGHTS.map((a) => LANDLOCK_FS_ACCESS_MIN_ABI[a]),
);

/**
 * Translate a `SandboxProfile` into a Landlock ruleset description.
 *
 * Deterministic and offline: `abi` and `grants` are injected rather than probed,
 * so the same inputs always produce the same output and the tests need no
 * kernel. Failures are accumulated in a fixed order so the output is stable, and
 * a profile that cannot be expressed returns every reason it cannot rather than
 * the first.
 *
 * @param profile the resolved OS-sandbox profile, unchanged from `profile.ts`
 * @param abi the kernel's Landlock ABI version; `0` means Landlock is absent
 * @param grants the host paths this ruleset may grant (specification §4.4)
 */
export function buildLandlockRuleset(
  profile: SandboxProfile,
  abi: number,
  grants: LandlockGrants,
): LandlockTranslation {
  // Terminal on its own: the escape hatch is not a containment profile, so every
  // remaining check would be describing a ruleset that must never exist.
  if (profile.mode === "danger-full-access") {
    return { ok: false, failures: [escapeHatchFailure()] };
  }

  // `writableRoots` is documented as "empty for read-only", so the mode is the
  // authority. Honouring roots on a `read-only` profile would quietly widen a
  // read-only claim into workspace-write; ignoring them can only over-restrict.
  // Duplicates are dropped by exact string so one bad root is reported once, but
  // nothing is rewritten before validation: a failure `detail` must quote the
  // value the caller actually supplied, or the operator cannot map it back.
  const rawWritable = profile.mode === "workspace-write" ? [...new Set(profile.writableRoots)] : [];
  const rawReadRoots = [...new Set(grants.readRoots)];
  const rawRequiredReadRoots = [...new Set(grants.requiredReadRoots ?? [])];
  const rawReadFiles = [...new Set(grants.readFiles ?? [])];
  const allGranted = [...rawWritable, ...rawReadRoots, ...rawRequiredReadRoots, ...rawReadFiles];

  const failures = [
    ...networkFailures(profile),
    ...pathShapeFailures(rawWritable, "writableRoots"),
    ...pathShapeFailures([...rawReadRoots, ...rawRequiredReadRoots, ...rawReadFiles], "grants"),
    ...readGrantPresenceFailures([...rawReadRoots, ...rawRequiredReadRoots, ...rawWritable]),
    ...homeExposureFailures(allGranted, grants.home),
    ...denyOverlapFailures(profile, allGranted),
    ...abiFailures(abi),
  ];
  if (failures.length > 0) {
    return { ok: false, failures };
  }

  // Every path is valid here, so the only rewrite left is dropping a trailing
  // slash — after which `/work/repo` and `/work/repo/` are one rule, not two.
  const writable = [...new Set(rawWritable.map(stripTrailingSlash))];
  const writableSet = new Set(writable);
  // A path that is writable is already granted read by its own rule, so listing
  // it again as a read root would emit a second, weaker rule for the same
  // hierarchy. Landlock would accumulate them to the same result; the duplicate
  // would only make the reported ruleset harder to read.
  const readRoots = [...new Set(rawReadRoots.map(stripTrailingSlash))].filter(
    (path) => !writableSet.has(path),
  );
  const readRootSet = new Set(readRoots);
  const requiredReadRoots = [...new Set(rawRequiredReadRoots.map(stripTrailingSlash))].filter(
    (path) => !writableSet.has(path) && !readRootSet.has(path),
  );
  const readFiles = [...new Set(rawReadFiles.map(stripTrailingSlash))];

  return {
    ok: true,
    ruleset: Object.freeze({
      minimumAbi: LANDLOCK_MINIMUM_ABI,
      handledFs: HANDLED_FS_RIGHTS,
      handledNet: Object.freeze([]) as readonly never[],
      pathRules: pathRules(profile, { readRoots, requiredReadRoots, readFiles, writable }),
      netRules: Object.freeze([]) as readonly never[],
    }),
  };
}

function escapeHatchFailure(): LandlockInexpressible {
  return {
    code: "danger-full-access-is-not-contained",
    field: "mode",
    detail:
      'mode "danger-full-access" is the explicit no-containment escape hatch; it has no Landlock ruleset, and the wrap dispatcher skips containment for it entirely.',
  };
}

function networkFailures(profile: SandboxProfile): LandlockInexpressible[] {
  // `off` is checked first because it is the stricter posture: a profile that is
  // network-off while still carrying a stale allowlist must be diagnosed as
  // network-off, or a caller routing on the code sends it to the wrong layer.
  if (profile.network === "off") {
    return [
      {
        code: "network-off-requires-seccomp",
        field: "network",
        detail:
          'network "off" is not expressible in Landlock: its network access types cover TCP bind/connect only, leaving UDP (including DNS), raw and unix-domain sockets open. Until a seccomp filter covers them this profile belongs to the bubblewrap layer (specification §4.3).',
      },
    ];
  }
  // A domain allowlist implies `restricted` even if the network field disagrees:
  // the profile would otherwise describe itself as less constrained than it is.
  if (profile.network === "restricted" || profile.allowedDomains.length > 0) {
    return [
      {
        code: "network-restricted-requires-proxy-layer",
        field: "network",
        detail:
          'network "restricted" needs traffic forced through the loopback allowlist proxy, and Landlock gates TCP by port rather than by name; no ruleset can express a domain allowlist (ADR-0010 defers it to the container layer).',
      },
    ];
  }
  return [];
}

/**
 * The check specification §4.4's last paragraph demands, and AC2 encodes.
 *
 * Withholding `$HOME` covers the fifteen paths `defaultReadDenyList` names *only
 * because* they are all beneath `$HOME` and `$HOME` is not granted. Neither half
 * is guaranteed: a caller may deny a path outside `$HOME`, and a workspace may
 * itself BE `$HOME`. Either way the construction stops covering the list, and
 * the honest answer is a translation failure that sends the profile to
 * bubblewrap — not a ruleset that leaves the secret readable.
 *
 * The relation checked is containment **in both directions**. A grant inside a
 * denied subtree (`/home/u/.ssh/keys` granted, `/home/u/.ssh` denied) exposes
 * part of what must not be read, and is refused for the same reason.
 */
function denyOverlapFailures(
  profile: SandboxProfile,
  grants: readonly string[],
): LandlockInexpressible[] {
  const failures: LandlockInexpressible[] = [];
  for (const denied of [...new Set(profile.readDenyList)]) {
    // A malformed deny path cannot be compared meaningfully, and treating it as
    // "no overlap" would be the fail-open reading of an input we do not trust.
    if (!posixPath.isAbsolute(denied) || denied.includes("\0")) {
      failures.push({
        code: "read-deny-path-inside-grant",
        field: "readDenyList",
        detail: `read-deny path ${JSON.stringify(denied)} is not an absolute, NUL-free path, so it cannot be checked against the grant list; Landlock grants are allow-only, so an unverifiable deny path is refused rather than assumed covered.`,
      });
      continue;
    }
    for (const grant of grants) {
      if (!pathsOverlap(denied, grant)) {
        continue;
      }
      failures.push({
        code: "read-deny-path-inside-grant",
        field: "readDenyList",
        detail: `read-deny path ${JSON.stringify(denied)} lies within the granted hierarchy ${JSON.stringify(grant)}. Landlock rules are allow-only and cumulative along the path, so no deeper rule can carve it back out; the deny list is satisfied by NOT granting $HOME (specification §4.4), and a path this ruleset would grant is not covered by that construction.`,
      });
      break;
    }
  }
  return failures;
}

/**
 * `$HOME` itself must never be granted, and neither may an ancestor of it.
 *
 * The deny-overlap check catches this whenever the deny list is populated, which
 * is every profile the product builds. This catches the case it cannot: a
 * profile constructed without a home has an EMPTY deny list, and "grant
 * everything except `$HOME`" would then quietly become "grant everything".
 */
function homeExposureFailures(
  grants: readonly string[],
  home: string | undefined,
): LandlockInexpressible[] {
  if (home === undefined || home.length === 0 || !posixPath.isAbsolute(home)) {
    return [];
  }
  const normalisedHome = stripTrailingSlash(home);
  const failures: LandlockInexpressible[] = [];
  for (const grant of grants) {
    const normalised = stripTrailingSlash(grant);
    if (normalised === normalisedHome || isAncestorOf(normalised, normalisedHome)) {
      failures.push({
        code: "grant-would-expose-home",
        field: "grants",
        detail: `granting ${JSON.stringify(grant)} would make $HOME (${JSON.stringify(home)}) readable, and the Landlock layer satisfies the read-deny list precisely by never granting $HOME (specification §4.4). This profile belongs to the bubblewrap layer.`,
      });
    }
  }
  return failures;
}

/**
 * A ruleset with no readable directory is not a stricter boundary; it is one no
 * command can start under, and the failure would surface as an unexplained
 * `EACCES` from `execve` rather than as a refusal here.
 */
function readGrantPresenceFailures(readRoots: readonly string[]): LandlockInexpressible[] {
  if (readRoots.length > 0) {
    return [];
  }
  return [
    {
      code: "no-read-grant",
      field: "grants",
      detail:
        "no readable directory was granted, so the contained command could not read its own program image; under the grant model (specification §4.4) an empty read grant is a broken ruleset rather than a strict one.",
    },
  ];
}

function pathShapeFailures(
  paths: readonly string[],
  field: LandlockInexpressible["field"],
): LandlockInexpressible[] {
  const failures: LandlockInexpressible[] = [];
  const what = field === "writableRoots" ? "writable root" : "granted path";
  for (const path of paths) {
    if (path.includes("\0")) {
      failures.push({
        code: "path-contains-nul",
        field,
        detail: `${what} ${JSON.stringify(path)} contains a NUL byte and cannot be opened as a rule path.`,
      });
    } else if (!posixPath.isAbsolute(path)) {
      failures.push({
        code: "path-not-absolute",
        field,
        detail: `${what} ${JSON.stringify(path)} is not absolute; a Landlock rule path is opened directly and a relative path has no fixed meaning in the applying process.`,
      });
    } else if (/\/{2,}/.test(path)) {
      // `/work//repo` and `/work/repo` are the same hierarchy but two distinct
      // strings, so one would be deduplicated into two rules and reported as a
      // path nobody would recognise. Refused rather than silently collapsed.
      failures.push({
        code: "path-not-canonical",
        field,
        detail: `${what} ${JSON.stringify(path)} contains a repeated "/"; the kernel collapses it when the rule path is opened, so the path reported would not be the string given.`,
      });
    } else if (path.split("/").some((segment) => segment === "." || segment === "..")) {
      failures.push({
        code: "path-not-canonical",
        field,
        detail: `${what} ${JSON.stringify(path)} contains a "." or ".." segment; the kernel resolves it when the rule path is opened, so the hierarchy actually granted would differ from the one reported.`,
      });
    }
  }
  return failures;
}

function abiFailures(abi: number): LandlockInexpressible[] {
  if (!Number.isInteger(abi) || abi < 0) {
    // Not a statement about the kernel: no kernel reports a fractional or
    // negative ABI. Collapsing this into `landlock-unavailable` would report a
    // broken reader as a verified kernel fact, which is the defect class this
    // package exists to remove. `landlock-abi.ts` refuses the same collapse.
    return [
      {
        code: "abi-unreadable",
        field: "abi",
        detail: `the Landlock ABI reader returned ${formatAbi(abi)}, which is not an ABI version; this is a probe failure and says nothing about the kernel.`,
      },
    ];
  }
  if (abi === 0) {
    return [
      {
        code: "landlock-unavailable",
        field: "abi",
        detail: "the kernel reports Landlock ABI 0; Landlock is not available on this kernel.",
      },
    ];
  }
  if (abi >= LANDLOCK_MINIMUM_ABI) {
    return [];
  }
  return [{ code: "abi-too-low", field: "abi", detail: abiTooLowDetail(abi) }];
}

/**
 * Name each missing right once, beside what its absence actually does.
 *
 * `refer` is the one right whose absence makes the kernel STRICTER: without it,
 * cross-directory rename and link are denied everywhere. Every other missing
 * right leaves its operation unrestricted. Saying "unrestricted" of `refer`
 * would be a keryx claim about the kernel that contradicts the kernel, printed
 * to an operator on Ubuntu 22.04 — which is exactly what this text used to do.
 */
function abiTooLowDetail(abi: number): string {
  const missing = HANDLED_FS_RIGHTS.filter((a) => LANDLOCK_FS_ACCESS_MIN_ABI[a] > abi);
  const unrestricted = missing.filter((a) => a !== "refer");
  const sentences = [
    `this profile's boundary needs Landlock ABI ${LANDLOCK_MINIMUM_ABI}, and the kernel reports ABI ${abi}`,
  ];
  if (unrestricted.length > 0) {
    sentences.push(
      `without ${unrestricted.join(", ")}, the matching operations would be left unrestricted outside the writable roots`,
    );
  }
  if (missing.includes("refer")) {
    sentences.push(
      "without refer, cross-directory rename and link would instead be denied everywhere, which is stricter than the profile asks for",
    );
  }
  return `${sentences.join(". ")}.`;
}

/**
 * `JSON.stringify` renders `NaN` and `Infinity` as `null`, which would name a
 * value the reader never returned — in the one message whose whole purpose is to
 * say something true about the reader.
 */
function formatAbi(value: unknown): string {
  return typeof value === "number" ? String(value) : JSON.stringify(value);
}

/**
 * Build the rule list.
 *
 * Order is read grants, then read files, then writable roots, then the device
 * carve-outs. It carries no precedence — Landlock accumulates — but it is stable,
 * so a ruleset can be diffed between runs and read by an operator.
 *
 * A `read-only` profile gets no write rule at all: the write rights are handled
 * and granted nowhere, which is how "no writes" is said in a grant-only model.
 */
function pathRules(
  profile: SandboxProfile,
  granted: {
    readonly readRoots: readonly string[];
    readonly requiredReadRoots: readonly string[];
    readonly readFiles: readonly string[];
    readonly writable: readonly string[];
  },
): readonly LandlockPathRule[] {
  const rules: LandlockPathRule[] = [];

  for (const path of granted.readRoots) {
    rules.push(
      Object.freeze({
        path,
        allow: READ_ACCESS_RIGHTS,
        // Absent is not an error here: `/lib64` does not exist on aarch64,
        // `/run/systemd/resolve` does not exist off systemd, and a `PATH` entry
        // naming a directory nobody created is ordinary. Dropping the rule can
        // only ever over-restrict.
        onMissing: "skip" as const,
        target: "directory" as const,
      }),
    );
  }

  for (const path of granted.requiredReadRoots) {
    rules.push(
      Object.freeze({
        path,
        allow: READ_ACCESS_RIGHTS,
        // The working directory. If it is not there, the command has nothing to
        // read and running it anyway would silently drop the one rule that made
        // the workspace visible.
        onMissing: "fail" as const,
        target: "directory" as const,
      }),
    );
  }

  for (const path of granted.readFiles) {
    rules.push(
      Object.freeze({
        path,
        // `read_file` only: see FILE_APPLICABLE_RIGHTS. A wider mask on a file
        // is EINVAL, and a writable one would hand a contained command the
        // ability to rewrite the operator's git identity.
        allow: Object.freeze(["read_file"]) as readonly LandlockFsAccess[],
        // `~/.gitconfig` is absent on plenty of machines and its absence is not
        // an error — git only fails when the file exists and cannot be read.
        onMissing: "skip" as const,
        target: "file" as const,
      }),
    );
  }

  for (const path of granted.writable) {
    rules.push(
      Object.freeze({
        path,
        allow: HANDLED_FS_RIGHTS,
        onMissing: "fail" as const,
        target: "directory" as const,
      }),
    );
  }

  rules.push(
    Object.freeze({
      path: "/dev",
      allow: DEVICE_READ_RIGHTS,
      onMissing: "skip" as const,
      target: "directory" as const,
    }),
  );
  if (profile.mode === "workspace-write") {
    for (const path of DEVICE_WRITE_PATHS) {
      rules.push(
        Object.freeze({
          path,
          allow: DEVICE_WRITE_RIGHTS,
          onMissing: "skip" as const,
          target: "file" as const,
        }),
      );
    }
    rules.push(
      Object.freeze({
        path: SHARED_MEMORY_PATH,
        allow: HANDLED_FS_RIGHTS,
        onMissing: "skip" as const,
        target: "directory" as const,
      }),
    );
  } else {
    // A read-only profile still needs somewhere to send output: `2>/dev/null` is
    // not a write to the workspace, it is a discard, and a read-only sandbox
    // that cannot discard output is unusable rather than strict. `/dev/null` and
    // `/dev/zero` cannot hold data; `/dev/tty` is the terminal the command was
    // already attached to.
    for (const path of DEVICE_WRITE_PATHS) {
      rules.push(
        Object.freeze({
          path,
          allow: DEVICE_WRITE_RIGHTS,
          onMissing: "skip" as const,
          target: "file" as const,
        }),
      );
    }
  }

  // Frozen because `readonly` is erased at run time: a consumer that pushed a
  // rule here would widen a security boundary, and the JS caller the barrel
  // publishes to has no type checker stopping it.
  return Object.freeze(rules);
}

/** Do these two absolute paths name overlapping hierarchies? */
function pathsOverlap(a: string, b: string): boolean {
  const left = stripTrailingSlash(a);
  const right = stripTrailingSlash(b);
  return left === right || isAncestorOf(left, right) || isAncestorOf(right, left);
}

/**
 * Is `ancestor` a proper prefix of `descendant` **at a path-segment boundary**?
 *
 * The boundary matters: `/home/user2` starts with the string `/home/user` and is
 * a different directory entirely, so a naive `startsWith` would refuse grants
 * that are perfectly safe — and, in the mirrored case, would accept ones that
 * are not.
 */
function isAncestorOf(ancestor: string, descendant: string): boolean {
  if (ancestor === "/") {
    return descendant !== "/";
  }
  return descendant.startsWith(`${ancestor}/`);
}

/**
 * Drop a single trailing slash, so `/work/repo` and `/work/repo/` do not become
 * two rules. Only reachable after validation, which refuses repeated slashes, so
 * this can never produce the empty string — `/` has no trailing slash to drop.
 * Nothing else is rewritten: `.` and `..` are refused rather than resolved,
 * because resolving them would change which hierarchy is granted.
 */
function stripTrailingSlash(value: string): string {
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

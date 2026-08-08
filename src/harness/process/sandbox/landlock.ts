// Linux Landlock ruleset builder (flow 145) — requirements package
// `keryx-linux-containment`, specification §4, acceptance criteria AC1/AC2.
//
// Pure: a `SandboxProfile` plus the kernel's Landlock ABI version in, a ruleset
// *description* out. No syscall, no `bun:ffi`, no spawn, no filesystem, no
// `process.platform`. Applying a ruleset to a process is a different module and
// a different flow; this one mirrors `bwrap.ts` — data in, data out,
// offline-testable.
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
// Four consequences, and each is load-bearing:
//
// 1. **Grant, do not deny — including for reads.** Read and write rights are
//    both handled, and both are allowed back only beneath the hierarchies this
//    module grants: the writable roots read-write, the workspace and the system
//    roots read-only, `$HOME` nowhere at all.
//
//    This is specification §4.4, and it replaces the shape flow 145 shipped.
//    That version handled write rights only, leaving reads unhandled to express
//    the profile's broad read default, and therefore refused every profile
//    carrying a `readDenyList`. Since `defaultSandboxProfile` and
//    `sandboxProfileFromPolicy` populate that list on every path but
//    `danger-full-access`, the layer served no profile the product builds. The
//    deny list has no Landlock representation (consequence 3) — but it does not
//    need one: a path that was never granted is already unreachable, and
//    withholding `$HOME` also covers the credential file nobody listed.
//
//    What this does NOT cover, and what {@link buildLandlockRuleset} therefore
//    checks rather than assumes, is a denied path that lies inside a hierarchy
//    this module grants. `/etc/…` is the shape to picture: the deny list asks
//    for it to be unreadable and the system read grant would hand it back. That
//    is an inexpressible profile (AC2), not a rounding error.
// 2. **The ABI floor is derived, not chosen.** `landlock_create_ruleset` fails
//    with `EINVAL` on a mask containing bits the running kernel does not know.
//    The common workaround is to mask the request down to the kernel's ABI —
//    best-effort, which is another word for approximate. Instead the required
//    rights produce a `minimumAbi`, and a kernel below it is an explicit
//    failure that names the ABI (PRD R6), never a downgraded ruleset.
// 3. **A deny-exception under a broad allow has no representation.** Rules are
//    allow-only and cumulative, so nothing deeper can narrow something
//    shallower — specification §4.3's "no mount view" paragraph. Consequence (1)
//    is how this module lives with that: it never establishes the broad allow in
//    the first place. Where a grant and a denied path do overlap, the profile is
//    inexpressible; see {@link LandlockInexpressibleCode}.
// 4. **A subtree that needs more rights gets its own nested rule — never a
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
//    subtree and can never *remove* them. That is why (4) works and (3) cannot.
//
// ## What this ruleset does not reach, stated rather than hidden
//
// - **Metadata mutation.** Landlock has no access right for `chmod`, `chown`,
//   `setxattr` or `utime` at any ABI, nor for `ioctl` on a regular file, so they
//   stay permitted wherever DAC already permits them — including outside the
//   writable roots. bubblewrap's `--ro-bind / /` refuses those with `EROFS`, so
//   **layer 1's filesystem boundary is data-only and layer 2's is not**, and the
//   two are not interchangeable. This is not expressible as a translation
//   failure without making every write-bounded profile inexpressible and
//   deleting the Landlock layer outright, so it is named instead —
//   mechanically, in {@link LANDLOCK_RESIDUAL_ACTIONS}, so a reporting layer
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
//   without a rule (see `DEVICE_WRITE_PATHS`). A descriptor the process already
//   holds when it calls `landlock_restrict_self` stays usable whatever the
//   ruleset says. It is a property of the mechanism rather than of a syscall, so
//   it is stated here and not in the residue list.
// - **A minimal `/dev`.** bubblewrap's `--dev /dev` narrows the visible device
//   set. That is a different mechanism, and `SandboxProfile` has no field for it.
// - **PID / IPC / session isolation.** bubblewrap's `--unshare-pid`,
//   `--unshare-ipc` and `--new-session` have no `SandboxProfile` representation
//   either. Landlock ABI 6 scoping could carry part of it later; nothing here
//   pretends it already does.
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
   * the same class of untrue statement this package exists to remove. An
   * earlier version of this data collapsed the two on `ioctl` and said the
   * kernel could not restrict it at any ABI, which is false from ABI 5.
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
 * to. An earlier version of this paragraph said the list held "the mutating
 * entries", which those two contradict.
 *
 * `ioctl` appears **twice, at different granularity**, because Landlock splits
 * it and a single entry cannot be true of both halves:
 * `LANDLOCK_ACCESS_FS_IOCTL_DEV` (ABI 5) covers ioctls on an opened character or
 * block device and nothing else, so an ioctl on a regular file or directory —
 * `FS_IOC_SETFLAGS` through an `O_RDONLY` descriptor, for instance — is
 * restrictable at no ABI at all.
 *
 * Exported so `sandbox status` and the capability matrix can state the residue
 * from a value rather than from a comment someone has to remember to read. It is
 * a constant fact about the mechanism, not a per-profile escape hatch — see
 * {@link LandlockRuleset} for why the distinction matters.
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
 * Read-ish rights live in {@link READ_ACCESS_RIGHTS} rather than here, because
 * the two are granted to different hierarchies: a system root gets the read set
 * and nothing else. Both are handled — see module header consequence (1).
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
 * Reading, listing and executing — what a hierarchy needs to be *usable* without
 * being modifiable.
 *
 * `execute` is here rather than in the write set for a reason that is easy to
 * get backwards: it gates `execve` on a file, which is a read-shaped operation.
 * Without it in a granted system root, no binary under `/usr/bin` can be run at
 * all, and the boundary stops being a boundary by making every command fail.
 */
const READ_ACCESS_RIGHTS: readonly LandlockFsAccess[] = Object.freeze([
  "execute",
  "read_file",
  "read_dir",
]);

/**
 * Everything this module handles: a hierarchy granted this set is fully usable,
 * and one granted nothing is unreachable.
 *
 * Read first, then write, so the order is stable for reporting and matches the
 * two tables above being read in kernel-bit order at a glance.
 */
const READ_WRITE_ACCESS_RIGHTS: readonly LandlockFsAccess[] = Object.freeze([
  ...READ_ACCESS_RIGHTS,
  ...WRITE_ACCESS_RIGHTS,
]);

/**
 * The hierarchies a command needs to *start* on a Linux host, granted read-only.
 *
 * Measured by the step-2 spike (flow 143) rather than reasoned about: this is
 * the minimum set under which a dynamically linked binary resolves its loader
 * and libraries, finds its locale and CA bundle, and can read `/proc/self`.
 * Anything absent here is not "probably fine" — it is a command that fails with
 * `EACCES` before `main`.
 *
 * `onMissing: "skip"`, because `/lib64` does not exist on aarch64 and an
 * unopenable rule path would otherwise fail the whole run closed. Skipping a
 * read grant can only over-restrict.
 *
 * `$HOME` is deliberately not here and must never be added: withholding it is
 * the entire mechanism by which `readDenyList` is satisfied (§4.4). Individual
 * benign paths beneath it belong in the caller's `extraReadRoots`, one measured
 * entry at a time, each a reviewed widening of the boundary.
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
]);

/**
 * `/dev` is granted read and list — and nothing more.
 *
 * Under the grant model reads are handled, so an ungranted `/dev` would stop
 * `/dev/urandom` and `/dev/fd` dead. The three writable devices below stay a
 * separate, narrower, nested rule; widening this one to reach them would confer
 * write access on every device node, which is the exact mistake the step-2 spike
 * made on `/dev/shm` and had to undo.
 */
const DEVICE_READ_PATH = "/dev";
const DEVICE_READ_RIGHTS: readonly LandlockFsAccess[] = Object.freeze(["read_file", "read_dir"]);

/**
 * POSIX shared memory. A tmpfs where `shm_open`/`sem_open` create and unlink
 * *regular* files, so Chromium, Python multiprocessing and libpq fail with
 * `EACCES` under the device grant alone.
 *
 * A nested read-write rule, never a wider `/dev`: Landlock evaluates the most
 * specific matching hierarchy, so this grants exactly `/dev/shm` and leaves the
 * device nodes beside it read-only.
 */
const DEVICE_SHM_PATH = "/dev/shm";

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
 * - `/dev/random`, `/dev/urandom`. Tools read them, and the `/dev` read grant
 *   above already covers that; they need no write.
 */
const DEVICE_WRITE_PATHS: readonly string[] = Object.freeze(["/dev/null", "/dev/zero", "/dev/tty"]);

/**
 * What a device carve-out grants: writing the device, and `truncate` because
 * `> /dev/null` opens with `O_TRUNC`. Never `ioctl_dev`, which is unhandled.
 */
const DEVICE_WRITE_RIGHTS: readonly LandlockFsAccess[] = Object.freeze(["write_file", "truncate"]);

/**
 * What the applier does with a rule whose path does not exist when it opens it.
 *
 * - `fail` — abort, do not run the command. A writable root that is absent means
 *   the workspace is not there; running anyway would silently drop the rule and
 *   leave the command with no writable directory at all.
 * - `skip` — drop the rule and continue. Only ever over-restrictive, and only
 *   used for the device carve-out, where a container without `/dev/tty` has
 *   nothing to allow. `bwrap.ts` takes the same position on a missing mask
 *   target, for the same reason.
 */
export type LandlockMissingPathDisposition = "fail" | "skip";

/**
 * One `landlock_add_rule(fd, LANDLOCK_RULE_PATH_BENEATH, …)` call.
 *
 * Rules may nest: a rule's `path` may lie beneath another rule's `path`, with a
 * different and possibly narrower `allow` set. Rights accumulate downwards, so a
 * nested rule adds to whatever an ancestor already granted and can never subtract
 * from it — see consequence (4) in the module header. The applier issues every
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
 *
 * Those exceptions are a different kind of fact: constant, profile-independent
 * and stated once in {@link LANDLOCK_RESIDUAL_ACTIONS}, which records per entry
 * whether the kernel could restrict it and whether bubblewrap refuses it. It
 * does not vary with a profile, so it cannot record an approximation of one.
 * Read it before describing this boundary as equivalent to bubblewrap's.
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
 * - `read-deny-list-requires-mount-view` — a denied path overlaps a hierarchy
 *   this module grants, so the grant would hand back what the profile denies and
 *   no deeper rule can narrow it (specification §4.3). Falls back to the
 *   bubblewrap layer, which expresses it by mounting over the path. Note the
 *   scope: a denied path that overlaps *nothing granted* is not a failure at
 *   all — it is satisfied by never having been granted, which is the whole of
 *   §4.4.
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
  | "read-deny-list-requires-mount-view"
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
   * The input the failure is about. `"abi"` is the kernel rather than the
   * profile, and `"readRoots"` is the caller's injected grant set rather than
   * either — an operator told a writable root is malformed when the malformed
   * path came from keryx itself would look in the wrong place.
   */
  readonly field: keyof SandboxProfile | "abi" | "readRoots";
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
 * What the module cannot learn for itself, because it may not touch the host.
 *
 * A grant list is made of host paths, and this module is forbidden from reading
 * `process.env`, `os.homedir()` or the filesystem — a source guard in the test
 * suite holds that, and it is what keeps the translation deterministic and
 * offline. So the paths arrive as arguments. `wrap.ts` fills them in from the
 * `ContainedCommand` and its own injected options.
 */
export interface BuildLandlockRulesetOptions {
  /**
   * Absolute path of the workspace the command runs in.
   *
   * Needed because `writableRoots` is empty for a `read-only` profile, which
   * would otherwise leave the command unable to read the very tree it was
   * pointed at. Ignored when it is already a writable root — the read set is a
   * subset of what that rule grants, so a second rule would only add noise.
   */
  readonly workspace?: string;
  /**
   * Absolute `$HOME`. Never granted; supplied so a failure can say *why* a
   * denied path is unreachable, and so a caller cannot quietly pass it as a
   * read root — see {@link LANDLOCK_SYSTEM_READ_ROOTS}.
   */
  readonly home?: string;
  /** Read-only hierarchies. Defaults to {@link LANDLOCK_SYSTEM_READ_ROOTS}. */
  readonly systemReadRoots?: readonly string[];
  /**
   * Additional read-only hierarchies: the Bun install directory, and whatever
   * else was *measured* to be needed. Every entry is a reviewed widening of the
   * boundary (§4.4, consequence 2) and none is a guess.
   */
  readonly extraReadRoots?: readonly string[];
}

/**
 * Translate a `SandboxProfile` into a Landlock ruleset description.
 *
 * Deterministic and offline: `abi` and every host path are injected rather than
 * probed, so the same inputs always produce the same output and the tests need
 * no kernel. Failures are accumulated in a fixed order so the output is stable,
 * and a profile that cannot be expressed returns every reason it cannot rather
 * than the first.
 *
 * @param profile the resolved OS-sandbox profile, unchanged from `profile.ts`
 * @param abi the kernel's Landlock ABI version; `0` means Landlock is absent
 * @param options the host paths the grant list is built from
 */
export function buildLandlockRuleset(
  profile: SandboxProfile,
  abi: number,
  options: BuildLandlockRulesetOptions = {},
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
  const rawRoots = profile.mode === "workspace-write" ? [...new Set(profile.writableRoots)] : [];
  const rawReadRoots = [
    ...new Set([
      ...(options.workspace !== undefined ? [options.workspace] : []),
      ...(options.systemReadRoots ?? LANDLOCK_SYSTEM_READ_ROOTS),
      ...(options.extraReadRoots ?? []),
    ]),
  ];
  const handledFs = READ_WRITE_ACCESS_RIGHTS;
  const minimumAbi = requiredAbi(handledFs);

  const pathFailures = [
    ...rootPathFailures(rawRoots, "writableRoots"),
    ...rootPathFailures(rawReadRoots, "readRoots"),
  ];
  // The deny-list check reads the grant list, so it can only run on paths that
  // are known well-formed. Reporting "denied path X is inside granted root Y"
  // where Y is `/work/../work` would name a hierarchy that is not the one the
  // kernel would enforce.
  const failures = [
    ...networkFailures(profile),
    ...pathFailures,
    ...(pathFailures.length === 0
      ? readDenyFailures(profile, rawRoots, rawReadRoots, options.home)
      : []),
    ...abiFailures(abi, handledFs, minimumAbi),
  ];
  if (failures.length > 0) {
    return { ok: false, failures };
  }

  // Every root is valid here, so the only rewrite left is dropping a trailing
  // slash — after which `/work/repo` and `/work/repo/` are one rule, not two.
  const roots = [...new Set(rawRoots.map(stripTrailingSlash))];
  const readRoots = [...new Set(rawReadRoots.map(stripTrailingSlash))].filter(
    (root) => !roots.includes(root),
  );

  return {
    ok: true,
    ruleset: Object.freeze({
      minimumAbi,
      handledFs,
      handledNet: Object.freeze([]) as readonly never[],
      pathRules: pathRules(roots, readRoots, handledFs),
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
 * A denied path is satisfied when nothing grants it — and refused when something
 * does.
 *
 * The grant model (§4.4) makes most of `readDenyList` a non-event: the entries
 * are under `$HOME`, `$HOME` is granted by nothing, and a path that was never
 * granted is unreachable. This function exists for the remainder, and it checks
 * **overlap in both directions**:
 *
 * - a denied path *inside* a granted hierarchy would be handed back by that
 *   grant, and no deeper rule can take it away;
 * - a granted hierarchy *inside* a denied path is a grant reaching into a tree
 *   the profile asked to be unreadable. It is narrower than the first case, and
 *   it is still a hole the profile did not authorise, so it is refused too
 *   rather than argued about at review time.
 *
 * Equality is caught by either direction.
 */
function readDenyFailures(
  profile: SandboxProfile,
  writableRoots: readonly string[],
  readRoots: readonly string[],
  home: string | undefined,
): LandlockInexpressible[] {
  const granted = [...writableRoots, ...readRoots].map(stripTrailingSlash);
  const failures: LandlockInexpressible[] = [];
  for (const denied of profile.readDenyList) {
    const normalised = stripTrailingSlash(denied);
    const clash = granted.find(
      (root) => isAtOrBeneath(normalised, root) || isAtOrBeneath(root, normalised),
    );
    if (clash === undefined) {
      continue;
    }
    failures.push({
      code: "read-deny-list-requires-mount-view",
      field: "readDenyList",
      detail: `read-denied path ${JSON.stringify(denied)} overlaps the granted hierarchy ${JSON.stringify(clash)}; Landlock rules are allow-only and cumulative along the path, so no deeper rule can take back what that grant confers${home !== undefined ? ` (paths under ${JSON.stringify(home)} need no rule, because ${JSON.stringify(home)} is granted by nothing)` : ""}. bubblewrap expresses this by mounting over the path; Landlock filters the real filesystem and cannot (specification §4.3).`,
    });
  }
  return failures;
}

/**
 * True when `candidate` is `root` itself or lies beneath it.
 *
 * Segment-wise, not `startsWith`: `/etc/keryxfoo` starts with `/etc/keryx` and
 * is a different hierarchy, and a check that conflated them would refuse
 * profiles that are perfectly expressible — or, with the arguments the other way
 * round, accept one that is not.
 */
function isAtOrBeneath(candidate: string, root: string): boolean {
  if (candidate === root) {
    return true;
  }
  return candidate.startsWith(root === "/" ? "/" : `${root}/`);
}

/**
 * Validate rule paths, whether they came from the profile or from the caller.
 *
 * `field` names which, because the two have different owners: a malformed
 * `writableRoots` entry is a policy the operator can fix, and a malformed read
 * root is a keryx bug. Both are refused identically; only the report differs.
 */
function rootPathFailures(
  roots: readonly string[],
  field: "writableRoots" | "readRoots",
): LandlockInexpressible[] {
  const label = field === "writableRoots" ? "writable root" : "read root";
  const failures: LandlockInexpressible[] = [];
  for (const root of roots) {
    if (root.includes("\0")) {
      failures.push({
        code: "path-contains-nul",
        field,
        detail: `${label} ${JSON.stringify(root)} contains a NUL byte and cannot be opened as a rule path.`,
      });
    } else if (!posixPath.isAbsolute(root)) {
      failures.push({
        code: "path-not-absolute",
        field,
        detail: `${label} ${JSON.stringify(root)} is not absolute; a Landlock rule path is opened directly and a relative path has no fixed meaning in the applying process.`,
      });
    } else if (/\/{2,}/.test(root)) {
      // `/work//repo` and `/work/repo` are the same hierarchy but two distinct
      // strings, so one would be deduplicated into two rules and reported as a
      // path nobody would recognise. Refused rather than silently collapsed.
      failures.push({
        code: "path-not-canonical",
        field: "writableRoots",
        detail: `writable root ${JSON.stringify(root)} contains a repeated "/"; the kernel collapses it when the rule path is opened, so the path reported would not be the string given.`,
      });
    } else if (root.split("/").some((segment) => segment === "." || segment === "..")) {
      failures.push({
        code: "path-not-canonical",
        field: "writableRoots",
        detail: `writable root ${JSON.stringify(root)} contains a "." or ".." segment; the kernel resolves it when the rule path is opened, so the hierarchy actually granted would differ from the one reported.`,
      });
    }
  }
  return failures;
}

function abiFailures(
  abi: number,
  handledFs: readonly LandlockFsAccess[],
  minimumAbi: number,
): LandlockInexpressible[] {
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
  if (abi >= minimumAbi) {
    return [];
  }
  return [
    { code: "abi-too-low", field: "abi", detail: abiTooLowDetail(abi, handledFs, minimumAbi) },
  ];
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
function abiTooLowDetail(
  abi: number,
  handledFs: readonly LandlockFsAccess[],
  minimumAbi: number,
): string {
  const missing = handledFs.filter((a) => LANDLOCK_FS_ACCESS_MIN_ABI[a] > abi);
  const unrestricted = missing.filter((a) => a !== "refer");
  const sentences = [
    `this profile's write boundary needs Landlock ABI ${minimumAbi}, and the kernel reports ABI ${abi}`,
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

/** The lowest ABI that knows every handled right. */
function requiredAbi(handledFs: readonly LandlockFsAccess[]): number {
  return Math.max(...handledFs.map((a) => LANDLOCK_FS_ACCESS_MIN_ABI[a]));
}

/**
 * The grant list, in a fixed order: writable roots, read roots, then the device
 * rules from broadest to narrowest.
 *
 * Order carries no precedence — Landlock accumulates — but it is stable, so a
 * diff of two rulesets reads as a change in the boundary rather than as a
 * reshuffle.
 *
 * The dispositions differ on purpose. A missing **writable** root means the
 * workspace is not there, and running anyway would leave the command with
 * nowhere to write: fatal. A missing **read** root (`/lib64` on aarch64, `/dev`
 * inside a minimal container) can only over-restrict: skipped.
 */
function pathRules(
  roots: readonly string[],
  readRoots: readonly string[],
  handledFs: readonly LandlockFsAccess[],
): readonly LandlockPathRule[] {
  const rules: LandlockPathRule[] = roots.map((path) =>
    Object.freeze({ path, allow: handledFs, onMissing: "fail" as const }),
  );
  for (const path of readRoots) {
    rules.push(Object.freeze({ path, allow: READ_ACCESS_RIGHTS, onMissing: "skip" as const }));
  }
  rules.push(
    Object.freeze({
      path: DEVICE_READ_PATH,
      allow: DEVICE_READ_RIGHTS,
      onMissing: "skip" as const,
    }),
  );
  rules.push(
    Object.freeze({ path: DEVICE_SHM_PATH, allow: handledFs, onMissing: "skip" as const }),
  );
  for (const path of DEVICE_WRITE_PATHS) {
    rules.push(Object.freeze({ path, allow: DEVICE_WRITE_RIGHTS, onMissing: "skip" as const }));
  }
  // Frozen because `readonly` is erased at run time: a consumer that pushed a
  // rule here would widen a security boundary, and the JS caller the barrel
  // publishes to has no type checker stopping it.
  return Object.freeze(rules);
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

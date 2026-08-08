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
// Three consequences, and each is load-bearing:
//
// 1. **Handle only what the profile restricts.** The profile's read default is
//    broad (bubblewrap expresses it as `--ro-bind / /`), so no read-ish access
//    right is handled and no synthetic `/` rule is needed. Writes are what the
//    profile bounds, so every write-ish right is handled and allowed back only
//    beneath the writable roots.
// 2. **The ABI floor is derived, not chosen.** `landlock_create_ruleset` fails
//    with `EINVAL` on a mask containing bits the running kernel does not know.
//    The common workaround is to mask the request down to the kernel's ABI —
//    best-effort, which is another word for approximate. Instead the required
//    rights produce a `minimumAbi`, and a kernel below it is an explicit
//    failure that names the ABI (PRD R6), never a downgraded ruleset.
// 3. **A deny-exception under a broad allow has no representation.** That is
//    what `readDenyList` is, and it is specification §4.3's "no mount view"
//    paragraph. See {@link LandlockInexpressibleCode} for the disposition.
//
// ## What this ruleset deliberately does not claim
//
// - **Network-off.** Landlock's network access types cover TCP `bind`/`connect`
//   and nothing else; UDP (including DNS), raw and unix-domain sockets are
//   outside them. Specification §4.3 and PRD R2 make `network: "off"` a
//   bubblewrap profile until a seccomp filter closes that gap, so no profile
//   here emits a network rule. `handledNet`/`netRules` exist on the type so the
//   seccomp-paired future has a place to land, and a unit test asserts they stay
//   empty — that test is the guard against a second false green.
// - **A minimal `/dev`.** bubblewrap's `--dev /dev` narrows the visible device
//   set; `LANDLOCK_ACCESS_FS_IOCTL_DEV` (ABI 5) is a different thing and
//   `SandboxProfile` has no field for either, so neither is expressed.
// - **PID / IPC / session isolation.** bubblewrap's `--unshare-pid`,
//   `--unshare-ipc` and `--new-session` have no `SandboxProfile` representation
//   either. Landlock ABI 6 scoping could carry part of it later; nothing here
//   pretends it already does.

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

/**
 * A Landlock network access right. **TCP only** — this is the whole of what
 * Landlock's network access types cover (specification §4.3).
 */
export type LandlockNetAccess = "bind_tcp" | "connect_tcp";

/** Bit position of each filesystem right in `landlock_ruleset_attr.handled_access_fs`. */
export const LANDLOCK_FS_ACCESS_BIT: Readonly<Record<LandlockFsAccess, number>> = {
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
};

/** Bit position of each network right in `landlock_ruleset_attr.handled_access_net`. */
export const LANDLOCK_NET_ACCESS_BIT: Readonly<Record<LandlockNetAccess, number>> = {
  bind_tcp: 0,
  connect_tcp: 1,
};

/** The Landlock ABI version in which each filesystem right first exists. */
export const LANDLOCK_FS_ACCESS_MIN_ABI: Readonly<Record<LandlockFsAccess, number>> = {
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
};

/** The Landlock ABI version in which each network right first exists. */
export const LANDLOCK_NET_ACCESS_MIN_ABI: Readonly<Record<LandlockNetAccess, number>> = {
  bind_tcp: 4,
  connect_tcp: 4,
};

/**
 * The rights that together constitute "modifying the filesystem", and therefore
 * exactly what a `read-only` or `workspace-write` profile bounds.
 *
 * `refer` is in the set on purpose. Without handling it, cross-directory rename
 * and link are denied outright — stricter than the profile asks for, and it
 * would break an ordinary `mv` inside the workspace. `truncate` is in the set
 * because without it a contained command can empty a file outside the writable
 * roots, which is a hole in the boundary rather than a convenience.
 *
 * Read-ish rights (`read_file`, `read_dir`, `execute`) are absent: the profile's
 * read default is broad, so leaving them unhandled *is* the expression of it.
 */
const WRITE_ACCESS_RIGHTS: readonly LandlockFsAccess[] = [
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
];

/** One `landlock_add_rule(fd, LANDLOCK_RULE_PATH_BENEATH, …)` call. */
export interface LandlockPathRule {
  /** Absolute path of the hierarchy root; the applier opens it `O_PATH`. */
  readonly path: string;
  /** Rights allowed beneath `path`. Always a non-empty subset of `handledFs`. */
  readonly allow: readonly LandlockFsAccess[];
}

/** One `landlock_add_rule(fd, LANDLOCK_RULE_NET_PORT, …)` call. */
export interface LandlockNetPortRule {
  /** TCP port in host byte order. */
  readonly port: number;
  /** Rights allowed on `port`. Always a non-empty subset of `handledNet`. */
  readonly allow: readonly LandlockNetAccess[];
}

/**
 * A complete Landlock ruleset, as data.
 *
 * There is deliberately no `notEnforced`, `partial` or `bestEffort` field. A
 * value of this type enforces the **whole** profile it was built from; anything
 * less is a {@link LandlockInexpressible}, not a weaker ruleset. A field for
 * recording "and this part is not covered" is exactly where an approximated
 * boundary would hide, and the boundary would then be reported as real — the
 * defect ADR-0010 exists to remove.
 */
export interface LandlockRuleset {
  /**
   * Lowest kernel Landlock ABI that can enforce this ruleset faithfully — the
   * maximum first-ABI over every handled right. Not a preference: below it,
   * `landlock_create_ruleset` rejects the mask.
   */
  readonly minimumAbi: number;
  /** `landlock_ruleset_attr.handled_access_fs`, by name. Never empty. */
  readonly handledFs: readonly LandlockFsAccess[];
  /** `landlock_ruleset_attr.handled_access_net`, by name. TCP only (§4.3). */
  readonly handledNet: readonly LandlockNetAccess[];
  /** Path-beneath allow-rules, in a deterministic order. */
  readonly pathRules: readonly LandlockPathRule[];
  /** Net-port allow-rules, in a deterministic order. */
  readonly netRules: readonly LandlockNetPortRule[];
}

/**
 * Why a profile has no faithful Landlock representation. Machine-readable so a
 * caller can route on the cause — most usefully, to the bubblewrap layer.
 *
 * - `danger-full-access-is-not-contained` — the escape hatch is not a
 *   containment profile. The wrap dispatcher skips containment for it; a
 *   ruleset would be a lie in either direction.
 * - `network-off-requires-seccomp` — specification §4.3 / PRD R2. Landlock
 *   restricts TCP `bind`/`connect`; UDP, raw and unix sockets are outside its
 *   access types, so "network off" through Landlock alone would be false.
 * - `network-restricted-requires-proxy-layer` — a domain allowlist is gated by
 *   name; Landlock gates TCP by port and cannot force traffic through the
 *   loopback proxy. ADR-0010 defers this to the container layer.
 * - `read-deny-list-requires-mount-view` — bubblewrap masks a secret by mounting
 *   over it. Landlock rules are allow-only and cumulative along the path, so an
 *   exception under a broad read default cannot be written. Expressing it would
 *   mean enumerating every sibling on the path to each secret, which needs
 *   `readdir` — impure, racy, and silently denying entries created afterwards.
 * - `path-not-absolute`, `path-contains-nul` — the applier resolves a rule path
 *   by opening it; neither form can be opened predictably.
 * - `landlock-unavailable` — the kernel reports ABI 0 (or no Landlock at all).
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
  | "landlock-unavailable"
  | "abi-too-low";

/** One reason a profile cannot be expressed as a Landlock ruleset. */
export interface LandlockInexpressible {
  readonly code: LandlockInexpressibleCode;
  /** The input the failure is about. `"abi"` is the kernel, not the profile. */
  readonly field: "mode" | "network" | "readDenyList" | "writableRoots" | "abi";
  /** Operator-readable; safe to surface verbatim in `sandbox status`. */
  readonly detail: string;
}

/**
 * The result of translating a profile. Either a ruleset that covers the profile
 * completely, or the reasons it cannot — never both, and never a ruleset that
 * covers part of it.
 */
export type LandlockTranslation =
  | { readonly ok: true; readonly ruleset: LandlockRuleset }
  | { readonly ok: false; readonly failures: readonly LandlockInexpressible[] };

/** Fold filesystem rights into the `__u64` bitmask the kernel expects. */
export function landlockFsMask(access: readonly LandlockFsAccess[]): bigint {
  return access.reduce((mask, a) => mask | (1n << BigInt(LANDLOCK_FS_ACCESS_BIT[a])), 0n);
}

/** Fold network rights into the `__u64` bitmask the kernel expects. */
export function landlockNetMask(access: readonly LandlockNetAccess[]): bigint {
  return access.reduce((mask, a) => mask | (1n << BigInt(LANDLOCK_NET_ACCESS_BIT[a])), 0n);
}

/**
 * Translate a `SandboxProfile` into a Landlock ruleset description.
 *
 * Deterministic and offline: `abi` is injected rather than probed, so the same
 * inputs always produce the same output and the tests need no kernel. Failures
 * are accumulated in a fixed order so the output is stable, and a profile that
 * cannot be expressed returns every reason it cannot rather than the first.
 *
 * @param profile the resolved OS-sandbox profile, unchanged from `profile.ts`
 * @param abi the kernel's Landlock ABI version; `0` means Landlock is absent
 */
export function buildLandlockRuleset(profile: SandboxProfile, abi: number): LandlockTranslation {
  // Terminal on its own: the escape hatch is not a containment profile, so every
  // remaining check would be describing a ruleset that must never exist.
  if (profile.mode === "danger-full-access") {
    return {
      ok: false,
      failures: [
        {
          code: "danger-full-access-is-not-contained",
          field: "mode",
          detail:
            'mode "danger-full-access" is the explicit no-containment escape hatch; it has no Landlock ruleset, and the wrap dispatcher skips containment for it entirely.',
        },
      ],
    };
  }

  const failures: LandlockInexpressible[] = [];

  // A domain allowlist implies `restricted` even if the network field disagrees:
  // the profile would otherwise describe itself as less constrained than it is.
  if (profile.network === "restricted" || profile.allowedDomains.length > 0) {
    failures.push({
      code: "network-restricted-requires-proxy-layer",
      field: "network",
      detail:
        'network "restricted" needs traffic forced through the loopback allowlist proxy, and Landlock gates TCP by port rather than by name; no ruleset can express a domain allowlist (ADR-0010 defers it to the container layer).',
    });
  } else if (profile.network === "off") {
    failures.push({
      code: "network-off-requires-seccomp",
      field: "network",
      detail:
        'network "off" is not expressible in Landlock: its network access types cover TCP bind/connect only, leaving UDP (including DNS), raw and unix-domain sockets open. Until a seccomp filter covers them this profile belongs to the bubblewrap layer (specification §4.3).',
    });
  }

  if (profile.readDenyList.length > 0) {
    failures.push({
      code: "read-deny-list-requires-mount-view",
      field: "readDenyList",
      detail: `a read-deny list (${profile.readDenyList.length} path(s)) is an exception under a broad read default, and Landlock rules are allow-only and cumulative along the path, so no deeper rule can narrow a shallower one. bubblewrap expresses this by mounting over each secret; Landlock filters the real filesystem and cannot (specification §4.3).`,
    });
  }

  // `writableRoots` is documented as "empty for read-only", so the mode is the
  // authority. Honouring roots on a `read-only` profile would quietly widen a
  // read-only claim into workspace-write; ignoring them can only over-restrict.
  const effectiveRoots = profile.mode === "workspace-write" ? profile.writableRoots : [];

  for (const root of effectiveRoots) {
    if (root.includes("\0")) {
      failures.push({
        code: "path-contains-nul",
        field: "writableRoots",
        detail: `writable root ${JSON.stringify(root)} contains a NUL byte and cannot be opened as a rule path.`,
      });
    } else if (!posixPath.isAbsolute(root)) {
      failures.push({
        code: "path-not-absolute",
        field: "writableRoots",
        detail: `writable root ${JSON.stringify(root)} is not absolute; a Landlock rule path is opened directly and a relative path has no fixed meaning in the applying process.`,
      });
    }
  }

  const handledFs = WRITE_ACCESS_RIGHTS;
  const minimumAbi = Math.max(...handledFs.map((a) => LANDLOCK_FS_ACCESS_MIN_ABI[a]));

  if (!Number.isInteger(abi) || abi < 1) {
    failures.push({
      code: "landlock-unavailable",
      field: "abi",
      detail: `the kernel reports Landlock ABI ${abi}; Landlock is not available on this kernel.`,
    });
  } else if (abi < minimumAbi) {
    const missing = handledFs.filter((a) => LANDLOCK_FS_ACCESS_MIN_ABI[a] > abi);
    failures.push({
      code: "abi-too-low",
      field: "abi",
      detail: `this profile's write boundary needs Landlock ABI ${minimumAbi}, and the kernel reports ABI ${abi}; ${missing.join(", ")} do not exist there, so a ruleset built at this ABI would leave those operations unrestricted outside the writable roots.`,
    });
  }

  if (failures.length > 0) {
    return { ok: false, failures };
  }

  // Reads stay unrestricted by handling no read-ish right, so the only rules are
  // the writable roots. Duplicates are dropped for a stable, minimal ruleset;
  // order follows the profile, which keeps the output deterministic.
  const pathRules: LandlockPathRule[] = [];
  for (const root of dedupe(effectiveRoots)) {
    pathRules.push({ path: root, allow: handledFs });
  }

  return {
    ok: true,
    ruleset: {
      minimumAbi,
      handledFs,
      // Empty for every profile, by design — see the module header and §4.3.
      handledNet: [],
      pathRules,
      netRules: [],
    },
  };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

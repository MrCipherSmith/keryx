/**
 * SPIKE ONLY — not production code, not wired into src/harness/process/sandbox/.
 *
 * Minimal Landlock binding over `bun:ffi`. Exists to answer one question:
 * can a Bun process issue landlock_create_ruleset / landlock_add_rule /
 * prctl(PR_SET_NO_NEW_PRIVS) / landlock_restrict_self, and does the resulting
 * restriction survive into an exec'd child and its descendants?
 *
 * See ../specification.md §4 and README.md.
 */

import { accessSync, constants, statSync } from "node:fs";

import { dlopen, FFIType, ptr, read, suffix } from "bun:ffi";

// ---------------------------------------------------------------------------
// libc
// ---------------------------------------------------------------------------

// glibc exposes no wrapper for the landlock_* syscalls (still true in 2.39),
// so everything goes through syscall(2). Declaring the variadic `syscall` with
// a fixed arity of 7 (number + 6 args) is deliberate: glibc's x86_64
// implementation unconditionally loads arg6 from 8(%rsp), so a shorter
// declaration would hand the kernel an uninitialised stack slot.
const libc = dlopen(`libc.${suffix}.6`, {
  syscall: {
    args: [
      FFIType.i64,
      FFIType.i64,
      FFIType.i64,
      FFIType.i64,
      FFIType.i64,
      FFIType.i64,
      FFIType.i64,
    ],
    returns: FFIType.i64,
  },
  __errno_location: { args: [], returns: FFIType.ptr },
});

function errno(): number {
  // Bun reports a NULL pointer return as 0, not null, so test both.
  const location = libc.symbols.__errno_location();
  if (!location) return 0;
  return read.i32(location, 0);
}

function sys(nr: bigint, ...args: bigint[]): bigint {
  const a = [0n, 0n, 0n, 0n, 0n, 0n];
  for (let i = 0; i < args.length; i += 1) a[i] = args[i] as bigint;
  return libc.symbols.syscall(
    nr,
    a[0] as bigint,
    a[1] as bigint,
    a[2] as bigint,
    a[3] as bigint,
    a[4] as bigint,
    a[5] as bigint,
  );
}

// ---------------------------------------------------------------------------
// syscall numbers
// ---------------------------------------------------------------------------

interface SyscallNumbers {
  readonly openat: bigint;
  readonly close: bigint;
  readonly prctl: bigint;
  readonly execve: bigint;
  readonly landlockCreateRuleset: bigint;
  readonly landlockAddRule: bigint;
  readonly landlockRestrictSelf: bigint;
}

const NUMBERS: Readonly<Record<string, SyscallNumbers>> = {
  x64: {
    openat: 257n,
    close: 3n,
    prctl: 157n,
    execve: 59n,
    // The landlock numbers are identical on every architecture that has them:
    // they were added after the syscall table was unified.
    landlockCreateRuleset: 444n,
    landlockAddRule: 445n,
    landlockRestrictSelf: 446n,
  },
  arm64: {
    openat: 56n,
    close: 57n,
    prctl: 167n,
    execve: 221n,
    landlockCreateRuleset: 444n,
    landlockAddRule: 445n,
    landlockRestrictSelf: 446n,
  },
};

function syscallNumbers(): SyscallNumbers {
  const table = NUMBERS[process.arch];
  if (table === undefined) {
    throw new Error(
      `landlock spike: unsupported architecture ${process.arch} (x64 and arm64 only)`,
    );
  }
  return table;
}

// ---------------------------------------------------------------------------
// uapi/linux/landlock.h constants
// ---------------------------------------------------------------------------

export const LANDLOCK_CREATE_RULESET_VERSION = 1n;

export const ACCESS_FS = {
  EXECUTE: 1n << 0n,
  WRITE_FILE: 1n << 1n,
  READ_FILE: 1n << 2n,
  READ_DIR: 1n << 3n,
  REMOVE_DIR: 1n << 4n,
  REMOVE_FILE: 1n << 5n,
  MAKE_CHAR: 1n << 6n,
  MAKE_DIR: 1n << 7n,
  MAKE_REG: 1n << 8n,
  MAKE_SOCK: 1n << 9n,
  MAKE_FIFO: 1n << 10n,
  MAKE_BLOCK: 1n << 11n,
  MAKE_SYM: 1n << 12n,
  REFER: 1n << 13n, // ABI 2
  TRUNCATE: 1n << 14n, // ABI 3
  IOCTL_DEV: 1n << 15n, // ABI 5
} as const;

export const ACCESS_NET = {
  BIND_TCP: 1n << 0n,
  CONNECT_TCP: 1n << 1n,
} as const;

const RULE_PATH_BENEATH = 1n;
const RULE_NET_PORT = 2n;

const PR_SET_NO_NEW_PRIVS = 38n;

const AT_FDCWD = -100n;
const O_PATH = 0o10000000n;
const O_CLOEXEC = 0o2000000n;

/**
 * Highest filesystem access bit each ABI level understands. Passing a bit the
 * running kernel does not know yields EINVAL, so the handled mask must be
 * clamped to the measured ABI rather than to the header we compiled against.
 */
const FS_MASK_BY_ABI: Readonly<Record<number, bigint>> = {
  1: (1n << 13n) - 1n, // up to MAKE_SYM
  2: (1n << 14n) - 1n, // + REFER
  3: (1n << 15n) - 1n, // + TRUNCATE
  4: (1n << 15n) - 1n, // ABI 4 adds networking, no new FS bit
  5: (1n << 16n) - 1n, // + IOCTL_DEV
};

export const NEWEST_KNOWN_ABI = 5;

export function fsMaskForAbi(abi: number): bigint {
  if (abi <= 0) return 0n;
  const known = FS_MASK_BY_ABI[abi];
  if (known !== undefined) return known;
  // Newer than we know about: clamp to the newest mask we can name. This is a
  // silent UNDER-restriction — any filesystem access class a future kernel adds
  // goes unhandled and therefore unrestricted. It is the same fail-open shape
  // as the ABI<4 network bug with the sign reversed, so the outcome reports it
  // (`abiClamped`) rather than leaving the caller unable to tell "complete"
  // from "clamped".
  return FS_MASK_BY_ABI[NEWEST_KNOWN_ABI] as bigint;
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export class LandlockSyscallError extends Error {
  constructor(
    readonly call: string,
    readonly code: number,
  ) {
    super(`landlock spike: ${call} failed with errno ${code}`);
    this.name = "LandlockSyscallError";
  }
}

function checked(call: string, result: bigint): bigint {
  if (result < 0n) throw new LandlockSyscallError(call, errno());
  return result;
}

// ---------------------------------------------------------------------------
// syscall wrappers
// ---------------------------------------------------------------------------

/**
 * Landlock ABI supported by the running kernel. `0` means the kernel has no
 * Landlock at all (ENOSYS) or it is disabled (EOPNOTSUPP) — both are "cannot
 * use layer 1" and neither is an error worth throwing over.
 */
export function abiVersion(): number {
  const nr = syscallNumbers();
  const result = sys(nr.landlockCreateRuleset, 0n, 0n, LANDLOCK_CREATE_RULESET_VERSION);
  if (result < 0n) return 0;
  return Number(result);
}

function openPath(path: string): number {
  const nr = syscallNumbers();
  const buffer = Buffer.from(`${path}\0`, "utf8");
  const fd = checked(
    `openat(${path})`,
    sys(nr.openat, AT_FDCWD, BigInt(ptr(buffer)), O_PATH | O_CLOEXEC, 0n),
  );
  return Number(fd);
}

function closeFd(fd: number): void {
  const nr = syscallNumbers();
  sys(nr.close, BigInt(fd));
}

function createRuleset(handledFs: bigint, handledNet: bigint, abi: number): number {
  const nr = syscallNumbers();
  // struct landlock_ruleset_attr { __u64 handled_access_fs; __u64 handled_access_net; }
  // The second field only exists from ABI 4; older kernels reject the larger size.
  const size = abi >= 4 ? 16 : 8;
  const attr = new ArrayBuffer(size);
  const view = new DataView(attr);
  view.setBigUint64(0, handledFs, true);
  if (size === 16) view.setBigUint64(8, handledNet, true);
  const fd = checked(
    "landlock_create_ruleset",
    sys(nr.landlockCreateRuleset, BigInt(ptr(attr)), BigInt(size), 0n),
  );
  return Number(fd);
}

function addPathRule(rulesetFd: number, path: string, allowed: bigint): void {
  const nr = syscallNumbers();
  const parentFd = openPath(path);
  try {
    // struct landlock_path_beneath_attr {
    //   __u64 allowed_access; __s32 parent_fd;
    // } __attribute__((packed));   <- 12 bytes, NOT 16
    const attr = new ArrayBuffer(12);
    const view = new DataView(attr);
    view.setBigUint64(0, allowed, true);
    view.setInt32(8, parentFd, true);
    checked(
      `landlock_add_rule(path_beneath ${path})`,
      sys(nr.landlockAddRule, BigInt(rulesetFd), RULE_PATH_BENEATH, BigInt(ptr(attr)), 0n),
    );
  } finally {
    closeFd(parentFd);
  }
}

function addNetRule(rulesetFd: number, port: number, allowed: bigint): void {
  const nr = syscallNumbers();
  // struct landlock_net_port_attr { __u64 allowed_access; __u64 port; }
  const attr = new ArrayBuffer(16);
  const view = new DataView(attr);
  view.setBigUint64(0, allowed, true);
  view.setBigUint64(8, BigInt(port), true);
  checked(
    `landlock_add_rule(net_port ${port})`,
    sys(nr.landlockAddRule, BigInt(rulesetFd), RULE_NET_PORT, BigInt(ptr(attr)), 0n),
  );
}

function setNoNewPrivs(): void {
  const nr = syscallNumbers();
  checked("prctl(PR_SET_NO_NEW_PRIVS)", sys(nr.prctl, PR_SET_NO_NEW_PRIVS, 1n, 0n, 0n, 0n));
}

function restrictSelf(rulesetFd: number): void {
  const nr = syscallNumbers();
  checked("landlock_restrict_self", sys(nr.landlockRestrictSelf, BigInt(rulesetFd), 0n));
}

// ---------------------------------------------------------------------------
// the one entry point the spike needs
// ---------------------------------------------------------------------------

export interface PathRule {
  readonly path: string;
  readonly allowed: bigint;
}

export interface NetRule {
  readonly port: number;
  readonly allowed: bigint;
}

export interface RestrictRequest {
  readonly paths: readonly PathRule[];
  /** Omitted entirely when the ABI is below 4. */
  readonly net?: readonly NetRule[];
  readonly handleNet?: boolean;
}

export interface RestrictOutcome {
  readonly abi: number;
  readonly handledFs: bigint;
  readonly handledNet: bigint;
  readonly pathRules: number;
  readonly netRules: number;
  /**
   * True when the kernel's ABI is newer than this code knows, so the handled
   * FS mask was clamped and any newer access class is UNRESTRICTED. Surfaced
   * so a caller can refuse rather than silently under-restrict.
   */
  readonly abiClamped: boolean;
}

/**
 * Fail closed rather than degrade when the TCP axis is unavailable.
 *
 * Silently reducing a requested TCP axis to "unhandled" on an older kernel
 * would let the command run with an unrestricted network at exit 0 — a caller
 * who asked for the axis and got no error would believe a boundary exists
 * where none does. That is the exact defect ADR-0010 was written to remove,
 * one layer down.
 *
 * Exported and pure so the behaviour can be asserted on a host whose kernel
 * cannot reach the branch (this one reports ABI 4).
 */
export function assertNetSupported(abi: number, wantsNet: boolean): void {
  if (wantsNet && abi < 4) {
    throw new Error(
      `landlock spike: TCP restriction requires Landlock ABI >= 4, kernel reports ${abi}`,
    );
  }
}

/**
 * Applies the ruleset to the CURRENT process. Irreversible — see
 * specification.md §4.1. Never call this in a long-lived keryx process.
 */
export function restrictSelfWith(request: RestrictRequest): RestrictOutcome {
  const abi = abiVersion();
  if (abi < 1) throw new Error("landlock spike: kernel reports Landlock ABI 0");

  const handledFs = fsMaskForAbi(abi);
  const wantsNet = request.handleNet === true || (request.net?.length ?? 0) > 0;

  assertNetSupported(abi, wantsNet);

  const handledNet = wantsNet ? ACCESS_NET.BIND_TCP | ACCESS_NET.CONNECT_TCP : 0n;

  let netRulesAdded = 0;
  const rulesetFd = createRuleset(handledFs, handledNet, abi);
  try {
    for (const rule of request.paths) {
      // A rule may not grant more than the ruleset handles.
      addPathRule(rulesetFd, rule.path, rule.allowed & handledFs);
    }
    for (const rule of request.net ?? []) {
      addNetRule(rulesetFd, rule.port, rule.allowed & handledNet);
      netRulesAdded += 1;
    }
    // PR_SET_NO_NEW_PRIVS must be set before restrict_self, or restrict_self
    // returns EPERM. Note what it does and does not do: it prevents a set-uid
    // or file-capability binary from GAINING privileges across execve inside
    // the domain. It is not what keeps the ruleset attached — a Landlock
    // domain cannot be shed by anything, with or without this flag.
    setNoNewPrivs();
    restrictSelf(rulesetFd);
  } finally {
    closeFd(rulesetFd);
  }

  return {
    abi,
    handledFs,
    handledNet,
    pathRules: request.paths.length,
    // Rules actually added, not rules requested — so --verbose cannot report a
    // restriction that was never installed.
    netRules: netRulesAdded,
    abiClamped: abi > NEWEST_KNOWN_ABI,
  };
}

/**
 * Resolves a bare program name against PATH, the way `execvp` does.
 *
 * `execve` takes a path and performs no search, so without this the two run
 * modes would diverge: `Bun.spawnSync` resolves PATH, so `-- echo hi` would
 * work under `--spawn` and fail under `--execve`. Two modes that the finding
 * describes as differing only in process residency must not also differ in
 * which commands they can start.
 */
function resolveProgram(program: string, env: NodeJS.ProcessEnv): string {
  if (program.includes("/")) return program;
  const search = env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  for (const dir of search.split(":")) {
    // An empty PATH element means "the current directory" to execvp. This
    // deliberately does NOT honour that: the cwd of a contained command is
    // attacker-influenced workspace, and silently prepending it to the search
    // path is the classic implicit-CWD hole. Documented as an intentional
    // divergence from execvp rather than replicated.
    if (dir === "") continue;
    const candidate = `${dir}/${program}`;
    try {
      // Must be a regular file AND executable. accessSync(X_OK) alone is
      // satisfied by a directory — /usr/bin/X11 is a real example — and
      // returning one would hand execve an EACCES that looks like a policy
      // denial. execvp keeps searching on such a hit, so this does too.
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable; keep searching, exactly as execvp does.
    }
  }
  // Never return the bare name: raw execve resolves a name with no slash
  // against the CURRENT DIRECTORY, so falling through would execute a file
  // planted in the writable workspace whenever the real tool is missing.
  // execvp reports ENOENT here, and so does this.
  throw new Error(`landlock spike: ${program}: not found on PATH`);
}

/**
 * Replaces the current process image with `command`. Only returns on failure,
 * and on failure it throws.
 *
 * Why this matters for the spike: `Bun.spawnSync` leaves the Bun process
 * resident as the parent of the contained command for its whole lifetime —
 * tens of MB of RSS per concurrently contained command, and an extra node in
 * the process tree. execve removes both.
 */
export function execIntoCommand(command: readonly string[], env: NodeJS.ProcessEnv): never {
  const [program] = command as [string, ...string[]];
  const resolved = resolveProgram(program, env);

  // argv and envp are NULL-terminated arrays of pointers to NUL-terminated
  // strings. Every Buffer AND both pointer tables must stay reachable until
  // execve replaces us, so all of them go in `pinned` — a table whose only
  // reachability was the JS engine's conservative stack scan would be relying
  // on an implementation detail, not a guarantee.
  const pinned: (Buffer | ArrayBuffer)[] = [];
  const toArray = (values: readonly string[]): ArrayBuffer => {
    const table = new ArrayBuffer((values.length + 1) * 8);
    const view = new DataView(table);
    values.forEach((value, index) => {
      const buffer = Buffer.from(`${value}\0`, "utf8");
      pinned.push(buffer);
      view.setBigUint64(index * 8, BigInt(ptr(buffer)), true);
    });
    view.setBigUint64(values.length * 8, 0n, true);
    pinned.push(table);
    return table;
  };

  const argvTable = toArray(command);
  const envpTable = toArray(
    Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`),
  );
  const programBuffer = Buffer.from(`${resolved}\0`, "utf8");
  pinned.push(programBuffer);

  const nr = syscallNumbers();
  sys(
    nr.execve,
    BigInt(ptr(programBuffer)),
    BigInt(ptr(argvTable)),
    BigInt(ptr(envpTable)),
  );
  // Only reachable if execve failed. Keeping the tables referenced here is what
  // holds them alive across the call above.
  void pinned;
  throw new LandlockSyscallError(`execve(${resolved})`, errno());
}

/** Read + traverse + execute, no mutation. */
export const READ_ONLY_ACCESS =
  ACCESS_FS.EXECUTE | ACCESS_FS.READ_FILE | ACCESS_FS.READ_DIR;

/**
 * A fully writable hierarchy.
 *
 * Deliberately does NOT include `IOCTL_DEV` (ABI 5). That bit exists precisely
 * to gate device ioctls, and folding it into the general read-write set would
 * mean every `--rw` grant silently confers device control on any device node
 * beneath it. A bit that is handled but granted by no rule in a given hierarchy
 * is a deliberate deny, not an oversight — device rights follow the `--dev`
 * flag that names device semantics. See `DEVICE_ACCESS`.
 */
export const READ_WRITE_ACCESS =
  READ_ONLY_ACCESS |
  ACCESS_FS.WRITE_FILE |
  ACCESS_FS.REMOVE_DIR |
  ACCESS_FS.REMOVE_FILE |
  ACCESS_FS.MAKE_CHAR |
  ACCESS_FS.MAKE_DIR |
  ACCESS_FS.MAKE_REG |
  ACCESS_FS.MAKE_SOCK |
  ACCESS_FS.MAKE_FIFO |
  ACCESS_FS.MAKE_BLOCK |
  ACCESS_FS.MAKE_SYM |
  ACCESS_FS.REFER |
  ACCESS_FS.TRUNCATE;

/**
 * What a device directory actually needs: open, read, write, list, and device
 * ioctls. Much narrower than `READ_WRITE_ACCESS` — no node creation
 * (`MAKE_CHAR`/`MAKE_BLOCK`/`MAKE_SOCK`/`MAKE_FIFO`/`MAKE_SYM`/`MAKE_DIR`), no
 * removal, no truncation, no cross-hierarchy `REFER`. A contained process
 * cannot unlink or truncate `/dev/null`.
 *
 * `IOCTL_DEV` belongs here rather than in the general read-write set, so device
 * control follows the flag that names device semantics.
 *
 * `/dev/shm` needs more than this — it is a tmpfs where `shm_open`/`sem_open`
 * create and unlink regular files — but the answer is a **nested** `--rw
 * /dev/shm` rule, not a wider `/dev`. Landlock evaluates the most specific
 * matching hierarchy, so the narrow grant here and the wider one beneath it
 * coexist. An earlier revision widened all of `/dev` instead; that let a
 * contained process unlink device nodes to solve a `/dev/shm` problem.
 */
export const DEVICE_ACCESS =
  ACCESS_FS.READ_FILE | ACCESS_FS.WRITE_FILE | ACCESS_FS.READ_DIR | ACCESS_FS.IOCTL_DEV;

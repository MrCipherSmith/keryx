// The Landlock applier (keryx-linux-containment, specification §4.2) — the
// short-lived child that restricts itself and then *becomes* the command.
//
// This is the one module in the package that touches the kernel. `landlock.ts`
// decides what the boundary is; this decides nothing and applies exactly what it
// was given. The split is not tidiness: a Landlock ruleset cannot be undone, so
// rules may never be applied in the long-lived keryx process (§4.1). They are
// applied here, in a process whose entire remaining life is one `execve`.
//
// Shape, mirroring how `bwrap.ts` produces `bwrap <args> -- <cmd>`:
//
//     <bun> <…>/landlock-exec.js --ruleset <json> -- <program> [args…]
//
// ## Why `execve` and not `Bun.spawnSync`
//
// Spawning would leave this Bun process resident as the parent of the contained
// command for its whole lifetime — tens of MB of RSS per concurrent command, and
// an extra node in the process tree the harness would have to reason about for
// signals and exit codes. `execve` replaces this process with the command, which
// is one node fewer than even bubblewrap leaves behind. Measured in the step-2
// spike (flow 143), which also had to learn that `Bun.spawnSync` reports
// `exitCode: null` for a signalled child and `process.exit(null)` exits 0 — a
// SIGKILLed command reporting success. `execve` has no such seam: the kernel owns
// the status from the moment the image is replaced.
//
// ## The exit code is a channel the contained command controls
//
// {@link LANDLOCK_APPLY_FAILED} is emitted when the boundary could not be
// established. It is *also* a status a contained command may choose for itself,
// so no caller may read it as proof of anything: the run receipt records which
// layer ran, from the parent's decision, and that is the channel this child
// cannot write to. The exit code exists so a human sees a failure, not so a
// program infers one.

import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { posix as posixPath } from "node:path";
import { LANDLOCK_FS_ACCESS_BIT, landlockFsMask } from "./landlock";
import type { LandlockFsAccess, LandlockPathRule, LandlockRuleset } from "./landlock";

/**
 * Exit status when the boundary could not be established and the command was
 * therefore never started.
 *
 * 125 is `git bisect`'s "cannot test this revision" and the same status GNU
 * `env` uses for its own failures, so it is conventionally "the wrapper failed,
 * not the command". Never degrade instead: a command that runs with a boundary
 * the caller asked for and did not get is the defect ADR-0010 exists to remove.
 */
export const LANDLOCK_APPLY_FAILED = 125;

/** The newest Landlock ABI whose access rights this module knows how to name. */
export const NEWEST_KNOWN_ABI = 5;

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

/** A parsed `--ruleset <json> -- <cmd…>` invocation. */
export interface LandlockExecInvocation {
  readonly ruleset: LandlockRuleset;
  /** The command, argv[0] included. Never empty. */
  readonly command: readonly string[];
}

export type LandlockExecArgv =
  | { readonly ok: true; readonly invocation: LandlockExecInvocation }
  | { readonly ok: false; readonly reason: string };

/**
 * Parse the child's own argv.
 *
 * Deliberately strict and deliberately not a general option parser: this
 * interface has exactly one caller (`wrap.ts`) and one shape, and anything it
 * accepts loosely is a shape a contained command could try to reach. An unknown
 * flag is a refusal, not a warning.
 *
 * The ruleset travels as JSON on argv rather than through a file or an
 * environment variable because `wrap.ts` must stay pure — it returns a command,
 * it does not create files. The contents are paths and right names, never
 * secrets, so argv's visibility in `/proc` costs nothing here.
 */
export function parseLandlockExecArgv(argv: readonly string[]): LandlockExecArgv {
  if (argv[0] !== "--ruleset") {
    return { ok: false, reason: `expected --ruleset as the first argument, got ${describe(argv[0])}` };
  }
  const raw = argv[1];
  if (raw === undefined) {
    return { ok: false, reason: "--ruleset requires a JSON argument" };
  }
  if (argv[2] !== "--") {
    return { ok: false, reason: `expected -- after the ruleset, got ${describe(argv[2])}` };
  }
  const command = argv.slice(3);
  if (command.length === 0 || command[0] === undefined || command[0] === "") {
    return { ok: false, reason: "no command was given after --" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `--ruleset is not valid JSON: ${messageOf(error)}` };
  }
  const ruleset = validateRuleset(parsed);
  if (typeof ruleset === "string") {
    return { ok: false, reason: ruleset };
  }
  return { ok: true, invocation: { ruleset, command } };
}

/**
 * Validate the decoded ruleset, returning it or a reason string.
 *
 * Everything here was produced by `landlock.ts` moments ago in the parent, so
 * this is not defending against a hostile author — it is refusing to guess. A
 * ruleset that arrived malformed means the two processes disagree about the
 * boundary, and applying the half of it that parsed is exactly the "approximate
 * a boundary" failure the specification forbids.
 */
function validateRuleset(value: unknown): LandlockRuleset | string {
  if (typeof value !== "object" || value === null) {
    return "--ruleset must be a JSON object";
  }
  const candidate = value as Record<string, unknown>;
  const minimumAbi = candidate.minimumAbi;
  if (typeof minimumAbi !== "number" || !Number.isInteger(minimumAbi) || minimumAbi < 1) {
    return `ruleset.minimumAbi must be a positive integer, got ${describe(minimumAbi)}`;
  }
  const handledFs = validateRights(candidate.handledFs, "ruleset.handledFs");
  if (typeof handledFs === "string") {
    return handledFs;
  }
  if (handledFs.length === 0) {
    return "ruleset.handledFs is empty; landlock_create_ruleset rejects an empty mask";
  }
  if (!Array.isArray(candidate.pathRules)) {
    return "ruleset.pathRules must be an array";
  }
  const pathRules: LandlockPathRule[] = [];
  for (const [index, entry] of candidate.pathRules.entries()) {
    const rule = validatePathRule(entry, index, handledFs);
    if (typeof rule === "string") {
      return rule;
    }
    pathRules.push(rule);
  }
  return {
    minimumAbi,
    handledFs,
    handledNet: [],
    pathRules,
    netRules: [],
  };
}

function validatePathRule(
  value: unknown,
  index: number,
  handledFs: readonly LandlockFsAccess[],
): LandlockPathRule | string {
  const where = `ruleset.pathRules[${index}]`;
  if (typeof value !== "object" || value === null) {
    return `${where} must be an object`;
  }
  const candidate = value as Record<string, unknown>;
  const path = candidate.path;
  if (typeof path !== "string" || !posixPath.isAbsolute(path) || path.includes("\0")) {
    return `${where}.path must be an absolute NUL-free path, got ${describe(path)}`;
  }
  const allow = validateRights(candidate.allow, `${where}.allow`);
  if (typeof allow === "string") {
    return allow;
  }
  if (allow.length === 0) {
    return `${where}.allow is empty; landlock_add_rule rejects an empty access set (ENOMSG)`;
  }
  // A rule may not grant more than the ruleset handles. The applier masks it
  // anyway, but a rule that asked for more means the parent built something this
  // child would silently narrow — and a silently narrowed grant is a command
  // that fails for reasons nobody can trace back to a boundary decision.
  const excess = allow.filter((right) => !handledFs.includes(right));
  if (excess.length > 0) {
    return `${where}.allow grants ${excess.join(", ")}, which ruleset.handledFs does not handle`;
  }
  const onMissing = candidate.onMissing;
  if (onMissing !== "fail" && onMissing !== "skip") {
    return `${where}.onMissing must be "fail" or "skip", got ${describe(onMissing)}`;
  }
  return { path, allow, onMissing };
}

function validateRights(value: unknown, where: string): LandlockFsAccess[] | string {
  if (!Array.isArray(value)) {
    return `${where} must be an array of access-right names`;
  }
  const rights: LandlockFsAccess[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !(entry in LANDLOCK_FS_ACCESS_BIT)) {
      return `${where} contains ${describe(entry)}, which is not a Landlock access right`;
    }
    rights.push(entry as LandlockFsAccess);
  }
  return rights;
}

function describe(value: unknown): string {
  return value === undefined ? "nothing" : JSON.stringify(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// PATH resolution
// ---------------------------------------------------------------------------

/** The filesystem seam, injected so resolution is testable without a host. */
export interface ProgramResolverDeps {
  readonly isFile: (path: string) => boolean;
  readonly isExecutable: (path: string) => boolean;
}

export const defaultProgramResolverDeps: ProgramResolverDeps = Object.freeze({
  isFile: (path: string) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  isExecutable: (path: string) => {
    try {
      accessSync(path, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
});

/**
 * Resolve a program the way `execvp` does — and refuse where `execvp` refuses.
 *
 * Raw `execve` performs no `PATH` search and resolves a slash-free name against
 * the **current directory**, which for a contained command is attacker-influenced
 * workspace. So a miss here must be an error: returning the bare name would run
 * a file planted in the workspace precisely when the real tool is absent, which
 * is a worse outcome than the missing tool. `execvp` reports `ENOENT`, and so
 * does this.
 *
 * Two divergences from `execvp`, both deliberate:
 *
 * - An **empty `PATH` element** means "the current directory" to `execvp`. It is
 *   skipped here, for the reason above.
 * - A candidate must be a **regular file**. `access(X_OK)` is satisfied by a
 *   directory — `/usr/bin/X11` is a real one — and returning it would hand
 *   `execve` an `EACCES` that reads like a policy denial. `execvp` keeps
 *   searching on such a hit; so does this.
 */
export function resolveProgram(
  program: string,
  env: Record<string, string | undefined>,
  deps: ProgramResolverDeps = defaultProgramResolverDeps,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (program.includes("/")) {
    return { ok: true, path: program };
  }
  const search = env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  for (const dir of search.split(":")) {
    if (dir === "") {
      continue;
    }
    const candidate = `${dir}/${program}`;
    if (deps.isFile(candidate) && deps.isExecutable(candidate)) {
      return { ok: true, path: candidate };
    }
  }
  return {
    ok: false,
    reason: `${program}: not found on PATH (a bare name is never resolved against the working directory)`,
  };
}

// ---------------------------------------------------------------------------
// the ruleset, as the kernel wants it
// ---------------------------------------------------------------------------

/**
 * Highest filesystem access bit each ABI understands, as a mask.
 *
 * Passing a bit the running kernel does not know yields `EINVAL`, so the handled
 * mask is clamped to the *measured* ABI rather than to the table this file was
 * written against.
 *
 * The clamp is asymmetric, and only one direction is dangerous. Too old is
 * handled by refusing outright (`minimumAbi`). A kernel **newer** than this
 * table silently leaves its new access classes unhandled and therefore
 * unrestricted — so {@link buildKernelRuleset} reports it rather than letting a
 * caller mistake "clamped" for "complete".
 */
const FS_MASK_BY_ABI: Readonly<Record<number, bigint>> = Object.freeze({
  1: (1n << 13n) - 1n, // up to make_sym
  2: (1n << 14n) - 1n, // + refer
  3: (1n << 15n) - 1n, // + truncate
  4: (1n << 15n) - 1n, // ABI 4 adds networking, no new filesystem bit
  5: (1n << 16n) - 1n, // + ioctl_dev
});

export function fsMaskForAbi(abi: number): bigint {
  if (abi <= 0) {
    return 0n;
  }
  return FS_MASK_BY_ABI[abi] ?? (FS_MASK_BY_ABI[NEWEST_KNOWN_ABI] as bigint);
}

/** A ruleset reduced to the masks and paths the syscalls take. */
export interface KernelRuleset {
  readonly handledFs: bigint;
  readonly rules: readonly { readonly path: string; readonly allowed: bigint; readonly onMissing: "fail" | "skip" }[];
  /**
   * True when the kernel is newer than {@link NEWEST_KNOWN_ABI}, so any access
   * class it added since is unhandled and therefore unrestricted.
   */
  readonly abiClamped: boolean;
}

export type KernelRulesetResult =
  | { readonly ok: true; readonly ruleset: KernelRuleset }
  | { readonly ok: false; readonly reason: string };

/**
 * Fold a ruleset description into kernel masks against a measured ABI.
 *
 * Refuses below `minimumAbi` rather than dropping the rights the kernel lacks:
 * the profile's boundary depends on them, and a ruleset that quietly omits
 * `truncate` leaves truncation unrestricted everywhere while reporting success.
 */
/**
 * The kernel seam.
 *
 * Every call reports a reason instead of throwing, and `addPathRule`
 * distinguishes "this path does not exist" from every other failure — that
 * distinction is what `onMissing` is decided against, and an applier that
 * collapsed the two would treat a permissions error on `/dev/tty` as an absent
 * device and carry on with a boundary nobody asked for.
 *
 * Injectable so the *order* of operations can be asserted without a kernel:
 * `PR_SET_NO_NEW_PRIVS` before `landlock_restrict_self` is not a style
 * preference, it is `EPERM` when reversed.
 */
export interface LandlockKernel {
  abiVersion(): number;
  createRuleset(handledFs: bigint, abi: number): { ok: true; fd: number } | { ok: false; reason: string };
  addPathRule(
    fd: number,
    path: string,
    allowed: bigint,
  ): { ok: true } | { ok: false; missing: boolean; reason: string };
  setNoNewPrivs(): { ok: true } | { ok: false; reason: string };
  restrictSelf(fd: number): { ok: true } | { ok: false; reason: string };
  closeRuleset(fd: number): void;
}

export type ApplyResult =
  | { readonly ok: true; readonly applied: readonly string[]; readonly skipped: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Apply a ruleset to the **current** process. Irreversible (§4.1) — never call
 * this anywhere but in the short-lived child.
 *
 * A rule whose path is absent is fatal or skipped according to its own
 * disposition, and nothing else is ever forgiven: a rule the kernel refused for
 * any other reason means the boundary is not the one that was described, and
 * running the command anyway is the failure mode this package exists to remove.
 */
export function applyRuleset(ruleset: KernelRuleset, kernel: LandlockKernel): ApplyResult {
  const abi = kernel.abiVersion();
  const created = kernel.createRuleset(ruleset.handledFs, abi);
  if (!created.ok) {
    return created;
  }
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    for (const rule of ruleset.rules) {
      const added = kernel.addPathRule(created.fd, rule.path, rule.allowed);
      if (added.ok) {
        applied.push(rule.path);
        continue;
      }
      if (added.missing && rule.onMissing === "skip") {
        skipped.push(rule.path);
        continue;
      }
      return {
        ok: false,
        reason: added.missing
          ? `required rule path ${JSON.stringify(rule.path)} does not exist; refusing to run with a boundary that is missing one of its grants`
          : `could not add the rule for ${JSON.stringify(rule.path)}: ${added.reason}`,
      };
    }
    // Order is load-bearing: restrict_self returns EPERM without this.
    const noNewPrivs = kernel.setNoNewPrivs();
    if (!noNewPrivs.ok) {
      return noNewPrivs;
    }
    const restricted = kernel.restrictSelf(created.fd);
    if (!restricted.ok) {
      return restricted;
    }
  } finally {
    kernel.closeRuleset(created.fd);
  }
  return { ok: true, applied, skipped };
}

export function buildKernelRuleset(ruleset: LandlockRuleset, abi: number): KernelRulesetResult {
  if (!Number.isInteger(abi) || abi < 1) {
    return { ok: false, reason: `the kernel reports Landlock ABI ${abi}; Landlock is unavailable here` };
  }
  if (abi < ruleset.minimumAbi) {
    return {
      ok: false,
      reason: `this ruleset needs Landlock ABI ${ruleset.minimumAbi} and the kernel reports ${abi}; refusing rather than applying a weaker boundary than the profile asks for`,
    };
  }
  const supported = fsMaskForAbi(abi);
  const handledFs = landlockFsMask(ruleset.handledFs) & supported;
  if (handledFs === 0n) {
    return { ok: false, reason: "the handled access set is empty after clamping to this kernel's ABI" };
  }
  return {
    ok: true,
    ruleset: {
      handledFs,
      // Masked here rather than at add-rule time so the whole boundary is one
      // value a test can compare, and so a rule can never grant more than the
      // ruleset handles (the kernel rejects that with EINVAL).
      rules: ruleset.pathRules.map((rule) => ({
        path: rule.path,
        allowed: landlockFsMask(rule.allow) & handledFs,
        onMissing: rule.onMissing,
      })),
      abiClamped: abi > NEWEST_KNOWN_ABI,
    },
  };
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

/** Everything the run touches that is not a pure function. */
export interface LandlockExecDeps {
  readonly kernel: LandlockKernel;
  readonly resolver: ProgramResolverDeps;
  /** Replaces this process with `command`. Only returns if `execve` failed. */
  readonly exec: (path: string, command: readonly string[], env: Record<string, string | undefined>) => string;
  readonly warn: (line: string) => void;
}

/**
 * Parse, apply, become the command.
 *
 * Returns only on failure, and what it returns is the exit status
 * ({@link LANDLOCK_APPLY_FAILED}) plus the reason. On success this function does
 * not return at all — the process image is gone.
 *
 * The program is resolved **before** the ruleset is applied. Landlock does not
 * restrict `stat`, so the order changes nothing about what can be discovered; it
 * changes the diagnostic, because "not found on PATH" is a better message than
 * an `EACCES` from `execve` that reads like a boundary denial.
 */
export function runLandlockExec(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: LandlockExecDeps,
): { readonly code: number; readonly reason: string } {
  const parsed = parseLandlockExecArgv(argv);
  if (!parsed.ok) {
    return { code: LANDLOCK_APPLY_FAILED, reason: parsed.reason };
  }
  const { ruleset, command } = parsed.invocation;

  const program = resolveProgram(command[0] as string, env, deps.resolver);
  if (!program.ok) {
    return { code: LANDLOCK_APPLY_FAILED, reason: program.reason };
  }

  const kernelRuleset = buildKernelRuleset(ruleset, deps.kernel.abiVersion());
  if (!kernelRuleset.ok) {
    return { code: LANDLOCK_APPLY_FAILED, reason: kernelRuleset.reason };
  }
  if (kernelRuleset.ruleset.abiClamped) {
    // Reported, not refused. Refusing would make every kernel newer than this
    // table unusable, which trades a partial boundary for no boundary at all;
    // saying nothing would let "clamped" be read as "complete". See the flow's
    // decision note.
    deps.warn(
      `keryx sandbox: this kernel's Landlock ABI is newer than ABI ${NEWEST_KNOWN_ABI}; any access class added since is unhandled and therefore unrestricted.`,
    );
  }

  const applied = applyRuleset(kernelRuleset.ruleset, deps.kernel);
  if (!applied.ok) {
    return { code: LANDLOCK_APPLY_FAILED, reason: applied.reason };
  }

  // From here the boundary is in force whatever happens next, including if the
  // exec below fails — this process cannot shed a Landlock domain.
  const failure = deps.exec(program.path, command, env);
  return { code: LANDLOCK_APPLY_FAILED, reason: `could not execute ${program.path}: ${failure}` };
}

// ---------------------------------------------------------------------------
// the libc binding — the only part that needs a kernel
// ---------------------------------------------------------------------------

/**
 * Syscall numbers. The three `landlock_*` numbers are identical on every
 * architecture that has them: they were added after the syscall table was
 * unified. Everything else differs, and getting one wrong is not a compile
 * error — it is a different syscall.
 */
const SYSCALL_NUMBERS: Readonly<Record<string, Readonly<Record<string, bigint>>>> = Object.freeze({
  x64: Object.freeze({ openat: 257n, close: 3n, prctl: 157n, execve: 59n }),
  arm64: Object.freeze({ openat: 56n, close: 57n, prctl: 167n, execve: 221n }),
});

const LANDLOCK_CREATE_RULESET = 444n;
const LANDLOCK_ADD_RULE = 445n;
const LANDLOCK_RESTRICT_SELF = 446n;
const LANDLOCK_CREATE_RULESET_VERSION = 1n;
const LANDLOCK_RULE_PATH_BENEATH = 1n;
const PR_SET_NO_NEW_PRIVS = 38n;
const AT_FDCWD = -100n;
const O_PATH = 0o10000000n;
const O_CLOEXEC = 0o2000000n;
const ENOENT = 2;

/**
 * Bind the syscalls this module needs, through `bun:ffi`.
 *
 * `glibc` exposes no wrapper for the `landlock_*` syscalls, so everything goes
 * through `syscall(2)`. That variadic function is declared with a **fixed arity
 * of 7** (number plus six arguments) deliberately: glibc's x86_64 implementation
 * unconditionally loads the sixth argument from `8(%rsp)`, so a shorter
 * declaration hands the kernel an uninitialised stack slot — silently, and only
 * sometimes.
 *
 * Imported dynamically so that importing this module for its pure parts does not
 * `dlopen` libc.
 */
export async function createLibcKernel(): Promise<LandlockKernel & Pick<LandlockExecDeps, "exec">> {
  const { dlopen, FFIType, ptr, read, suffix } = await import("bun:ffi");
  const numbers = SYSCALL_NUMBERS[process.arch];
  if (numbers === undefined) {
    throw new Error(`keryx sandbox: Landlock is unsupported on ${process.arch} (x64 and arm64 only)`);
  }

  const i64 = FFIType.i64;
  const libc = dlopen(`libc.${suffix}.6`, {
    syscall: { args: [i64, i64, i64, i64, i64, i64, i64], returns: i64 },
    __errno_location: { args: [], returns: FFIType.ptr },
  });

  const errno = (): number => {
    const location = libc.symbols.__errno_location();
    // Bun reports a NULL pointer return as 0, not null, so both are checked.
    return location ? read.i32(location, 0) : 0;
  };
  const sys = (nr: bigint, ...args: bigint[]): bigint => {
    const a = [0n, 0n, 0n, 0n, 0n, 0n];
    for (let i = 0; i < args.length; i += 1) {
      a[i] = args[i] as bigint;
    }
    return libc.symbols.syscall(
      nr,
      a[0] as bigint,
      a[1] as bigint,
      a[2] as bigint,
      a[3] as bigint,
      a[4] as bigint,
      a[5] as bigint,
    );
  };
  const fail = (call: string) => ({ ok: false as const, reason: `${call} failed with errno ${errno()}` });

  return {
    abiVersion(): number {
      const result = sys(LANDLOCK_CREATE_RULESET, 0n, 0n, LANDLOCK_CREATE_RULESET_VERSION);
      // ENOSYS (no Landlock) and EOPNOTSUPP (disabled) are both "cannot use
      // layer 1", and neither is worth an exception.
      return result < 0n ? 0 : Number(result);
    },

    createRuleset(handledFs, abi) {
      // struct landlock_ruleset_attr { __u64 handled_access_fs; __u64 handled_access_net; }
      // The second field exists only from ABI 4; older kernels reject the larger
      // size. No profile carries network rights (§4.3), so it is always zero.
      const size = abi >= 4 ? 16 : 8;
      const attr = new ArrayBuffer(size);
      new DataView(attr).setBigUint64(0, handledFs, true);
      const fd = sys(LANDLOCK_CREATE_RULESET, BigInt(ptr(attr)), BigInt(size), 0n);
      if (fd < 0n) {
        return fail("landlock_create_ruleset");
      }
      return { ok: true, fd: Number(fd) };
    },

    addPathRule(rulesetFd, path, allowed) {
      const pathBuffer = Buffer.from(`${path}\0`, "utf8");
      const parentFd = sys(numbers.openat as bigint, AT_FDCWD, BigInt(ptr(pathBuffer)), O_PATH | O_CLOEXEC, 0n);
      if (parentFd < 0n) {
        const code = errno();
        return { ok: false, missing: code === ENOENT, reason: `openat(${path}) failed with errno ${code}` };
      }
      try {
        // struct landlock_path_beneath_attr { __u64 allowed_access; __s32 parent_fd; }
        // __attribute__((packed)) — 12 bytes, not 16. A 16-byte buffer yields
        // EINVAL that looks like a permissions problem.
        const attr = new ArrayBuffer(12);
        const view = new DataView(attr);
        view.setBigUint64(0, allowed, true);
        view.setInt32(8, Number(parentFd), true);
        const result = sys(LANDLOCK_ADD_RULE, BigInt(rulesetFd), LANDLOCK_RULE_PATH_BENEATH, BigInt(ptr(attr)), 0n);
        if (result < 0n) {
          return { ok: false, missing: false, reason: `landlock_add_rule(${path}) failed with errno ${errno()}` };
        }
        return { ok: true };
      } finally {
        sys(numbers.close as bigint, parentFd);
      }
    },

    setNoNewPrivs() {
      const result = sys(numbers.prctl as bigint, PR_SET_NO_NEW_PRIVS, 1n, 0n, 0n, 0n);
      return result < 0n ? fail("prctl(PR_SET_NO_NEW_PRIVS)") : { ok: true };
    },

    restrictSelf(fd) {
      const result = sys(LANDLOCK_RESTRICT_SELF, BigInt(fd), 0n);
      return result < 0n ? fail("landlock_restrict_self") : { ok: true };
    },

    closeRuleset(fd) {
      sys(numbers.close as bigint, BigInt(fd));
    },

    exec(path, command, env) {
      // argv and envp are NULL-terminated arrays of pointers to NUL-terminated
      // strings. Every buffer AND both pointer tables must stay reachable until
      // execve replaces this process, so all of them are held in `pinned`:
      // relying on the engine's conservative stack scan would be relying on an
      // implementation detail.
      const pinned: (Buffer | ArrayBuffer)[] = [];
      const toTable = (values: readonly string[]): ArrayBuffer => {
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

      const argvTable = toTable(command);
      const envpTable = toTable(
        Object.entries(env)
          .filter((entry): entry is [string, string] => entry[1] !== undefined)
          .map(([key, value]) => `${key}=${value}`),
      );
      const programBuffer = Buffer.from(`${path}\0`, "utf8");
      pinned.push(programBuffer);

      sys(numbers.execve as bigint, BigInt(ptr(programBuffer)), BigInt(ptr(argvTable)), BigInt(ptr(envpTable)));
      // Only reachable when execve failed; referencing `pinned` here is what
      // keeps the tables alive across the call above.
      void pinned;
      return `errno ${errno()}`;
    },
  };
}

/**
 * The entry point `wrap.ts`'s command names.
 *
 * Everything it can do wrong exits {@link LANDLOCK_APPLY_FAILED} with the reason
 * on stderr, and the command is never started. Success does not return.
 */
export async function main(argv: readonly string[]): Promise<never> {
  let kernel: LandlockKernel & Pick<LandlockExecDeps, "exec">;
  try {
    kernel = await createLibcKernel();
  } catch (error) {
    process.stderr.write(`keryx sandbox: ${messageOf(error)}\n`);
    process.exit(LANDLOCK_APPLY_FAILED);
  }
  const { code, reason } = runLandlockExec(argv, process.env, {
    kernel,
    resolver: defaultProgramResolverDeps,
    exec: kernel.exec,
    warn: (line) => process.stderr.write(`${line}\n`),
  });
  process.stderr.write(`keryx sandbox: ${reason}\n`);
  process.exit(code);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}

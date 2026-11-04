import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { withoutGitDiscoveryOverrides } from "../lib/git-env";
import { worktreeProvenance } from "./worktree-provenance";

/**
 * What a mutant changes. `behavior` alters what the code does; `presentation` alters only how it
 * looks or reads (copy, class names, ordering of display rows). A survivor of the second kind is not
 * evidence that behaviour is unpinned, so the severity audit does not raise a finding on it.
 */
export type MutantKind = "behavior" | "presentation";
export const MUTANT_KINDS: readonly MutantKind[] = ["behavior", "presentation"];

export type MutantSpec = {
  id: string;
  file: string;
  /** Exact text that occurs once in the file. */
  anchor: string;
  replacement: string;
  note?: string | undefined;
  /** Absent means `behavior`. */
  kind?: MutantKind | undefined;
};

export type MutantStatus = "killed" | "survived" | "invalid" | "timeout";

export type MutantResult = {
  id: string;
  file: string;
  line?: number | undefined;
  anchor: string;
  replacement: string;
  status: MutantStatus;
  /** The test command this row was judged by; absent in records written before the field existed. */
  command?: string | undefined;
  exitCode?: number | undefined;
  ms: number;
  reason?: string | undefined;
  note?: string | undefined;
  /** Absent in records written before the field existed, and means `behavior`. */
  kind?: MutantKind | undefined;
};

export type MutationRecord = {
  schemaVersion: 1;
  worktree: string;
  command: string;
  baseline: { exitCode: number; ms: number; timedOut?: boolean | undefined; cwd?: string | undefined; tail?: string | undefined };
  mutants: MutantResult[];
  totals: Record<MutantStatus, number>;
  /** The most candidates this pass was allowed to run; absent when the pass ran with no cap. */
  cap?: number | undefined;
  /** Candidates the pass was given but did not run (they stay pending). Present only when a cap was set. */
  not_reached?: number | undefined;
  /** True when mutants ran with `--bail` (the baseline never does); absent when the command was left as given. */
  bail?: true | undefined;
  /** ISO time the pass started. The fields below are absent in records written before they existed. */
  startedAt?: string | undefined;
  /** Commit of the reviewed worktree; absent outside a git checkout. */
  head?: string | undefined;
  /** sha256 of the uncommitted state (tracked diff plus untracked, non-ignored files, review packages excluded); see `worktreeProvenance` for what it does not cover. Absent outside the root of a git checkout, when git fails, or when a size or time limit is hit. */
  treeHash?: string | undefined;
  /** os.loadavg() at the start of the pass, before the provenance step and the copy: 1, 5 and 15 minutes. */
  loadavg?: [number, number, number] | undefined;
  /** Time spent reading the git state of the worktree (head and treeHash). */
  provenanceMs?: number | undefined;
  /** Time spent copying the worktree to scratch. */
  copyMs?: number | undefined;
  /** Sum of the mutant rows' `ms`. */
  mutantsMs?: number | undefined;
  /** Scratch directories of dead or abandoned earlier passes removed before this one; absent when none were. */
  sweptScratch?: number | undefined;
  /** Time spent sweeping them; present exactly when `sweptScratch` is. */
  sweepMs?: number | undefined;
};

export const MUTANTS_SPEC = "mutants.json";
export const EVIDENCE_DIR = "research-evidence";

const SKIP_COPY = new Set([".git", "node_modules"]);

/** Where the scratch copy goes by default, relative to the repository root. It is git-ignored and never copied into itself. */
export const SCRATCH_DIR = path.join(".metaproject", "data", "review", "mutate-scratch");
export type ScratchMode = "repo" | "tmp";
export const SCRATCH_MODES: readonly ScratchMode[] = ["repo", "tmp"];
/** How long a scratch directory with no readable owner marker may sit before a later pass treats it as abandoned. */
export const STALE_SCRATCH_MS = 6 * 60 * 60 * 1000;
/** How often a running pass touches its owner marker, so a sweep can tell a live pass from a dead one without trusting a pid. */
export const HEARTBEAT_MS = 60_000;
/** A marker nobody has touched for this long is abandoned whatever its pid says (a reused pid, or another PID namespace). */
export const STALE_HEARTBEAT_MS = 10 * 60_000;
const OWNER_FILE = "owner.json";
/** The prefix of every scratch directory a pass makes (`mkdtemp(<base>/<prefix>)`). */
const SCRATCH_PREFIX = "keryx-mutate-";
/** What `mkdtemp` makes from {@link SCRATCH_PREFIX}; any other name in the scratch base is not ours to remove. */
const SCRATCH_NAME = new RegExp(`^${SCRATCH_PREFIX}[A-Za-z0-9]{6}$`);
/** An owner marker is a few dozen bytes; a larger file is not ours. */
const OWNER_MAX_BYTES = 4096;
const BASELINE_TAIL_LINES = 60;
const OUTPUT_KEEP_CHARS = 256 * 1024;

/** The last `lines` lines of `text`, without trailing blank lines. */
export function tailLines(text: string, lines = BASELINE_TAIL_LINES): string {
  return text.replace(/\s+$/, "").split(/\r?\n/).slice(-lines).join("\n");
}

/** A red or timed-out baseline. Carries the evidence record so the caller can persist the tail before failing. */
export class BaselineError extends Error {
  constructor(
    message: string,
    readonly record: MutationRecord,
  ) {
    super(message);
    this.name = "BaselineError";
  }
}

export function parseMutantSpec(raw: unknown): MutantSpec[] {
  const list = Array.isArray(raw) ? raw : (raw as { mutants?: unknown } | undefined)?.mutants;
  if (!Array.isArray(list) || list.length === 0) throw new Error("mutant spec needs a non-empty mutants array");
  const ids = new Set<string>();
  return list.map((entry, index) => {
    const m = entry as Record<string, unknown>;
    for (const key of ["id", "file", "anchor", "replacement"] as const)
      if (typeof m?.[key] !== "string" || (key !== "replacement" && (m[key] as string).length === 0)) throw new Error(`mutant #${index + 1}: "${key}" must be a string${key === "replacement" ? "" : " and not empty"}`);
    const id = m.id as string;
    if (ids.has(id)) throw new Error(`mutant id "${id}" appears twice`);
    ids.add(id);
    if (m.anchor === m.replacement) throw new Error(`mutant ${id}: replacement equals the anchor, so nothing changes`);
    if (m.kind !== undefined && !MUTANT_KINDS.includes(m.kind as MutantKind)) throw new Error(`mutant ${id}: "kind" must be one of ${MUTANT_KINDS.join(", ")}`);
    return {
      id,
      file: m.file as string,
      anchor: m.anchor as string,
      replacement: m.replacement as string,
      note: typeof m.note === "string" ? m.note : undefined,
      ...(m.kind === undefined ? {} : { kind: m.kind as MutantKind }),
    };
  });
}

const BAIL_SAFE = /^[A-Za-z0-9_./:=,@+% -]+$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * `command` with `--bail` right after `bun test`, or undefined when it is not certainly a plain
 * `[env] [NAME=value ...] bun test <tokens>` or already has the flag. A command it cannot read runs as given.
 */
export function withBail(command: string): string | undefined {
  if (!BAIL_SAFE.test(command)) return undefined;
  const tokens = command.split(" ").filter((token) => token !== "");
  let at = tokens[0] === "env" ? 1 : 0;
  while (at < tokens.length && ENV_ASSIGNMENT.test(tokens[at]!)) at += 1;
  if (tokens[at] !== "bun" || tokens[at + 1] !== "test") return undefined;
  const rest = tokens.slice(at + 2);
  if (rest.some((token) => token === "--bail" || token.startsWith("--bail=") || token === "--watch" || token === "--hot")) return undefined;
  return [...tokens.slice(0, at + 2), "--bail", ...rest].join(" ");
}

/** Process groups of the test commands running now; a signal kills them before the scratch copy goes. */
const liveGroups = new Set<number>();

function killLiveGroups(): void {
  for (const pgid of liveGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  liveGroups.clear();
}

/** The environment a test run gets: git cannot be pointed at another repository, so the ceiling holds. */
function runEnv(scratchBase: string): NodeJS.ProcessEnv {
  return { ...withoutGitDiscoveryOverrides(process.env), GIT_CEILING_DIRECTORIES: [scratchBase, process.env.GIT_CEILING_DIRECTORIES].filter((value) => value !== undefined && value !== "").join(path.delimiter) };
}

function runCommand(command: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<{ exitCode: number; timedOut: boolean; ms: number; output: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { cwd, env, shell: true, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const group = child.pid;
    if (group !== undefined) liveGroups.add(group);
    // stdout and stderr are interleaved in arrival order; only the end is kept, so a chatty suite cannot grow memory without bound.
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > OUTPUT_KEEP_CHARS) output = output.slice(-OUTPUT_KEEP_CHARS);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (group !== undefined) liveGroups.delete(group);
      resolve({ exitCode: code ?? 1, timedOut, ms: Date.now() - started, output });
    });
    child.on("error", () => {
      clearTimeout(timer);
      if (group !== undefined) liveGroups.delete(group);
      resolve({ exitCode: 127, timedOut, ms: Date.now() - started, output });
    });
  });
}

function insideRoot(root: string, file: string): string | undefined {
  const resolved = path.resolve(root, file);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : undefined;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * True when `dir` is a linked git worktree (`git worktree add`): the one kind of nested checkout the copy leaves out.
 * It is a second working copy of a repository, often with hundreds of thousands of files, and not part of the tree
 * under review. Everything else is copied as the base copy did, because the tests may load it: a submodule (listed in
 * `submodules`, or a `.git` file pointing under `.git/modules`), an embedded clone (a `.git` directory), a `.git`
 * link, and a `.git` that cannot be read or has no `gitdir:` line.
 * A `.git` file is a linked worktree's when the admin directory it names holds a `commondir` file (git's own marker,
 * the one `harness/process/sandbox/git-protect.ts` uses), or when the path it names ends in `.git/worktrees/<name>`;
 * a `modules` segment before that decides nothing.
 */
async function isLinkedWorktree(dir: string, submodules: ReadonlySet<string>): Promise<boolean> {
  if (submodules.has(dir)) return false;
  const dotGit = path.join(dir, ".git");
  let value: string;
  try {
    if (!(await lstat(dotGit)).isFile()) return false;
    const match = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"));
    if (match === null) return false;
    value = match[1]!.trim();
  } catch {
    return false;
  }
  try {
    if ((await lstat(path.join(path.resolve(dir, value), "commondir"))).isFile()) return true;
  } catch {
    /* no such marker: fall back to the shape of the path */
  }
  // A worktree's admin directory is exactly `<…>/.git/worktrees/<name>`; a submodule of a linked worktree lives deeper,
  // at `<…>/.git/worktrees/<name>/modules/<sub>`, and is copied.
  const segments = value.split(/[\\/]+/).filter((segment) => segment !== "");
  const at = segments.lastIndexOf(".git");
  return at >= 0 && segments.length === at + 3 && segments[at + 1] === "worktrees";
}

/** Every `path = <value>` of a `.gitmodules` file, with one pair of surrounding double quotes removed. */
function submodulePaths(gitmodules: string): string[] {
  const found: string[] = [];
  for (const match of gitmodules.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) found.push(match[1]!.replace(/^"(.*)"$/, "$1"));
  return found;
}

/**
 * Copies the tree entry by entry instead of with one `cp`: the scratch directory can sit inside the
 * tree being copied, and `cp` refuses a destination under its own source. `skip` holds absolute paths
 * (the scratch directories) that are left out. Linked worktrees (`.claude/worktrees/*`, `.worktrees/*`) are left out
 * too, see {@link isLinkedWorktree}; a directory a `.gitmodules` file of the walk names is a submodule and is copied.
 * Returns the linked worktrees it left out, relative to `source`, in walk order.
 */
async function copyTree(source: string, target: string, skip: ReadonlySet<string>): Promise<string[]> {
  const skipped: string[] = [];
  const submodules = new Set<string>();
  const walk = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true });
    const entries = await readdir(from, { withFileTypes: true });
    if (entries.some((entry) => entry.name === ".gitmodules" && entry.isFile())) {
      try {
        for (const value of submodulePaths(await readFile(path.join(from, ".gitmodules"), "utf8"))) submodules.add(path.resolve(from, value));
      } catch {
        /* an unreadable .gitmodules names nothing */
      }
    }
    for (const entry of entries) {
      const entryPath = path.join(from, entry.name);
      if (SKIP_COPY.has(entry.name) || skip.has(entryPath)) continue;
      if (entry.isDirectory()) {
        if (await isLinkedWorktree(entryPath, submodules)) {
          skipped.push(path.relative(source, entryPath));
          continue;
        }
        await walk(entryPath, path.join(to, entry.name));
      }
      else await cp(entryPath, path.join(to, entry.name));
    }
  };
  await walk(source, target);
  const modules = path.join(source, "node_modules");
  if (existsSync(modules)) await symlink(modules, path.join(target, "node_modules"), "dir");
  return skipped;
}

/**
 * Whether `pid` is a live process. Not `processIsAlive` from `lib/fs.ts`: this one is for a decision to delete, the
 * irreversible direction, so any error but ESRCH keeps the directory (EPERM means the process exists under another user).
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * The owner marker of a scratch directory: its pid and when it was last touched. Opened without following a link and
 * without blocking (a FIFO named `owner.json` must not stall a sweep), read only when it is a small regular file. Any
 * failure, a bad shape or a pid that is not a positive integer means the directory has no marker.
 */
async function readOwner(dir: string): Promise<{ pid: number; mtimeMs: number } | undefined> {
  let handle;
  try {
    handle = await open(path.join(dir, OWNER_FILE), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > OWNER_MAX_BYTES) return undefined;
    const owner = JSON.parse(await handle.readFile("utf8")) as { pid?: unknown };
    return typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0 ? { pid: owner.pid, mtimeMs: info.mtimeMs } : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Removes scratch directories that earlier passes left behind: a pass killed with SIGKILL or a crash never reaches its
 * cleanup. Only the operator's own `keryx-mutate-XXXXXX` directories are looked at (a real directory, owned by `uid`
 * when the platform has one). A running pass touches its owner marker every {@link HEARTBEAT_MS}. A directory with a
 * marker goes when the marker is older than `staleHeartbeatMs` ({@link STALE_HEARTBEAT_MS}) whatever its pid says, or
 * when its pid is not alive and the marker is older than two heartbeats (a sweep in another PID namespace cannot see a
 * live pass's pid, but it does see that pass's fresh marker). A directory with no usable marker goes when it is older
 * than `staleMs`. Best effort: it returns how many it removed and never throws.
 */
export async function sweepStaleScratch(
  scratchBase: string,
  options: {
    now?: (() => number) | undefined;
    staleMs?: number | undefined;
    isAlive?: ((pid: number) => boolean) | undefined;
    uid?: number | undefined;
    heartbeatMs?: number | undefined;
    staleHeartbeatMs?: number | undefined;
  } = {},
): Promise<number> {
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? STALE_SCRATCH_MS;
  const isAlive = options.isAlive ?? pidAlive;
  const uid = options.uid ?? process.getuid?.();
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const staleHeartbeatMs = options.staleHeartbeatMs ?? STALE_HEARTBEAT_MS;
  let removed = 0;
  try {
    for (const entry of await readdir(scratchBase, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SCRATCH_NAME.test(entry.name)) continue;
      const dir = path.join(scratchBase, entry.name);
      try {
        const info = await lstat(dir);
        if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) continue;
        const owner = await readOwner(dir);
        const abandoned =
          owner === undefined
            ? now() - info.mtimeMs > staleMs
            : now() - owner.mtimeMs > staleHeartbeatMs || (!isAlive(owner.pid) && now() - owner.mtimeMs > 2 * heartbeatMs);
        if (!abandoned) continue;
        await rm(dir, { recursive: true, force: true });
        removed += 1;
      } catch {
        /* one unreadable entry must not stop the sweep */
      }
    }
  } catch {
    /* no scratch base yet, or it is unreadable: nothing to sweep */
  }
  return removed;
}

const SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/** Runs `body`; on SIGINT or SIGTERM `cleanup` runs first and the signal is re-raised so the process still dies by it. */
export async function withScratchSignalCleanup<T>(cleanup: () => Promise<void>, body: () => Promise<T>): Promise<T> {
  const onSignal = (signal: NodeJS.Signals): void => {
    for (const name of SIGNALS) process.off(name, onSignal);
    void cleanup().catch(() => {}).finally(() => process.kill(process.pid, signal));
  };
  for (const name of SIGNALS) process.on(name, onSignal);
  try {
    return await body();
  } finally {
    for (const name of SIGNALS) process.off(name, onSignal);
  }
}

/**
 * Runs each mutant in a scratch copy of the worktree; the worktree itself is never written.
 * The baseline must pass first: against a red baseline every mutant would read as killed.
 */
export async function runMutation(options: {
  worktree: string;
  command: string;
  mutants: readonly MutantSpec[];
  timeoutMs?: number | undefined;
  /** Explicit directory to make the scratch copy in; wins over `scratch`. */
  scratchRoot?: string | undefined;
  /** `repo` (default) puts the copy under `<worktree>/.metaproject/data/review/mutate-scratch` so ancestor node_modules still resolve; `tmp` uses the OS temp dir. */
  scratch?: ScratchMode | undefined;
  /** Run at most this many candidates; the rest, and any that came out invalid, are counted in `not_reached` and stay pending. */
  cap?: number | undefined;
  /** Run each mutant with `--bail` when the command allows it (default true); the baseline always runs in full. */
  bail?: boolean | undefined;
  /** How often the pass touches its owner marker; defaults to {@link HEARTBEAT_MS}. */
  heartbeatMs?: number | undefined;
}): Promise<MutationRecord> {
  const worktree = path.resolve(options.worktree);
  const startedAt = new Date().toISOString();
  // Sampled before the pass's own test runs, so it shows the load that was there already.
  const load = loadavg() as [number, number, number];
  // Before the scratch directory exists, so the hash describes the tree the caller handed in.
  const provenanceStarted = Date.now();
  const provenance = await worktreeProvenance(worktree);
  const provenanceMs = Date.now() - provenanceStarted;
  const passFields = { startedAt, ...provenance, loadavg: load, provenanceMs };
  const timeoutMs = options.timeoutMs ?? 300_000;
  const scratchBase = options.scratchRoot !== undefined ? path.resolve(options.scratchRoot) : options.scratch === "tmp" ? tmpdir() : path.join(worktree, SCRATCH_DIR);
  // The repository's own scratch is never copied (a pass with `--scratch tmp` would otherwise copy the dead passes' trees
  // it holds) and is swept too when the copy goes elsewhere.
  const repoScratch = path.join(worktree, SCRATCH_DIR);
  await mkdir(scratchBase, { recursive: true });
  const sweepStarted = Date.now();
  let sweptScratch = await sweepStaleScratch(scratchBase);
  if (scratchBase !== repoScratch) sweptScratch += await sweepStaleScratch(repoScratch);
  const sweepMs = Date.now() - sweepStarted;
  const sweepFields = sweptScratch > 0 ? { sweptScratch, sweepMs } : {};
  const scratch = await mkdtemp(path.join(scratchBase, SCRATCH_PREFIX));
  // Beside the copy, never inside it, so a later pass can tell a live owner from a dead one.
  const ownerFile = path.join(scratch, OWNER_FILE);
  await writeFile(ownerFile, JSON.stringify({ pid: process.pid, startedAt }));
  // Touched while the pass runs: a sweep reads a marker that stopped being touched as abandoned.
  const heartbeat = setInterval(() => {
    const at = new Date();
    void utimes(ownerFile, at, at).catch(() => {});
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();
  // The copy has no .git; without a ceiling a git command run by the tests would walk up into the real repository.
  const env = runEnv(scratchBase);
  return withScratchSignalCleanup(async () => { clearInterval(heartbeat); killLiveGroups(); await rm(scratch, { recursive: true, force: true }); }, async () => {
  try {
    const copy = path.join(scratch, "tree");
    const copyStarted = Date.now();
    const leftOut = await copyTree(worktree, copy, new Set([scratchBase, repoScratch, scratch]));
    const copyMs = Date.now() - copyStarted;
    const baseline = await runCommand(options.command, copy, timeoutMs, env);
    if (baseline.exitCode !== 0 || baseline.timedOut) {
      const tail = tailLines(baseline.output);
      const what = baseline.timedOut ? `timed out after ${timeoutMs} ms` : `exited ${baseline.exitCode}`;
      const message = [
        `the baseline run of \`${options.command}\` ${what} on an unmodified copy; mutants would all read as killed, so none were run`,
        `baseline command: ${options.command}`,
        `baseline cwd: ${copy}`,
        `last ${BASELINE_TAIL_LINES} lines of output:`,
        tail === "" ? "(no output)" : tail,
        ...(leftOut.length === 0 ? [] : [`the copy left out ${leftOut.length} linked worktree(s) (first: ${leftOut[0]})`]),
      ].join("\n");
      throw new BaselineError(message, {
        schemaVersion: 1,
        worktree,
        command: options.command,
        baseline: { exitCode: baseline.exitCode, ms: baseline.ms, timedOut: baseline.timedOut, cwd: copy, tail },
        mutants: [],
        totals: { killed: 0, survived: 0, invalid: 0, timeout: 0 },
        ...passFields,
        copyMs,
        ...sweepFields,
      });
    }

    const bailCommand = options.bail === false ? undefined : withBail(options.command);
    const mutantCommand = bailCommand ?? options.command;
    const results: MutantResult[] = [];
    const cap = options.cap === undefined ? undefined : Math.max(0, Math.floor(options.cap));
    // The cap bounds the mutants that actually run. An invalid candidate costs nothing and stays pending
    // (see `pendingMutants`), so it neither uses up the cap nor counts as reached.
    let ran = 0;
    for (const mutant of options.mutants) {
      if (cap !== undefined && ran >= cap) break;
      const base = { id: mutant.id, file: mutant.file, anchor: mutant.anchor, replacement: mutant.replacement, note: mutant.note, command: mutantCommand, ...(mutant.kind === undefined ? {} : { kind: mutant.kind }) };
      const target = insideRoot(copy, mutant.file);
      if (target === undefined || !existsSync(target)) {
        results.push({ ...base, status: "invalid", ms: 0, reason: target === undefined ? "file is outside the worktree" : "file does not exist in the worktree" });
        continue;
      }
      if (insideRoot(await realpath(copy), await realpath(target)) === undefined) {
        results.push({ ...base, status: "invalid", ms: 0, reason: "file resolves through a link to outside the scratch copy" });
        continue;
      }
      const original = await readFile(target, "utf8");
      const first = original.indexOf(mutant.anchor);
      if (first === -1 || original.indexOf(mutant.anchor, first + 1) !== -1) {
        results.push({ ...base, status: "invalid", ms: 0, reason: first === -1 ? "anchor not found" : "anchor occurs more than once; make it exact" });
        continue;
      }
      await writeFile(target, original.slice(0, first) + mutant.replacement + original.slice(first + mutant.anchor.length), "utf8");
      ran += 1;
      try {
        const run = await runCommand(mutantCommand, copy, timeoutMs, env);
        results.push({ ...base, line: lineOf(original, first), status: run.timedOut ? "timeout" : run.exitCode === 0 ? "survived" : "killed", exitCode: run.exitCode, ms: run.ms });
      } finally {
        await writeFile(target, original, "utf8");
      }
    }
    const totals: Record<MutantStatus, number> = { killed: 0, survived: 0, invalid: 0, timeout: 0 };
    for (const r of results) totals[r.status] += 1;
    return {
      schemaVersion: 1,
      worktree,
      command: options.command,
      baseline: { exitCode: baseline.exitCode, ms: baseline.ms },
      mutants: results,
      totals,
      ...(cap === undefined ? {} : { cap, not_reached: options.mutants.length - ran }),
      ...(bailCommand === undefined ? {} : { bail: true as const }),
      ...passFields,
      copyMs,
      mutantsMs: results.reduce((sum, r) => sum + r.ms, 0),
      ...sweepFields,
    };
  } finally {
    clearInterval(heartbeat);
    await rm(scratch, { recursive: true, force: true });
  }
  });
}

function costLine(record: MutationRecord): string[] {
  const parts: string[] = [];
  if (record.provenanceMs !== undefined) parts.push(`provenance ${record.provenanceMs} ms`);
  if (record.copyMs !== undefined) parts.push(`copy ${record.copyMs} ms`);
  if (record.mutantsMs !== undefined) parts.push(`mutants ${record.mutantsMs} ms`);
  if (record.loadavg !== undefined) parts.push(`load ${record.loadavg.map((n) => n.toFixed(1)).join("/")}`);
  return parts.length === 0 ? [] : [`Cost: ${parts.join(", ")}.`, ""];
}

function provenanceLine(record: MutationRecord): string[] {
  const parts: string[] = [];
  if (record.startedAt !== undefined) parts.push(`started ${record.startedAt}`);
  if (record.head !== undefined) parts.push(`head ${record.head.slice(0, 12)}`);
  if (record.treeHash !== undefined) parts.push(`treeHash ${record.treeHash.slice(0, 12)}`);
  return parts.length === 0 ? [] : [`${parts.join(", ")}.`, ""];
}

export function renderMutationTable(record: MutationRecord): string {
  // A backtick would end a code span early and cannot be escaped inside one, so it becomes a quote.
  const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/[\r\n]/g, " ").replace(/`/g, "'");
  const code = (value: string) => `\`${cell(value)}\``;
  const columns: { header: string; render: (m: MutantResult) => string }[] = [
    { header: "Mutant", render: (m) => cell(m.id) },
    { header: "Where", render: (m) => `${cell(m.file)}${m.line === undefined ? "" : `:${m.line}`}` },
    { header: "Change", render: (m) => `${code(m.anchor)} → ${code(m.replacement)}` },
    { header: "Result", render: (m) => `${m.status}${m.reason ? ` (${cell(m.reason)})` : ""}${m.kind === "presentation" ? " [presentation]" : ""}` },
    { header: "Test command", render: (m) => code(m.command ?? record.command) },
    { header: "Exit", render: (m) => String(m.exitCode ?? "-") },
  ];
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const rows = record.mutants.map((m) => line(columns.map((c) => c.render(m))));
  const t = record.totals;
  return [
    `# Mutation pass`,
    "",
    `Command: \`${record.command}\` (baseline exit ${record.baseline.exitCode}, ${record.baseline.ms} ms). Run in a scratch copy; the worktree was not written.`,
    "",
    ...(record.bail === true ? ["Bail: applied (mutants ran with --bail; baseline in full).", ""] : []),
    ...(record.sweptScratch !== undefined && record.sweptScratch > 0
      ? [`Swept: ${record.sweptScratch} scratch ${record.sweptScratch === 1 ? "copy" : "copies"} left by dead passes${record.sweepMs === undefined ? "" : ` (${record.sweepMs} ms)`}.`, ""]
      : []),
    ...costLine(record),
    ...provenanceLine(record),
    ...(record.baseline.tail === undefined
      ? []
      : [`Baseline ${record.baseline.timedOut ? "timed out" : `failed (exit ${record.baseline.exitCode})`}; no mutant ran. cwd: \`${record.baseline.cwd ?? "-"}\`. Last output:`, "", "```", record.baseline.tail.replace(/```/g, "'"), "```", ""]),
    `Killed ${t.killed}, survived ${t.survived}, timeout ${t.timeout}, invalid ${t.invalid}.`,
    "",
    line(columns.map((c) => c.header)),
    `|${columns.map(() => "---|").join("")}`,
    ...rows,
    "",
    ...(record.not_reached !== undefined && record.not_reached > 0 ? [`Not run: ${record.not_reached} candidates${record.cap === undefined ? "" : ` (cap ${record.cap})`}. They stay pending and block the coverage gate until a pass runs them.`, ""] : []),
    t.survived > 0 ? "A survivor means no assertion pins that behaviour: the severity audit raises a finding to major only when no mutant in the same file was killed." : "No survivor.",
    "",
  ].join("\n");
}

/**
 * Writes `mutation-<n>.json` and `.md` into `<package>/research-evidence/`. A record whose baseline failed
 * (it carries the output tail) goes under `mutation-baseline-<n>` instead, so nothing that counts mutation
 * passes by the `mutation` prefix reads a run that judged no mutant as a pass.
 */
export async function writeMutationEvidence(packageDir: string, record: MutationRecord): Promise<{ json: string; md: string }> {
  const dir = path.join(packageDir, EVIDENCE_DIR);
  await mkdir(dir, { recursive: true });
  const baseline = record.baseline.tail !== undefined;
  const pattern = baseline ? BASELINE_RECORD_FILE : MUTATION_RECORD_FILE;
  const stem = baseline ? "mutation-baseline" : "mutation";
  const taken = (await readdir(dir)).map((n) => pattern.exec(n)?.[1]).filter((n): n is string => n !== undefined).map(Number);
  const n = (taken.length ? Math.max(...taken) : 0) + 1;
  const json = path.join(dir, `${stem}-${n}.json`);
  const md = path.join(dir, `${stem}-${n}.md`);
  await writeFile(json, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await writeFile(md, renderMutationTable(record), "utf8");
  return { json, md };
}

/** A recorded mutation pass, `mutation-<n>.json`; the number is captured. A baseline-failed record does not match. */
const MUTATION_RECORD_FILE = /^mutation-(\d+)\.json$/;
/** A record whose baseline failed, `mutation-baseline-<n>.json`: it judged no mutant. */
const BASELINE_RECORD_FILE = /^mutation-baseline-(\d+)\.json$/;

/** The names of the package's recorded mutation passes in `research-evidence/`; [] when there is none. */
async function mutationRecordNames(packageDir: string): Promise<string[]> {
  const dir = path.join(packageDir, EVIDENCE_DIR);
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((n) => MUTATION_RECORD_FILE.test(n));
}

/** Whether the package holds a recorded mutation pass (`research-evidence/mutation-<n>.json`); a baseline-failed record does not count. */
export async function packageHasMutationRecord(packageDir: string): Promise<boolean> {
  return (await mutationRecordNames(packageDir)).length > 0;
}

/** Ids of the mutants a recorded pass has judged. An invalid row judged nothing, so it does not count. */
export async function doneMutantIds(packageDir: string): Promise<Set<string>> {
  const dir = path.join(packageDir, EVIDENCE_DIR);
  const done = new Set<string>();
  for (const name of await mutationRecordNames(packageDir)) {
    try {
      const record = JSON.parse(await readFile(path.join(dir, name), "utf8")) as MutationRecord;
      for (const m of record.mutants) if (m.status !== "invalid") done.add(m.id);
    } catch {
      continue;
    }
  }
  return done;
}

/** The given specs minus those a recorded pass in this package has already judged, in their original order. */
export async function unjudgedMutants(packageDir: string, specs: MutantSpec[]): Promise<MutantSpec[]> {
  const done = await doneMutantIds(packageDir);
  return specs.filter((s) => !done.has(s.id));
}

/** Mutants the reviewers proposed (`research-evidence/mutants.json`) that no recorded mutation pass has run yet. A spec with `"runnable": false` says the tests cannot be run here, so nothing is pending. */
export async function pendingMutants(packageDir: string): Promise<MutantSpec[]> {
  const dir = path.join(packageDir, EVIDENCE_DIR);
  const specFile = path.join(dir, MUTANTS_SPEC);
  if (!existsSync(specFile)) return [];
  let specs: MutantSpec[];
  try {
    const raw: unknown = JSON.parse(await readFile(specFile, "utf8"));
    if ((raw as { runnable?: unknown } | null)?.runnable === false) return [];
    specs = parseMutantSpec(raw);
  } catch {
    return [];
  }
  return unjudgedMutants(packageDir, specs);
}

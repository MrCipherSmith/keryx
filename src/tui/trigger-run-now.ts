// Flow 300 T7 (AC6): run-now from the TUI is `keryx trigger run <name>` in a
// child process — and nothing else.
//
// Why a child process, not `runTriggerOnce` in this one: `keryx trigger run`
// prints with console.log/error, sets `process.exitCode`, runs `sync --apply` /
// `gdgraph build` in-process under the maintenance lock, and a dispatching
// `flow-next` drives an unattended agent for up to `maxSeconds`. In the TUI's
// process that would write behind the renderer, change the shell's own exit
// code, and tie a half-hour run to the shell. A child running the CLI itself is
// bound by exactly the CLI's locks, budgets, reservations, refusals and
// unattended floor, by construction — there is no second code path to keep
// equivalent.
//
// Which binary: `resolveKeryxInvocation()` — the interpreter and entry script
// of THIS process (or, for a compiled binary, the binary alone) — never `keryx`
// on PATH, which can be an older build than the shell the operator is looking at.
//
// Review F4: the child outlives the shell. It is spawned DETACHED, in its own
// process group, with stdout+stderr going to ITS OWN log file,
// `.metaproject/data/trigger/run-now/<name>-<startedAt>.log` (review N3; the
// newest RUN_NOW_LOGS_KEPT per trigger are kept, review N2), in a directory
// that ignores itself. The log is opened without following symlinks and only
// under a symlink-free directory chain (review N1). Quitting the TUI never
// signals it: `keryx trigger run` has no SIGTERM handler, so a killed dispatch
// would leak its spend reservation, an open task attempt, its worktree and its
// own children. The run finishes and writes its own closing record; the ledger
// watcher shows it on the next start. Single-flight per name holds within one
// shell (`run` returns `undefined`); across a restart the CLI's own locks
// refuse a second concurrent run (`lock-refused`, or `dispatch-refused` with
// `dispatch-locked` for a dispatching `flow-next`).
//
// Review F5: the child's environment drops every `KERYX_SESSION_*` key. The
// shell exports its own provider/model there for tools it runs; a trigger run
// is not this session and must not inherit its identity.
//
// Never a JobRegistry task: a finished JobRegistry task becomes a
// task-notification that starts an agent turn (flow 265).

import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { triggerDataDir } from "../trigger/record";
import { invocationArgv, resolveKeryxInvocation, type KeryxInvocation } from "../trigger/schedule";

export interface TriggerRunNowResult {
  readonly name: string;
  readonly argv: readonly string[];
  readonly exitCode: number;
  /** The tail of what THIS run wrote to its log (at most `OUTPUT_TAIL_CHARS`). */
  readonly output: string;
  readonly logPath: string;
  /** Set when run-now refused to start at all (an unsafe log location): nothing was spawned. */
  readonly refusal?: string;
  readonly startedAt: string;
  readonly endedAt: string;
}

export const OUTPUT_TAIL_CHARS = 4000;

/** The spawn options run-now always uses — detached, own group, output to the log fd. */
export interface RunNowSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly detached: true;
  readonly stdio: readonly ["ignore", number, number];
}

/** The minimal child-process surface this module uses (injectable for tests). */
export interface RunNowChild {
  on(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", cb: (error: Error) => void): unknown;
  unref(): void;
}

export type RunNowSpawn = (command: string, args: readonly string[], options: RunNowSpawnOptions) => RunNowChild;

const defaultSpawn: RunNowSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], { cwd: options.cwd, env: options.env, detached: true, stdio: [...options.stdio] });

/** The exact argv run-now executes for `name`. */
export function triggerRunArgv(name: string, invocation: KeryxInvocation = resolveKeryxInvocation()): string[] {
  return [...invocationArgv(invocation), "trigger", "run", name];
}

/** The environment a run-now child gets: this one, minus every `KERYX_SESSION_*` key. */
export function runNowChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("KERYX_SESSION_")) out[key] = value;
  }
  return out;
}

/** `.metaproject/data/trigger/run-now/` — ignores itself. */
export function runNowLogDir(root: string): string {
  return path.join(triggerDataDir(root), "run-now");
}

/** Per-run log files kept per trigger; older ones are pruned when a run starts (review N2). */
export const RUN_NOW_LOGS_KEPT = 5;

/** At most this many bytes are read back for the tail (review N2) — never the whole file. */
export const OUTPUT_TAIL_BYTES = 16 * 1024;

function stampOf(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

/**
 * One log file PER RUN (review N3): `<name>-<startedAt>.log`. A run's tail can
 * then never include lines an older, detached run is still appending to its
 * own file after a restart.
 */
export function runNowLogPath(root: string, name: string, startedAt: string): string {
  return path.join(runNowLogDir(root), `${name}-${stampOf(startedAt)}.log`);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/**
 * Make `.metaproject/data/trigger/run-now/` exist WITHOUT following a symlink
 * anywhere from `.metaproject/data/trigger` down (review N1). That directory is
 * not gitignored, so a cloned repository can ship `trigger/run-now` — or the
 * log file itself — as a symlink to `~/.bashrc` or `authorized_keys`; appending
 * run output through it would write repo-controlled text outside the project.
 * Every segment is `lstat`ed: a symlink, or anything that is not a directory,
 * refuses. Returns the directory, or the refusal reason.
 */
export function prepareRunNowLogDir(root: string): { ok: true; dir: string } | { ok: false; reason: string } {
  mkdirSync(path.join(root, ".metaproject", "data"), { recursive: true });
  for (const segment of [triggerDataDir(root), runNowLogDir(root)]) {
    let info;
    try {
      info = lstatSync(segment);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
      mkdirSync(segment); // not recursive: the parent was just checked
      info = lstatSync(segment);
    }
    if (info.isSymbolicLink()) {
      return { ok: false, reason: `${segment} is a symbolic link — refusing to write run-now output through it` };
    }
    if (!info.isDirectory()) return { ok: false, reason: `${segment} is not a directory — refusing to write run-now output there` };
  }
  const dir = runNowLogDir(root);
  try {
    const fd = openSync(
      path.join(dir, ".gitignore"),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o644,
    );
    try {
      writeSync(fd, "# keryx run-now logs — never commit\n*\n");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
  }
  return { ok: true, dir };
}

/**
 * Open a fresh per-run log: `O_WRONLY|O_APPEND|O_CREAT|O_EXCL|O_NOFOLLOW` —
 * never through a symlink, never onto a file someone placed there first — and
 * confirm by `fstat` that what was opened is a regular file.
 */
function openRunLog(file: string): { ok: true; fd: number } | { ok: false; reason: string } {
  let fd: number;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (isCode(error, "EEXIST") || isCode(error, "ELOOP")) {
      return { ok: false, reason: `${file} already exists (or is a symbolic link) — refusing to write run-now output there` };
    }
    throw error;
  }
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    return { ok: false, reason: `${file} is not a regular file — refusing to write run-now output there` };
  }
  return { ok: true, fd };
}

/** Delete all but the newest `keep` per-run logs of `name` (the file being written is always the newest). */
function pruneRunLogs(dir: string, name: string, keep: number): void {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}-\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z\\.log$`);
  let names: string[];
  try {
    names = readdirSync(dir).filter((entry) => pattern.test(entry)).sort();
  } catch {
    return;
  }
  for (const old of names.slice(0, Math.max(0, names.length - keep))) {
    try {
      unlinkSync(path.join(dir, old)); // unlinks a symlink itself, never its target
    } catch {
      // already gone
    }
  }
}

/** The tail of `fd`'s file from `offset`, reading at most `OUTPUT_TAIL_BYTES` (review N2). */
function readTail(file: string, offset: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const size = fstatSync(fd).size;
    const start = Math.max(offset, size - OUTPUT_TAIL_BYTES);
    const length = Math.max(0, size - start);
    const buffer = Buffer.alloc(length);
    const read = length === 0 ? 0 : readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString("utf8").slice(-OUTPUT_TAIL_CHARS);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface InFlightRun {
  readonly name: string;
  readonly logPath: string;
}

export interface TriggerRunNow {
  /** Start `name`. `undefined` when that trigger is already running from this shell. */
  run(name: string): Promise<TriggerRunNowResult> | undefined;
  /** Names with a child in flight. */
  running(): ReadonlySet<string>;
  /** The runs in flight RIGHT NOW, with their logs — read live, never cached (review N6). */
  inFlightRuns(): readonly InFlightRun[];
  /**
   * Shell exit: NEVER signal a child. Returns the runs still in flight so the
   * shell can say they continue in the background and where their log is.
   */
  dispose(): readonly InFlightRun[];
}

/** The one line the shell prints on exit for runs that continue without it. */
export function describeDetachedRuns(runs: readonly InFlightRun[]): string | undefined {
  if (runs.length === 0) return undefined;
  return runs.map((r) => `keryx: trigger ${r.name} keeps running in the background — log: ${r.logPath}`).join("\n");
}

export function createTriggerRunNow(opts: {
  root: string;
  invocation?: KeryxInvocation;
  spawn?: RunNowSpawn;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}): TriggerRunNow {
  const spawn = opts.spawn ?? defaultSpawn;
  const now = opts.now ?? (() => new Date());
  const inFlight = new Map<string, InFlightRun>();
  return {
    run(name) {
      if (inFlight.has(name)) return undefined;
      const argv = triggerRunArgv(name, opts.invocation);
      const startedAt = now().toISOString();
      const logPath = runNowLogPath(opts.root, name, startedAt);
      inFlight.set(name, { name, logPath });
      return new Promise<TriggerRunNowResult>((resolve) => {
        let settled = false;
        let offset = 0;
        const finish = (exitCode: number, extra = "", refusal?: string): void => {
          if (settled) return;
          settled = true;
          inFlight.delete(name);
          resolve({
            name,
            argv,
            exitCode,
            output: `${refusal === undefined ? readTail(logPath, offset) : ""}${extra}`.slice(-OUTPUT_TAIL_CHARS),
            logPath,
            startedAt,
            endedAt: now().toISOString(),
            ...(refusal !== undefined ? { refusal } : {}),
          });
        };
        let fd: number | undefined;
        try {
          const dir = prepareRunNowLogDir(opts.root);
          if (!dir.ok) {
            finish(-1, "", dir.reason);
            return;
          }
          const opened = openRunLog(logPath);
          if (!opened.ok) {
            finish(-1, "", opened.reason);
            return;
          }
          fd = opened.fd;
          const header = `=== ${startedAt} run-now from the TUI: ${argv.slice(-3).join(" ")} ===\n`;
          writeSync(fd, header);
          offset = Buffer.byteLength(header);
          pruneRunLogs(dir.dir, name, RUN_NOW_LOGS_KEPT);
          const child = spawn(argv[0] as string, argv.slice(1), {
            cwd: opts.root,
            env: runNowChildEnv(opts.env ?? process.env),
            detached: true,
            stdio: ["ignore", fd, fd],
          });
          child.on("error", (error) => finish(127, `could not start ${argv.join(" ")}: ${error.message}\n`));
          child.on("exit", (code, signal) => finish(code ?? (signal !== null ? 128 : 1)));
          // The shell must be able to exit while the run goes on.
          child.unref();
        } catch (error) {
          finish(127, `could not start ${argv.join(" ")}: ${error instanceof Error ? error.message : String(error)}\n`);
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
      });
    },
    running: () => new Set(inFlight.keys()),
    inFlightRuns: () => [...inFlight.values()],
    dispose() {
      return [...inFlight.values()];
    },
  };
}

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
// process group, with stdout+stderr appended to a per-trigger log under the
// self-ignoring `.metaproject/data/trigger/run-now/`. Quitting the TUI never
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
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

export function runNowLogPath(root: string, name: string): string {
  return path.join(runNowLogDir(root), `${name}.log`);
}

function ensureLogDir(root: string): void {
  const dir = runNowLogDir(root);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path.join(dir, ".gitignore"), "# keryx run-now logs — never commit\n*\n", { flag: "wx" });
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function tailFrom(file: string, offset: number): string {
  try {
    return readFileSync(file).subarray(offset).toString("utf8").slice(-OUTPUT_TAIL_CHARS);
  } catch {
    return "";
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
      const logPath = runNowLogPath(opts.root, name);
      inFlight.set(name, { name, logPath });
      return new Promise<TriggerRunNowResult>((resolve) => {
        let settled = false;
        let offset = 0;
        const finish = (exitCode: number, extra = ""): void => {
          if (settled) return;
          settled = true;
          inFlight.delete(name);
          resolve({
            name,
            argv,
            exitCode,
            output: `${tailFrom(logPath, offset)}${extra}`.slice(-OUTPUT_TAIL_CHARS),
            logPath,
            startedAt,
            endedAt: now().toISOString(),
          });
        };
        let fd: number | undefined;
        try {
          ensureLogDir(opts.root);
          fd = openSync(logPath, "a");
          writeFileSync(fd, `=== ${startedAt} run-now from the TUI: ${argv.slice(-3).join(" ")} ===\n`);
          offset = sizeOf(logPath);
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
    dispose() {
      return [...inFlight.values()];
    },
  };
}

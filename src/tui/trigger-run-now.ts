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
// of THIS process — never `keryx` on PATH, which can be an older build than the
// shell the operator is looking at.
//
// Never a JobRegistry task: a finished JobRegistry task becomes a
// task-notification that starts an agent turn (flow 265).

import { spawn as nodeSpawn } from "node:child_process";
import { resolveKeryxInvocation, type KeryxInvocation } from "../trigger/schedule";

export interface TriggerRunNowResult {
  readonly name: string;
  readonly argv: readonly string[];
  readonly exitCode: number;
  /** The tail of the child's combined stdout+stderr (at most `OUTPUT_TAIL_CHARS`). */
  readonly output: string;
  readonly startedAt: string;
  readonly endedAt: string;
}

export const OUTPUT_TAIL_CHARS = 4000;

/** The minimal child-process surface this module uses (injectable for tests). */
export interface RunNowChild {
  stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "close", cb: (code: number | null) => void): unknown;
  on(event: "error", cb: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type RunNowSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => RunNowChild;

const defaultSpawn: RunNowSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });

/** The exact argv run-now executes for `name`. */
export function triggerRunArgv(name: string, invocation: KeryxInvocation = resolveKeryxInvocation()): string[] {
  return [invocation.execPath, invocation.scriptPath, "trigger", "run", name];
}

export interface TriggerRunNow {
  /** Start `name`. `undefined` when that trigger is already running from this shell. */
  run(name: string): Promise<TriggerRunNowResult> | undefined;
  /** Names with a child in flight. */
  running(): ReadonlySet<string>;
  /** SIGTERM every child still running (shell exit). */
  dispose(): void;
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
  const children = new Map<string, RunNowChild>();
  return {
    run(name) {
      if (children.has(name)) return undefined;
      const argv = triggerRunArgv(name, opts.invocation);
      const startedAt = now().toISOString();
      let output = "";
      const append = (chunk: Buffer | string): void => {
        output = (output + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
      };
      return new Promise<TriggerRunNowResult>((resolve) => {
        let child: RunNowChild;
        const finish = (exitCode: number): void => {
          children.delete(name);
          resolve({ name, argv, exitCode, output, startedAt, endedAt: now().toISOString() });
        };
        try {
          child = spawn(argv[0] as string, argv.slice(1), { cwd: opts.root, env: opts.env ?? process.env });
        } catch (error) {
          append(`could not start ${argv.join(" ")}: ${error instanceof Error ? error.message : String(error)}\n`);
          finish(127);
          return;
        }
        children.set(name, child);
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
        let settled = false;
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          append(`could not start ${argv.join(" ")}: ${error.message}\n`);
          finish(127);
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          finish(code ?? 1);
        });
      });
    },
    running: () => new Set(children.keys()),
    dispose() {
      for (const child of children.values()) {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
    },
  };
}

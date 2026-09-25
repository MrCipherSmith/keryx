// R1-01 (flow 319, review round 1, blocker): a startup guard for invocations
// that BYPASS the shebang entirely — `bun dist/cli.js`, `bun src/cli.ts`,
// `bunx keryx …`. None of those go through `#!/usr/bin/env -S bun
// --no-env-file --config=/dev/null` (`src/cli.ts`'s own shebang, and the
// identical one `bun run build` writes into `dist/cli.js`), so Bun still
// auto-loads a `.env*`/`bunfig.toml` from the CURRENT WORKING DIRECTORY —
// exactly the vector R1-01 closes for the shipped `bin`.
//
// This is defence in depth, not the fix: by the time this module's exported
// function runs, `process.env` may already carry values a cwd `.env` set,
// AND (this module cannot undo it) any `bunfig.toml` `preload` script has
// already executed — Bun runs `preload` before user code, full stop. The
// shebang is the only thing that stops `preload`; this guard only limits
// what a bypassing invocation's OWN env-derived state can go on to affect,
// by re-executing once under the safe flags with every dotenv-sourced
// variable name (and a short list of Bun's own env-based footguns) stripped
// back out.
//
// R2-01 (review round 2, major): the previous version of this guard decided
// "already safe" from an env marker (`KERYX_SAFE_EXEC=1`, which a `.env` can
// set) and gated re-exec on `.env`/`bunfig.toml` existing in `cwd` — missing
// every other dotenv filename Bun auto-loads (`.env.local`,
// `.env.development`, `.env.production`, `.env.test`, `.env.<NODE_ENV>.local`)
// and, because it only stripped a key when its OWN best-effort parser agreed
// with Bun's on what value that key would have gotten, was bypassable by any
// syntax the two parsers disagreed on (an inline `# comment`, `$VAR`/`${VAR}`
// expansion, backtick quoting, `KEY: value`). This version fixes both classes
// at the root:
//
//   - "already safe" comes from Bun itself, and ONLY from Bun itself:
//     `process.execArgv` carrying both `--no-env-file` and `--config`. No env
//     var can fake that (execArgv is a runtime property Bun computes, not a
//     process.env key), so the marker is gone.
//   - re-exec never depends on which files happen to exist in `cwd`. When
//     execArgv lacks the safe flags, this ALWAYS re-execs — the "does
//     `.env`/`bunfig.toml` exist" existence check is gone too.
//   - what gets stripped is decided by KEY NAME alone (every key name found
//     in ANY `.env*` file in `cwd`, regardless of what value it or
//     `process.env` currently holds), never by re-deriving and comparing a
//     value. There is nothing left for a parser mismatch to hide behind.
import { readFileSync } from "node:fs";
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { isCompiledBinaryEntry } from "./self-invocation";

/**
 * The two flags every site that spawns `bun <keryx entry script>` (as
 * opposed to a compiled `keryx` binary, which is not `bun` at all, or a
 * `keryx` resolved via `PATH`, which goes through the shebang) must pass
 * BEFORE the script path — same reasoning as `src/cli.ts`'s own shebang
 * (R1-01): otherwise the CHILD auto-loads a cwd `.env`/`bunfig.toml` all
 * over again, defeating the parent's own safety. Exported so every spawn
 * site shares the exact same two flags rather than a copy that could drift.
 */
export const SAFE_BUN_SPAWN_ARGS: readonly string[] = ["--no-env-file", "--config=/dev/null"];

/**
 * True only when Bun itself reports both safe flags in `execArgv` — the one
 * signal this guard trusts, because nothing in a project's own environment
 * (a `.env`, a shell export, `bunfig.toml`) can set `process.execArgv`; only
 * the interpreter invocation actually used can. Accepts both the
 * `--config=/dev/null` and `--config /dev/null` spellings, in case a future
 * Bun reports the two-argument form.
 */
function hasSafeExecArgv(execArgv: readonly string[]): boolean {
  const hasNoEnvFile = execArgv.includes("--no-env-file");
  const hasConfig = execArgv.some((a, i) => a === "--config=/dev/null" || (a === "--config" && execArgv[i + 1] === "/dev/null"));
  return hasNoEnvFile && hasConfig;
}

/**
 * Bun environment variables that can redirect what code runs or what
 * registry/config it runs with — stripped from the re-exec'd child
 * UNCONDITIONALLY (never gated on whether a `.env` set them), because they
 * are exactly the class of "Bun itself reads this from process.env and acts
 * on it before a single line of `keryx` runs" the guard exists to close.
 * `BUN_OPTIONS` is the sharp one: Bun honours it (e.g. `--preload=…`) even
 * UNDER `--no-env-file --config=/dev/null` — the two flags stop `.env` and
 * `bunfig.toml` autoload, not `BUN_OPTIONS`. `NODE_OPTIONS` is included for
 * defence in depth even though Bun 1.4.2 does not parse it (verified via
 * ctx7 `/oven-sh/bun/bun-v1.4.2`: `node_without_node_options` is always
 * true) — a future Bun version, or a non-Bun `node` on PATH some install
 * path resolves to, might.
 *
 * TRADE-OFF, documented here and in docs/docs/onboarding.md's "Environment
 * isolation": this is fail-safe, not value-aware. A user who genuinely
 * exports one of these in their own shell (not via a project `.env`) has it
 * dropped from the re-exec'd child too. Opt back in with
 * `bun --env-file=… $(which keryx) …` or by exporting the variable AFTER
 * keryx's own safe re-exec would run — i.e. this only matters for the
 * bypassing invocation shapes (`bun src/cli.ts`, `bun dist/cli.js`, `bunx
 * keryx`) this guard exists for; the shipped shebang path never re-execs and
 * so never strips anything.
 */
const ALWAYS_STRIPPED_ENV_KEYS: readonly string[] = ["BUN_OPTIONS", "NODE_OPTIONS"];

/** Prefixes of Bun env vars stripped unconditionally alongside `ALWAYS_STRIPPED_ENV_KEYS` — see its doc comment. */
const ALWAYS_STRIPPED_ENV_PREFIXES: readonly string[] = ["BUN_CONFIG_", "BUN_INSTALL_"];

function isAlwaysStrippedKey(key: string): boolean {
  return ALWAYS_STRIPPED_ENV_KEYS.includes(key) || ALWAYS_STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Every `.env`-shaped filename Bun's own loader (and this guard) considers: `.env`, `.env.local`, `.env.<anything>`. */
function isDotenvFileName(name: string): boolean {
  return name === ".env" || name.startsWith(".env.");
}

/**
 * Every key name assigned in `content` — permissive by design (R2-01: "err
 * on the side of stripping more"). This never parses or trusts VALUES (no
 * quote handling beyond tracking an unterminated quote so a continuation
 * line is not misread as a new `KEY=`/`KEY:` assignment); it only needs to
 * know what NAMES a real dotenv parser (Bun's, which this deliberately does
 * not try to replicate) might bind, so every syntax Bun accepts — plain
 * `KEY=`, `export KEY=`, spaces around `=`, a `KEY:` form some dotenv
 * variants use, and a quoted multi-line value — is treated as "this name may
 * have been set", never as "this exact value was set".
 */
export function collectDotenvKeyNames(content: string): Set<string> {
  const keys = new Set<string>();
  let openQuote: string | undefined;
  for (const rawLine of content.split(/\r?\n/)) {
    if (openQuote !== undefined) {
      // Still inside a multi-line quoted value from a previous line — this
      // line is VALUE content, not a new assignment, no matter what it looks
      // like. Only the matching closing quote ends it.
      if (rawLine.includes(openQuote)) openQuote = undefined;
      continue;
    }
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    let rest = trimmed;
    if (rest.startsWith("export ")) rest = rest.slice("export ".length).trimStart();
    const eq = rest.indexOf("=");
    const colon = rest.indexOf(":");
    const sepIdx = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon);
    if (sepIdx <= 0) continue;
    const key = rest.slice(0, sepIdx).trim();
    // A bare identifier only — anything else (spaces, quotes) in the "key"
    // position means this line is not a plain assignment this parser
    // recognises confidently enough to name a key from; skip it rather than
    // risk stripping an unrelated env var by mis-splitting.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    keys.add(key);
    const value = rest.slice(sepIdx + 1).trimStart();
    const quote = value[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      const closing = value.indexOf(quote, 1);
      if (closing === -1) openQuote = quote;
    }
  }
  return keys;
}

function defaultReadFile(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

/** `{ isFile, isSymbolicLink }` for `p`, without following a symlink — `undefined` when `p` does not exist or is not statable. */
function defaultLstat(p: string): { isFile(): boolean; isSymbolicLink(): boolean } | undefined {
  try {
    const stat = lstatSync(p);
    return { isFile: () => stat.isFile(), isSymbolicLink: () => stat.isSymbolicLink() };
  } catch {
    return undefined;
  }
}

function defaultReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

/**
 * Every key name that ANY `.env*` file directly inside `cwd` might bind —
 * union across every such file, regardless of `NODE_ENV` or Bun's own
 * per-file precedence (R2-01: "NEVER decide from which files exist" applies
 * to the re-exec DECISION, but for what to strip, scanning every `.env*`
 * name rather than only the subset Bun would load for the CURRENT
 * `NODE_ENV` is deliberately over-inclusive — the guard does not re-derive
 * Bun's precedence rules a second time just to decide what is safe to leave
 * in the child's env).
 *
 * A `.env*` entry that is a symlink or not a regular file is `lstat`ed (never
 * followed) and skipped: its content is not read, so it contributes no key
 * names, but its mere presence never widens what is considered "no dotenv
 * here" — this function only ever adds keys, it is not a gate for whether to
 * re-exec at all (that decision is `execArgv`-only, see `ensureSafeBunExec`).
 */
export function collectCwdDotenvKeyNames(
  cwd: string,
  readdir: (p: string) => string[],
  lstat: (p: string) => { isFile(): boolean; isSymbolicLink(): boolean } | undefined,
  readFile: (p: string) => string | undefined,
): Set<string> {
  const keys = new Set<string>();
  for (const name of readdir(cwd)) {
    if (!isDotenvFileName(name)) continue;
    const full = path.join(cwd, name);
    const info = lstat(full);
    if (info === undefined || !info.isFile() || info.isSymbolicLink()) continue;
    const content = readFile(full);
    if (content === undefined) continue;
    for (const key of collectDotenvKeyNames(content)) keys.add(key);
  }
  return keys;
}

/** The minimal child-process surface this module needs — satisfied by `node:child_process`'s `ChildProcess`. */
export interface SafeExecChild {
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** Injectable seams for the test suite; every field defaults to the real thing. */
export interface SafeExecDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  execArgv: readonly string[];
  execPath: string;
  scriptPath: string;
  args: readonly string[];
  pid: number;
  readdir: (p: string) => string[];
  lstat: (p: string) => { isFile(): boolean; isSymbolicLink(): boolean } | undefined;
  readFile: (p: string) => string | undefined;
  spawn: (command: string, args: readonly string[], options: { stdio: "inherit"; env: NodeJS.ProcessEnv }) => SafeExecChild;
  /** Register a handler for a signal THIS process receives. Defaults to `process.on`. */
  onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
  /** Undo `onSignal`. Defaults to `process.off`. */
  offSignal: (signal: NodeJS.Signals, handler: () => void) => void;
  /** Send `signal` to `pid`. Defaults to `process.kill`. Used to re-raise the child's own terminating signal on this process once the child has exited from it. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Terminate this process with `code`. Defaults to `process.exit`. */
  exit: (code: number) => void;
}

function realDeps(): SafeExecDeps {
  return {
    cwd: process.cwd(),
    env: process.env,
    execArgv: process.execArgv,
    execPath: process.execPath,
    scriptPath: process.argv[1] ?? "",
    args: process.argv.slice(2),
    pid: process.pid,
    readdir: defaultReaddir,
    lstat: defaultLstat,
    readFile: defaultReadFile,
    spawn: (command, args, options) => nodeSpawn(command, [...args], { stdio: "inherit", env: options.env }) as ChildProcess as SafeExecChild,
    onSignal: (signal, handler) => process.on(signal, handler),
    offSignal: (signal, handler) => {
      process.off(signal, handler);
    },
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    },
    exit: (code: number): void => {
      process.exit(code);
    },
  };
}

/**
 * The child's environment: `deps.env` minus every key name any `.env*` file
 * in `deps.cwd` might bind, minus the small always-stripped Bun-footgun set
 * (see `ALWAYS_STRIPPED_ENV_KEYS`/`_PREFIXES`). Exported so a test (and
 * R2-07's docs) can exercise it directly without a real child process.
 */
export function buildSafeChildEnv(deps: Pick<SafeExecDeps, "env" | "cwd" | "readdir" | "lstat" | "readFile">): NodeJS.ProcessEnv {
  const dotenvKeys = collectCwdDotenvKeyNames(deps.cwd, deps.readdir, deps.lstat, deps.readFile);
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(deps.env)) {
    if (dotenvKeys.has(key) || isAlwaysStrippedKey(key)) continue;
    childEnv[key] = value;
  }
  return childEnv;
}

/** Signals a real terminal or `kill` can send this process that the re-exec'd child must also see — R2-01 orchestrator follow-up. */
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGWINCH"];

/**
 * Call once, as early as possible in `keryx`'s startup (top of `src/cli.ts`,
 * before anything else runs). Cheap when nothing is wrong: a process that
 * already carries the safe `execArgv` (the normal case — the shebang did its
 * job) returns synchronously after one array scan, nothing else.
 *
 * Otherwise it re-execs itself ONCE — `process.execPath --no-env-file
 * --config=/dev/null <scriptPath> <args…>`, `stdio: "inherit"`, with every
 * dotenv-file-derived key name (and the always-stripped Bun footguns) removed
 * from the child's env — and waits for it. There is no loop-prevention
 * marker: the CHILD's own `process.execArgv` will carry the two safe flags
 * (Bun reports the flags it was actually launched with), so the child's own
 * call into this same function sees `hasSafeExecArgv() === true` and returns
 * immediately — the same signal that lets a normally-launched process skip
 * re-exec at all.
 *
 * Because `stdio: "inherit"` shares file descriptors directly, a signal sent
 * to the OS process group (an interactive Ctrl+C) reaches both processes on
 * its own; a signal sent to THIS process specifically (`kill <pid>`, or a
 * test harness's `proc.kill(...)`) does not automatically reach the child —
 * this forwards `SIGINT`/`SIGTERM`/`SIGHUP`/`SIGQUIT`/`SIGWINCH` to the child
 * and, once the child exits (from a signal or with a code), either re-raises
 * that same signal on this process (so a caller reading THIS process's exit
 * status — `proc.exited`, `$?` — sees the same 128+n encoding a direct,
 * unguarded run would have produced) or exits with the child's exact code.
 * Node/Bun expose no `execve`-style in-place replace, so forwarding is the
 * fallback, not a shortcut.
 */
export async function ensureSafeBunExec(overrides: Partial<SafeExecDeps> = {}): Promise<void> {
  const deps: SafeExecDeps = { ...realDeps(), ...overrides };

  if (hasSafeExecArgv(deps.execArgv)) return;
  // A compiled `bun build --compile` binary IS the runtime — there is no
  // `--no-env-file`/`--config` to hand it at runtime (those are BUILD-time
  // flags for a standalone executable: `--no-compile-autoload-dotenv`/
  // `--no-compile-autoload-bunfig`, baked in by `.github/workflows/
  // release.yml`). Re-execing it with those two bun-only tokens would not
  // suppress anything — it would hand them to keryx itself as its own first
  // two CLI arguments (`Unknown command: --no-env-file`), since the
  // executable has no bun flag parser separate from its own argv. Nothing
  // this function can do helps a binary built without the compile-time
  // flags, so it steps aside rather than breaking one built correctly.
  if (isCompiledBinaryEntry(deps.scriptPath)) return;
  // No entry script (e.g. `bun -e '...'`, a REPL): there is nothing to
  // re-exec with a script-path argument.
  if (deps.scriptPath.length === 0) return;

  const childEnv = buildSafeChildEnv(deps);

  const child = deps.spawn(deps.execPath, [...SAFE_BUN_SPAWN_ARGS, deps.scriptPath, ...deps.args], {
    stdio: "inherit",
    env: childEnv,
  });

  await new Promise<void>((resolve) => {
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of FORWARDED_SIGNALS) {
      const handler = (): void => {
        try {
          child.kill(signal);
        } catch {
          // the child may already have exited
        }
      };
      handlers.set(signal, handler);
      deps.onSignal(signal, handler);
    }
    const cleanup = (): void => {
      for (const [signal, handler] of handlers) deps.offSignal(signal, handler);
    };
    child.on("error", (error) => {
      cleanup();
      resolve();
      deps.exit(1);
      void error;
    });
    child.on("exit", (code, signal) => {
      cleanup();
      resolve();
      if (signal !== null) {
        // Re-raise the SAME signal on this process rather than picking an
        // exit code ourselves — a caller reading this process's own exit
        // status (a shell's `$?`, `proc.exited` in a test) must see the
        // 128+n encoding a direct, unguarded run under that signal would
        // have produced, not this guard's approximation of it.
        deps.kill(deps.pid, signal);
        return;
      }
      deps.exit(code ?? 1);
    });
  });
}

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
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
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

/**
 * Every filename Bun's own loader actually reads (docs/guides/runtime/set-env.mdx,
 * verified via ctx7 `/oven-sh/bun/bun-v1.4.2`, "listed in order of increasing
 * precedence"): `.env`; `.env.production`/`.env.development`/`.env.test`
 * (whichever `NODE_ENV` selects); `.env.local` (skipped only when
 * `NODE_ENV=test`); and the `.local` variant of each of the three
 * NODE_ENV-specific files. This guard does not try to compute which of those
 * `NODE_ENV` would pick — `.env` itself can SET `NODE_ENV`, so the value this
 * process sees before that file is read cannot be trusted to predict it — so
 * it lists all three NODE_ENV-specific files and their `.local` variants
 * UNCONDITIONALLY, same "err on the side of stripping more" reasoning as
 * `collectDotenvKeyNames`.
 *
 * Explicitly NOT on this list, and never scanned: `.env.example`,
 * `.env.sample`, or any other name — Bun's loader never reads them, so
 * treating them as a dotenv source would strip real, user-set env vars (an
 * example file's placeholder key names) for no protection gained. A
 * fail-safe guard is over-inclusive only for files Bun could actually load;
 * a template file is not one of them.
 */
const DOTENV_FILE_NAMES: ReadonlySet<string> = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".env.development.local",
  ".env.production.local",
  ".env.test.local",
]);

function isDotenvFileName(name: string): boolean {
  return DOTENV_FILE_NAMES.has(name);
}

/**
 * Every key name assigned in `content` — permissive by design (R2-01: "err
 * on the side of stripping more"). This never parses or trusts VALUES; it
 * only needs to know what NAMES a real dotenv parser might bind.
 *
 * R3-01 (review round 3, major): the previous LINE-based version (splitting
 * on `/\r?\n/`, one `.trim()`+`.indexOf` pass per line) disagreed with what
 * Bun's own parser actually does (`src/dotenv/env_loader.rs`, read via ctx7
 * `/oven-sh/bun` — `parse_value`/`parse_quoted`, which this function is now a
 * position-based port of, not a re-derivation):
 *
 *   - Bun treats a LONE `\r` (no following `\n`) as a line terminator too —
 *     the old `\r?\n` split let a `KEY=1\rATTACKER=x\r`-shaped file hide
 *     `ATTACKER` inside what looked like one un-split line.
 *   - Bun's `parse_quoted` looks for the closing quote ANYWHERE in the
 *     remaining bytes (not "on a later line, once, checked with
 *     `.includes`"); if no unescaped closing quote exists ANYWHERE in the
 *     rest of the file, `parse_value` does NOT treat the value as quoted at
 *     all — it falls back to the UNQUOTED path, which stops at the first
 *     `#`/`\r`/`\n` on THAT SAME LINE. So an unterminated `"`/`'`/backtick
 *     does not swallow the rest of the file into "value content, not a new
 *     assignment" (the old behaviour, R2-01's own doc comment) — every line
 *     after it is parsed as a normal assignment again, same as Bun. The old
 *     open-quote-until-EOF fallback was exactly backwards for a stripping
 *     guard: it caused UNDER-stripping (a key after an unterminated quote
 *     was never seen), which is the unsafe direction (see
 *     `collectCwdDotenvKeyNames`'s doc comment on the same principle).
 *   - `export` is followed by `parse_key`'s own whitespace skip, which is any
 *     run of spaces/tabs, not only a single literal space.
 *
 * A key that IS found this way is added, whatever Bun's own key-character
 * class does or does not accept for that exact byte — over-matching a name
 * Bun would not actually bind is safe (this only ever REMOVES a name from
 * the child's env, never adds a value); under-matching is not.
 */
export function collectDotenvKeyNames(content: string): Set<string> {
  const keys = new Set<string>();
  const n = content.length;
  const isSpaceOrTab = (ch: string | undefined): boolean => ch === " " || ch === "\t";
  const isLineBreak = (ch: string | undefined): boolean => ch === "\n" || ch === "\r";
  const isKeyChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_.-]/.test(ch);

  let i = 0;
  while (i < n) {
    // Leading whitespace (space/tab) and a UTF-8 BOM are skipped wherever
    // they appear at the start of a would-be key, same as Bun's
    // `skip_whitespaces` — not only once at the very top of the file.
    while (i < n && (isSpaceOrTab(content[i]) || content[i] === "﻿")) i++;
    if (i >= n) break;
    if (isLineBreak(content[i])) {
      i++;
      continue;
    }
    if (content[i] === "#") {
      while (i < n && !isLineBreak(content[i])) i++;
      continue;
    }
    if (content.startsWith("export", i) && isSpaceOrTab(content[i + "export".length])) {
      i += "export".length;
      while (i < n && isSpaceOrTab(content[i])) i++;
    }
    const keyStart = i;
    while (i < n && isKeyChar(content[i])) i++;
    const key = content.slice(keyStart, i);
    while (i < n && isSpaceOrTab(content[i])) i++;
    const sep = content[i];
    if (key.length === 0 || (sep !== "=" && sep !== ":")) {
      // Not a plain assignment this line recognises — skip to the next line
      // rather than risk mis-splitting an unrelated env var.
      while (i < n && !isLineBreak(content[i])) i++;
      continue;
    }
    keys.add(key);
    i++; // consume '=' or ':'
    while (i < n && isSpaceOrTab(content[i])) i++;

    const quote = content[i];
    if (quote === '"' || quote === "'" || quote === "`") {
      // Mirrors `parse_quoted`: scan the REST OF THE FILE (not just this
      // line) for the first unescaped closing quote (only `"` recognises a
      // `\`-escape, same as Bun's `QUOTE == '"'` branch).
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (quote === '"' && content[j] === "\\") {
          j += 2;
          continue;
        }
        if (content[j] === quote) {
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (closed) {
        i = j; // the whole quoted span — newlines inside it included — is value content, not new keys.
      }
      // else: unterminated — falls through to the unquoted path below, which
      // stops at end-of-line on THIS line only (exactly Bun's fallback).
    }
    while (i < n && content[i] !== "#" && !isLineBreak(content[i])) i++;
    if (i < n && content[i] === "#") {
      while (i < n && !isLineBreak(content[i])) i++;
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

/**
 * `{ isFile, size }` for `p`, FOLLOWING a symlink to whatever it resolves to
 * — `undefined` when `p` does not exist, is a broken symlink, or is not
 * statable. R3-01 (review round 3, major): the previous version used
 * `lstatSync` (never follows) specifically so a `.env*` that is a symlink
 * would read as "not a regular file" and be skipped — exactly backwards for
 * a guard whose job is to strip everything BUN would load: Bun's own loader
 * follows a symlinked `.env*` (a git clone preserves symlinks, so `ln -s
 * cfg.txt .env.local` needs no unusual syntax at all), so a guard that skips
 * it instead lets every key that symlink names straight through. `statSync`
 * (follows) is the correct call here; the name kept `lstat` in earlier
 * rounds only because "do not follow" seemed the safe default — it was not.
 */
function defaultStat(p: string): { isFile(): boolean; size: number } | undefined {
  try {
    const stat = statSync(p);
    return { isFile: () => stat.isFile(), size: stat.size };
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
 * Bytes read from any single `.env*` file (its symlink target included)
 * before this guard gives up on it — defence against a symlink pointing at
 * an unbounded or enormous read (`/dev/zero`, a multi-gigabyte file) hanging
 * or exhausting memory. Chosen well above the largest legitimate case this
 * guard is tested against (a 200,000-line probe file, ~9 MiB) with headroom.
 * A file over this size is SKIPPED entirely (not partially scanned — a
 * partial read could cut a key name in half and miss it, which is the unsafe
 * direction): this only narrows what gets stripped from an ALREADY-decided-
 * unsafe re-exec, never the decision to re-exec at all (`execArgv`-only, see
 * `ensureSafeBunExec`), so it cannot be used to widen what "no dotenv here"
 * means.
 */
const MAX_DOTENV_READ_BYTES = 16 * 1024 * 1024;

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
 * A `.env*` entry is `stat`ed (FOLLOWING a symlink, R3-01 — see `defaultStat`'s
 * doc comment) and skipped only when it does not resolve to a regular file
 * at all, or is larger than `MAX_DOTENV_READ_BYTES`: its content is then not
 * read, so it contributes no key names, but its mere presence never widens
 * what is considered "no dotenv here" — this function only ever adds keys,
 * it is not a gate for whether to re-exec at all (that decision is
 * `execArgv`-only, see `ensureSafeBunExec`).
 */
export function collectCwdDotenvKeyNames(
  cwd: string,
  readdir: (p: string) => string[],
  stat: (p: string) => { isFile(): boolean; size: number } | undefined,
  readFile: (p: string) => string | undefined,
): Set<string> {
  const keys = new Set<string>();
  for (const name of readdir(cwd)) {
    if (!isDotenvFileName(name)) continue;
    const full = path.join(cwd, name);
    const info = stat(full);
    if (info === undefined || !info.isFile() || info.size > MAX_DOTENV_READ_BYTES) continue;
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
  stat: (p: string) => { isFile(): boolean; size: number } | undefined;
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
  /** This process's OWN current parent pid, read fresh each call (a real ppid can change — a dying parent reparents its children to init/pid 1 on POSIX). Defaults to `process.ppid`. Used only by the re-exec'd CHILD's ppid watchdog (see `watchParentPid`), never by the wrapper itself. */
  getPpid: () => number | undefined;
  /** Run `fn` every `ms` milliseconds on an UNREF'd timer (never keeps the process alive on its own) until `.clear()` is called. Defaults to a real `setInterval` + `.unref()`. */
  setUnrefInterval: (fn: () => void, ms: number) => { clear: () => void };
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
    stat: defaultStat,
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
    getPpid: () => process.ppid,
    setUnrefInterval: (fn, ms) => {
      const handle = setInterval(fn, ms);
      handle.unref?.();
      return { clear: () => clearInterval(handle) };
    },
  };
}

/**
 * The child's environment: `deps.env` minus every key name any `.env*` file
 * in `deps.cwd` might bind, minus the small always-stripped Bun-footgun set
 * (see `ALWAYS_STRIPPED_ENV_KEYS`/`_PREFIXES`). Exported so a test (and
 * R2-07's docs) can exercise it directly without a real child process.
 */
export function buildSafeChildEnv(deps: Pick<SafeExecDeps, "env" | "cwd" | "readdir" | "stat" | "readFile">): NodeJS.ProcessEnv {
  const dotenvKeys = collectCwdDotenvKeyNames(deps.cwd, deps.readdir, deps.stat, deps.readFile);
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
 * The re-exec'd child's `execArgv`: the two safe flags FIRST, followed by
 * every OTHER flag the parent was actually launched with (Bun's own
 * `--preload`, `--smol`, a test harness's own `--preload <probe>`, …),
 * preserved rather than dropped.
 *
 * R3 regression (flow 319 CI): the previous version discarded `deps.execArgv`
 * entirely and spawned with ONLY `SAFE_BUN_SPAWN_ARGS` — so a caller that
 * bypasses the shebang AND passes its own bun flags (e.g.
 * `src/tui/shell-fallback.test.ts`'s `bun --preload <probe> src/cli.ts …`,
 * which relies on that `--preload` to fake a TTY / stub the optional TUI
 * package) silently lost them in the child, because `hasSafeExecArgv` was
 * false (no `--no-env-file`/`--config` yet) and this function re-executed
 * with a brand new argv that never carried `--preload` forward. Any flag
 * already equal to one of `SAFE_BUN_SPAWN_ARGS` is de-duplicated (a caller
 * cannot end up with e.g. two `--no-env-file`s); everything else survives
 * verbatim, in its original relative order, after the two safe flags.
 */
function buildChildExecArgv(execArgv: readonly string[]): string[] {
  const extra = execArgv.filter((arg) => !SAFE_BUN_SPAWN_ARGS.includes(arg));
  return [...SAFE_BUN_SPAWN_ARGS, ...extra];
}

/**
 * Marks the child's env so its OWN `ensureSafeBunExec` call (which will see
 * `hasSafeExecArgv() === true` and return immediately, per the module doc)
 * can tell it is the re-exec'd CHILD of a wrapper still watching it, as
 * opposed to a normal shebang-launched process that has no wrapper at all —
 * `watchParentPid` below no-ops when this is absent, which is the common
 * case (every shipped invocation) and must stay cheap.
 */
const REEXEC_PARENT_PID_ENV = "KERYX_REEXEC_PARENT_PID";

/** How often the child polls its own `ppid` to notice the wrapper is gone. Cheap and unref'd — see `watchParentPid`. */
const PPID_WATCHDOG_INTERVAL_MS = 250;

/**
 * R3 regression (flow 319 CI, orchestrator hypothesis 2): with `stdio:
 * "inherit"`, a signal aimed at THIS wrapper process by pid (`kill -9
 * <wrapperPid>`, a test harness's `proc.kill("SIGKILL")`) is not forwarded —
 * the wrapper is simply gone, and the re-exec'd child (the process actually
 * holding the session lease / bus presence a test is asserting about) keeps
 * running under whatever adopts orphaned processes (`init`/pid 1, or a
 * subreaper), invisible to a caller that only knows the wrapper's pid. A
 * `SIGSTOP` on the wrapper is worse: the wrapper cannot even run a handler to
 * forward it, so the child is never told at all — there is no general fix for
 * that case from inside the child (see the module doc's "preferred fix"
 * below); this watchdog bounds how long the child can outlive an ALREADY-DEAD
 * wrapper.
 *
 * PREFERRED FIX, applied first (see the call sites of `SAFE_BUN_SPAWN_ARGS`
 * across the `*.process.test.ts` files under `src/`): every shipped entry point and every
 * test fixture that spawns `keryx` as a subprocess launches it WITH the safe
 * flags already present, so `hasSafeExecArgv` is true on the FIRST process
 * and this module never spawns a wrapper at all — the pid a caller holds IS
 * the real `keryx` process, SIGKILL/SIGSTOP reach it directly, no watchdog
 * needed. This watchdog is defence in depth for the invocation shapes that
 * still bypass the shebang and cannot carry the safe flags themselves: `bun
 * src/cli.ts …`/`bunx keryx …` run by something this codebase does not
 * control (a user's own shell, a third-party task runner), and — until Bun
 * ships a Windows-native shim — an npm-installed Windows `.cmd`/`.ps1`.
 *
 * Decision: poll `ppid` on an unref'd 250 ms timer rather than react to an
 * event, because there is no portable "parent died" event in Node/Bun (no
 * `SIGCHLD`-equivalent visible to the child about ITS OWN parent) — polling
 * is the only mechanism available. 250 ms bounds an orphaned child's outlive
 * window at roughly a quarter-second past the wrapper's death, which is fast
 * enough that a process-liveness test (this fix exists to satisfy exactly
 * that kind of test) does not need to add its own extra wait for it, and
 * cheap enough (a single `process.ppid` read, no syscall-heavy work) to run
 * unconditionally on every safe-flagged process. SIGSTOP is out of scope by
 * construction (documented above, not silently unhandled): a stopped wrapper
 * cannot be distinguished from a slow-but-alive one by ppid alone, and this
 * watchdog runs in the CHILD, which has no way to observe the wrapper's own
 * process state short of `/proc` (not portable) — the preferred fix (no
 * wrapper) is what actually closes the SIGSTOP gap, not this timer.
 */
function watchParentPid(deps: Pick<SafeExecDeps, "env" | "getPpid" | "setUnrefInterval" | "exit">): void {
  const recorded = deps.env[REEXEC_PARENT_PID_ENV];
  if (recorded === undefined) return;
  const parentPid = Number(recorded);
  if (!Number.isInteger(parentPid) || parentPid <= 0) return;
  const handle = deps.setUnrefInterval(() => {
    const currentPpid = deps.getPpid();
    if (currentPpid === parentPid) return;
    // The wrapper that spawned us is gone — either reparented to init/pid 1
    // (POSIX) or to some unrelated pid. Exit rather than run on as an
    // invisible orphan; a caller that only ever held the wrapper's pid
    // should not be able to observe this process as still alive.
    handle.clear();
    deps.exit(1);
  }, PPID_WATCHDOG_INTERVAL_MS);
}

/**
 * Call once, as early as possible in `keryx`'s startup (top of `src/cli.ts`,
 * before anything else runs). Cheap when nothing is wrong: a process that
 * already carries the safe `execArgv` (the normal case — the shebang did its
 * job) returns synchronously after one array scan, nothing else.
 *
 * Otherwise it re-execs itself ONCE — `process.execPath --no-env-file
 * --config=/dev/null <…any other flag the parent was launched with>
 * <scriptPath> <args…>` (see `buildChildExecArgv`: the two safe flags are
 * ADDED, never a replacement for whatever else the parent's own `execArgv`
 * carried), `stdio: "inherit"`, with every dotenv-file-derived key name (and
 * the always-stripped Bun footguns) removed from the child's env — and waits
 * for it. There is no loop-prevention
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

  if (hasSafeExecArgv(deps.execArgv)) {
    watchParentPid(deps);
    return;
  }
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
  childEnv[REEXEC_PARENT_PID_ENV] = String(deps.pid);

  const child = deps.spawn(deps.execPath, [...buildChildExecArgv(deps.execArgv), deps.scriptPath, ...deps.args], {
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
        //
        // R3-02 (review round 3, minor): re-raising is not enough ON ITS
        // OWN. `deps.kill(deps.pid, signal)` asks the OS to deliver the
        // signal to THIS process; for a signal whose disposition actually
        // terminates it (SIGTERM, SIGINT, …) that happens, but for one this
        // process does not die from — SIGUSR1 (reserved by Bun's inspector,
        // ignored otherwise), a signal some other part of this same process
        // has its own handler for, or simply a signal delivered
        // asynchronously by the event loop, not before this synchronous
        // callback returns — nothing stops execution from falling through
        // into WHATEVER RAN this guard (`src/cli.ts`'s `main()`), in the
        // very process a cwd `.env`/`bunfig.toml` already poisoned: the
        // guard's entire reason to exist. So this ALWAYS calls `deps.exit`
        // with the 128+n encoding right after asking for the re-raise,
        // rather than merely hoping the re-raise lands first — for a signal
        // that DOES terminate this process the re-raise wins the race in
        // practice (this line then never actually runs), and for one that
        // does not, this is what makes the process exit instead of running
        // the command a second time, unguarded.
        deps.kill(deps.pid, signal);
        deps.exit(128 + (osConstants.signals[signal] ?? 0));
        return;
      }
      deps.exit(code ?? 1);
    });
  });
}

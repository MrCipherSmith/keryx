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
// by re-executing once under the safe flags with the dotenv-sourced
// variables stripped back out.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { isCompiledBinaryEntry } from "./self-invocation";

/** Set on the re-exec'd child so a second pass never re-execs again. */
export const SAFE_EXEC_MARKER = "KERYX_SAFE_EXEC";

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
 * Minimal, best-effort `.env` line parser — good enough to compute "what
 * value would this key have gotten from this file" for the strip-only-if-
 * still-equal check below. It does not need to be a faithful dotenv
 * implementation (quoting edge cases, multi-line values, `${VAR}`
 * interpolation): Bun's own loader already ran and set `process.env` before
 * this code executes, so this parser's ONLY job is producing values to
 * compare against what is already there.
 */
export function parseDotenvText(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    if (key.length === 0) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    result[key] = value;
  }
  return result;
}

/**
 * Merge every dotenv file present in `cwd`, in Bun's own documented
 * precedence order (later entries win): `.env`, `.env.<NODE_ENV>`,
 * `.env.local` (skipped when `NODE_ENV === "test"`, matching Bun),
 * `.env.<NODE_ENV>.local`. `NODE_ENV` is read from the CURRENT `env` (which
 * may itself already be dotenv-derived) purely to select filenames the same
 * way Bun's own loader did — this function never sources a file into
 * anything, it only builds a comparison table.
 */
export function collectDotenvValues(
  cwd: string,
  env: NodeJS.ProcessEnv,
  readFile: (p: string) => string | undefined,
): Record<string, string> {
  const nodeEnv = env.NODE_ENV;
  const files = [".env"];
  if (nodeEnv) files.push(`.env.${nodeEnv}`);
  if (nodeEnv !== "test") files.push(".env.local");
  if (nodeEnv) files.push(`.env.${nodeEnv}.local`);
  const merged: Record<string, string> = {};
  for (const name of files) {
    const content = readFile(path.join(cwd, name));
    if (content === undefined) continue;
    Object.assign(merged, parseDotenvText(content));
  }
  return merged;
}

function defaultReadFile(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

/** Injectable seams for the test suite; every field defaults to the real thing. */
export interface SafeExecDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  execArgv: readonly string[];
  execPath: string;
  scriptPath: string;
  args: readonly string[];
  existsSync: (p: string) => boolean;
  readFile: (p: string) => string | undefined;
  spawnSync: (
    command: string,
    args: readonly string[],
    options: { stdio: "inherit"; env: NodeJS.ProcessEnv },
  ) => SpawnSyncReturns<Buffer>;
  exit: (code: number) => never;
}

function realDeps(): SafeExecDeps {
  return {
    cwd: process.cwd(),
    env: process.env,
    execArgv: process.execArgv,
    execPath: process.execPath,
    scriptPath: process.argv[1] ?? "",
    args: process.argv.slice(2),
    existsSync,
    readFile: defaultReadFile,
    spawnSync: (command, args, options) => spawnSync(command, args, options),
    exit: (code: number): never => process.exit(code),
  };
}

function hasSafeExecArgv(execArgv: readonly string[]): boolean {
  const hasNoEnvFile = execArgv.includes("--no-env-file");
  const hasConfig = execArgv.some((a) => a === "--config" || a.startsWith("--config="));
  return hasNoEnvFile && hasConfig;
}

/**
 * Call once, as early as possible in `keryx`'s startup (top of `src/cli.ts`,
 * before anything else runs). Cheap when nothing is wrong: when the process
 * already carries the safe `execArgv` (the normal case — the shebang did its
 * job) OR neither a `.env` nor a `bunfig.toml` sits in `cwd`, this is two
 * `existsSync` calls and a return, nothing else.
 *
 * Otherwise it re-execs itself ONCE — `process.execPath --no-env-file
 * --config=/dev/null <scriptPath> <args…>`, `stdio: "inherit"`, marked with
 * `KERYX_SAFE_EXEC=1` so the child never loops back into this branch — with
 * every dotenv-file-derived variable stripped from the child's env, UNLESS
 * the current value differs from what that file would have set (a real
 * shell `export FOO=bar` surviving alongside a `.env` that also sets `FOO`
 * must not be silently dropped; only the exact value the file would have
 * contributed is removed). The child's exit code becomes this process's exit
 * code via `exit()`.
 */
export function ensureSafeBunExec(overrides: Partial<SafeExecDeps> = {}): void {
  const deps: SafeExecDeps = { ...realDeps(), ...overrides };

  if (deps.env[SAFE_EXEC_MARKER] === "1") return;
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

  const envFilePresent = deps.existsSync(path.join(deps.cwd, ".env"));
  const bunfigPresent = deps.existsSync(path.join(deps.cwd, "bunfig.toml"));
  if (!envFilePresent && !bunfigPresent) return;

  // Only the files Bun would actually have loaded for the CURRENT `NODE_ENV`
  // contribute a value here — a `.env.production` sitting unused in `cwd`
  // while `NODE_ENV` is unset never reached `process.env`, so it must not be
  // treated as a source of truth for what to strip.
  const dotenvValues = collectDotenvValues(deps.cwd, deps.env, deps.readFile);

  const childEnv: NodeJS.ProcessEnv = { ...deps.env };
  for (const [key, fileValue] of Object.entries(dotenvValues)) {
    if (childEnv[key] === fileValue) {
      delete childEnv[key];
    }
  }
  childEnv[SAFE_EXEC_MARKER] = "1";

  const result = deps.spawnSync(deps.execPath, ["--no-env-file", "--config=/dev/null", deps.scriptPath, ...deps.args], {
    stdio: "inherit",
    env: childEnv,
  });
  deps.exit(result.status ?? 1);
}

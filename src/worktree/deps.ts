import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { relativePathProblem, type DependencyConfig } from "./config";
import { gitDirOf } from "./git";
import { keryxDirIn } from "./checkout";

export type DepsMethod = "clone" | "install" | "skipped";

export interface DepsRecord {
  dir: string;
  lockHash: string;
  method: DepsMethod;
  at: string;
}

interface DepsFile {
  version: 1;
  records: DepsRecord[];
}

export interface InstallResult {
  code: number;
  stderr?: string;
}

/** Runs one install command in `cwd`. Injected so tests never reach the network. `timeoutMs` bounds the run. */
export type RunInstall = (command: string, cwd: string, timeoutMs?: number) => Promise<InstallResult>;

/** How long an install or a copy-on-write copy may run before it is killed (10 minutes). */
export const DEFAULT_DEPS_TIMEOUT_MS = 600_000;

/** The configured bound: `KERYX_WORKTREE_DEPS_TIMEOUT_MS` when it is a positive integer, else the default. */
export function depsTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.KERYX_WORKTREE_DEPS_TIMEOUT_MS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DEPS_TIMEOUT_MS;
}

/** Spawn `command`, killing its whole process group when `timeoutMs` passes. */
async function runBounded(command: string[], cwd: string | undefined, timeoutMs: number, wantStderr: boolean): Promise<{ code: number; stderr: string; timedOut: boolean }> {
  const proc = Bun.spawn(command, {
    ...(cwd !== undefined && { cwd }),
    stdout: "ignore",
    stderr: wantStderr ? "pipe" : "ignore",
    detached: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  }, timeoutMs);
  try {
    const [stderr, code] = await Promise.all([wantStderr ? new Response(proc.stderr as ReadableStream).text() : Promise.resolve(""), proc.exited]);
    return { code, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

export interface PrepareDependencyInput {
  mainRoot: string;
  worktreeRoot: string;
  dependency: DependencyConfig;
  runInstall?: RunInstall;
  /** Bound for the copy and the install; default {@link depsTimeoutMs}. */
  timeoutMs?: number;
  now?: () => Date;
}

export const defaultRunInstall: RunInstall = async (command, cwd, timeoutMs = depsTimeoutMs()) => {
  const outcome = await runBounded(["sh", "-c", command], cwd, timeoutMs, true);
  if (outcome.timedOut) {
    return { code: 124, stderr: `timed out after ${Math.round(timeoutMs / 1000)}s and was killed` };
  }
  return { code: outcome.code, stderr: outcome.stderr };
};

/** sha256 over the lock files' contents, in the configured order. An absent file contributes a marker, so removing a lock changes the hash. */
export async function computeLockHash(root: string, lockfiles: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const lockfile of lockfiles) {
    try {
      hash.update(await readFile(path.join(root, lockfile)));
    } catch {
      hash.update(`\0missing:${lockfile}\0`);
    }
  }
  return hash.digest("hex");
}

async function isDirectory(target: string): Promise<boolean> {
  return (await stat(target).catch(() => undefined))?.isDirectory() === true;
}

function cowCopyCommand(source: string, destination: string): string[] | undefined {
  if (process.platform === "darwin") return ["cp", "-c", "-R", source, destination];
  if (process.platform === "linux") return ["cp", "-R", "--reflink=auto", source, destination];
  return undefined;
}

/** Copy-on-write copy; `false` when the platform or filesystem refuses (which is not an error). */
async function tryCowCopy(source: string, destination: string, timeoutMs: number): Promise<boolean> {
  const command = cowCopyCommand(source, destination);
  if (command === undefined) return false;
  await mkdir(path.dirname(destination), { recursive: true });
  const outcome = await runBounded(command, undefined, timeoutMs, false);
  if (outcome.code === 0 && !outcome.timedOut) return true;
  await rm(destination, { recursive: true, force: true });
  return false;
}

function depsFileIn(gitDir: string): string {
  return path.join(keryxDirIn(gitDir), "deps.json");
}

export async function readDepsRecords(worktreeRoot: string): Promise<DepsRecord[]> {
  try {
    const raw = JSON.parse(await readFile(depsFileIn(await gitDirOf(worktreeRoot)), "utf8")) as Partial<DepsFile>;
    return Array.isArray(raw.records) ? raw.records : [];
  } catch {
    return [];
  }
}

async function writeDepsRecord(worktreeRoot: string, record: DepsRecord): Promise<void> {
  const gitDir = await gitDirOf(worktreeRoot);
  const records = (await readDepsRecords(worktreeRoot)).filter((existing) => existing.dir !== record.dir);
  records.push(record);
  const file: DepsFile = { version: 1, records };
  await mkdir(keryxDirIn(gitDir), { recursive: true });
  const temp = `${depsFileIn(gitDir)}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await rename(temp, depsFileIn(gitDir));
}

/**
 * Make one dependency directory ready in the worktree (spec §7.2):
 * skip when it exists and its lock hash matches the recorded one; otherwise
 * clone it copy-on-write from the main checkout and install only if the main
 * checkout's locks differ; with no clone, install.
 */
export async function prepareDependency(input: PrepareDependencyInput): Promise<DepsRecord> {
  const { mainRoot, worktreeRoot, dependency } = input;
  const runInstall = input.runInstall ?? defaultRunInstall;
  for (const entry of [dependency.dir, ...dependency.lockfiles]) {
    const problem = relativePathProblem(entry);
    if (problem !== undefined) throw new Error(`unsafe dependency path "${entry}": ${problem}`);
  }
  const timeoutMs = input.timeoutMs ?? depsTimeoutMs();
  const at = (input.now?.() ?? new Date()).toISOString();
  const target = path.join(worktreeRoot, dependency.dir);
  const lockHash = await computeLockHash(worktreeRoot, dependency.lockfiles);

  const recorded = (await readDepsRecords(worktreeRoot)).find((record) => record.dir === dependency.dir);
  const present = await isDirectory(target);
  if (present && recorded?.lockHash === lockHash) {
    const record: DepsRecord = { dir: dependency.dir, lockHash, method: "skipped", at };
    await writeDepsRecord(worktreeRoot, record);
    return record;
  }

  let cloned = false;
  const mainDir = path.join(mainRoot, dependency.dir);
  // An existing (stale) directory is not copied over: cp would nest into it.
  if (!present && (await isDirectory(mainDir))) {
    cloned = await tryCowCopy(mainDir, target, timeoutMs);
  }
  const needsInstall = !cloned || (await computeLockHash(mainRoot, dependency.lockfiles)) !== lockHash;

  let method: DepsMethod = cloned ? "clone" : "install";
  if (needsInstall) {
    if (dependency.install === undefined) {
      if (!cloned) {
        return { dir: dependency.dir, lockHash, method: "skipped", at };
      }
    } else {
      const outcome = await runInstall(dependency.install, worktreeRoot, timeoutMs);
      if (outcome.code !== 0) {
        const detail = outcome.stderr?.trim().split("\n").slice(-3).join(" ") ?? "";
        throw new Error(`install failed for ${dependency.dir} (exit ${outcome.code})${detail === "" ? "" : `: ${detail}`}`);
      }
      method = "install";
    }
  }
  const record: DepsRecord = { dir: dependency.dir, lockHash, method, at };
  await writeDepsRecord(worktreeRoot, record);
  return record;
}

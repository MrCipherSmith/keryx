// Flow 290 T5 (AC9, AC10): one project-scoped maintenance lock shared by the
// interactive `keryx sync --apply` / `keryx gdgraph build` AND every triggered
// run that rebuilds derived artifacts (`reconcile`, `rebuild`, `open-flow`'s
// check-then-create).
//
// Before this, only TRIGGERED runs took a lock (`withTriggerRunLock`, flow
// 286), so a person typing `keryx sync --apply` while a trigger fired could
// race it. Now both paths take this one lock; they differ only in how they
// react to finding it held:
//
//   - interactive callers WAIT, bounded (`KERYX_MAINTENANCE_LOCK_WAIT_MS`,
//     default 120 s), then fail with the holder's pid named — never reported as
//     a build failure (exit 75, EX_TEMPFAIL, which the post-commit hook maps to
//     its own "skipped, another run holds the lock" line);
//   - triggered callers refuse at once (`waitMs: 0`), so a trigger stays
//     exactly one pass (flow 286 T7 decision).
//
// RE-ENTRANCY. `withFileLock` is not re-entrant: a second acquire of the same
// path from the process that holds it sees its own live pid, never judges the
// lock stale, and waits out its timeout. `sync --apply` calls `gdgraph build`
// in-process, and a triggered `reconcile` calls `sync --apply` — both would
// deadlock on themselves. So the set of lock paths the CURRENT async context
// holds travels in an `AsyncLocalStorage`: a nested acquire inside the holder's
// own call chain runs straight through, while an unrelated concurrent call in
// the same process (a sibling async context, which does not inherit the store)
// still goes to the file lock and is excluded. A module-level "held" flag would
// get that second case wrong.
//
// The store is NOT inherited by child processes, deliberately: a dispatched
// agent's own `keryx gdgraph build` is a different process and must take the
// lock like anyone else (AC10) — which is why a `flow-next` dispatch never
// holds this lock across the agent run.

import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "./fs";

const lockPathCache = new Map<string, string>();

/**
 * The one maintenance lock directory for a project root.
 *
 * Inside the repository's git directory (`git rev-parse --git-path`), NOT in
 * the working tree: a lock directory under `.metaproject/data/` is untracked
 * content, and a `git add -A` that runs while a build holds it — the
 * post-commit hook's own rebuild is exactly such a window — commits the lock's
 * `owner.json` (observed while verifying this change). `--git-path` is
 * per-worktree, which matches the per-worktree graph/wiki artifacts the lock
 * protects. Outside a git repository it falls back to
 * `.metaproject/data/.maintenance.lock`.
 */
export function maintenanceLockPath(projectRoot: string): string {
  return gitScopedLockPath(projectRoot, "keryx-maintenance.lock", path.join(".metaproject", "data", ".maintenance.lock"));
}

/**
 * A lock directory named `name` inside the checkout's git directory, or
 * `<root>/<fallbackRelative>` outside a repository. Shared by every keryx lock
 * that is held long enough for a `git add -A` to catch it in the working tree.
 */
export function gitScopedLockPath(projectRoot: string, name: string, fallbackRelative: string): string {
  const root = path.resolve(projectRoot);
  const key = `${root}\0${name}`;
  const cached = lockPathCache.get(key);
  if (cached !== undefined) return cached;
  let resolved: string;
  try {
    const out = execFileSync("git", ["rev-parse", "--git-path", name], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    resolved = out.length > 0 ? path.resolve(root, out) : path.join(root, fallbackRelative);
  } catch {
    resolved = path.join(root, fallbackRelative);
  }
  lockPathCache.set(key, resolved);
  return resolved;
}

/** Default bounded wait for an interactive caller. */
export const DEFAULT_INTERACTIVE_LOCK_WAIT_MS = 120_000;

/** Exit code an interactive command uses when the lock stayed held past the wait (EX_TEMPFAIL). */
export const MAINTENANCE_LOCK_BUSY_EXIT_CODE = 75;

const LOCK_TIMEOUT_PREFIX = "Timed out waiting for lock:";

const heldPaths = new AsyncLocalStorage<ReadonlySet<string>>();

/** The lock was held by someone else for the whole allowed wait. */
export class MaintenanceLockBusyError extends Error {
  readonly lockPath: string;
  readonly holderPid: number | undefined;
  readonly waitedMs: number;

  constructor(lockPath: string, holderPid: number | undefined, waitedMs: number) {
    super(
      `another keryx maintenance run ${holderPid === undefined ? "(holder pid unknown)" : `(pid ${holderPid})`} holds ` +
        `${lockPath}; waited ${Math.round(waitedMs / 1000)}s`,
    );
    this.name = "MaintenanceLockBusyError";
    this.lockPath = lockPath;
    this.holderPid = holderPid;
    this.waitedMs = waitedMs;
  }
}

/** Resolve the interactive wait bound, honouring `KERYX_MAINTENANCE_LOCK_WAIT_MS`. */
export function interactiveLockWaitMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env["KERYX_MAINTENANCE_LOCK_WAIT_MS"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_INTERACTIVE_LOCK_WAIT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_INTERACTIVE_LOCK_WAIT_MS;
}

/** True when the current async context already holds this project's maintenance lock. */
export function holdsMaintenanceLock(projectRoot: string): boolean {
  return heldPaths.getStore()?.has(maintenanceLockPath(projectRoot)) === true;
}

/**
 * Run `fn` while holding the project's maintenance lock. Re-entrant within one
 * async context. Throws {@link MaintenanceLockBusyError} when the lock stayed
 * held by another holder for `waitMs`; every other error — including one `fn`
 * throws — propagates unchanged.
 */
export async function withMaintenanceLock<T>(
  projectRoot: string,
  fn: () => Promise<T>,
  options: { readonly waitMs: number },
): Promise<T> {
  const lockPath = maintenanceLockPath(projectRoot);
  const current = heldPaths.getStore();
  if (current?.has(lockPath) === true) {
    return fn();
  }
  const next = new Set(current ?? []);
  next.add(lockPath);
  let entered = false;
  try {
    return await withFileLock(
      lockPath,
      async () => {
        entered = true;
        await holdSeam(lockPath);
        return heldPaths.run(next, fn);
      },
      { timeoutMs: options.waitMs },
    );
  } catch (error) {
    if (!entered && error instanceof Error && error.message.startsWith(LOCK_TIMEOUT_PREFIX)) {
      throw new MaintenanceLockBusyError(lockPath, await readHolderPid(lockPath), options.waitMs);
    }
    throw error;
  }
}

async function readHolderPid(lockPath: string): Promise<number | undefined> {
  try {
    const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as { pid?: unknown };
    return typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) ? owner.pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * TEST SEAM, never set in production. `KERYX_MAINTENANCE_LOCK_HOLD_UNTIL=<file>`:
 * once the lock is acquired, write `<file>.acquired` and keep holding it until
 * `<file>` exists. Lets a concurrency test observe "process A holds the lock" as
 * an event and release it on demand, instead of guessing with a sleep.
 */
async function holdSeam(lockPath: string): Promise<void> {
  const release = process.env["KERYX_MAINTENANCE_LOCK_HOLD_UNTIL"];
  if (release === undefined || release.length === 0) return;
  const { writeFile, stat } = await import("node:fs/promises");
  await writeFile(`${release}.acquired`, `${process.pid}\n${lockPath}\n`, "utf8");
  for (;;) {
    try {
      await stat(release);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/**
 * For an interactive command: run `fn` under the lock, waiting up to the
 * interactive bound. On a busy lock, print one line naming the holder and set
 * exit code 75 — a distinct "not run, retry" answer, never "the build failed".
 * Returns whether `fn` ran.
 */
export async function runInteractiveUnderMaintenanceLock(
  projectRoot: string,
  label: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  try {
    await withMaintenanceLock(projectRoot, fn, { waitMs: interactiveLockWaitMs() });
    return true;
  } catch (error) {
    if (error instanceof MaintenanceLockBusyError) {
      console.error(
        `keryx ${label}: not run — ${error.message}. That run is rebuilding the same artifacts; ` +
          `retry when it finishes (raise KERYX_MAINTENANCE_LOCK_WAIT_MS to wait longer).`,
      );
      process.exitCode = MAINTENANCE_LOCK_BUSY_EXIT_CODE;
      return false;
    }
    throw error;
  }
}

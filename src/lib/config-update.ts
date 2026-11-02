// One read-modify-write primitive for the small user-global JSON stores
// (`auth.json`, `permissions.json`, `hooks-trust.json`,
// `routing-config-trust.json`).
//
// Every one of those is written by several keryx processes at once — parallel
// shell sessions, subagent children, `keryx serve`, one-shot CLI commands —
// and each writer used to load the whole file, change one key and rename a
// new file over it. An atomic rename prevents a torn file; it does nothing
// about a LOST update: two processes that both read before either renames
// each write a map built from the same old snapshot, and the later rename
// silently discards the other's change (a just-rotated OAuth refresh token, a
// revoked allow pattern coming back, a trust entry that vanished).
//
// The lock that used to sit around `auth.json` (`withAuthFileLockSync`, PR
// #718) was removed because it was an `Atomics.wait` mutex with a 2s timeout
// around every hot TUI write. So this one is shaped to never hang the caller:
//
// - The critical section is only read → mutate → atomic rename of a file of a
//   few KB; nothing slow (no network, no prompt) ever runs under it.
// - The wait is capped at {@link CONFIG_UPDATE_LOCK_TIMEOUT_MS}, and a lock
//   older than {@link CONFIG_UPDATE_LOCK_STALE_MS} — a holder killed between
//   open and unlink — is broken, so a crash never wedges later writers.
// - When the lock cannot be had in time, the update is NOT dropped and NOT
//   written blind: it falls back to an optimistic compare-before-rename,
//   re-reading the file, re-applying the mutation to that fresh content and
//   writing only if the file is still byte-identical to what was mutated.
//
// In both paths the mutation is applied to the content on disk at that moment,
// never to a snapshot the caller took earlier. That is the property the
// callers rely on, and why `mutate` receives the read instead of a value.

import { readConfigFile, writeOwnerOnlyFileAtomic, type ConfigReadResult } from "./config-dir";
import { withFileLock } from "./file-lock";

/** Longest a writer waits for a contended store lock before falling back to compare-before-rename. */
export const CONFIG_UPDATE_LOCK_TIMEOUT_MS = 750;

/** A store lock older than this is treated as abandoned (its holder died mid-update). */
export const CONFIG_UPDATE_LOCK_STALE_MS = 3_000;

/** Attempts the lock-free fallback makes before reporting the update as failed. */
const OPTIMISTIC_ATTEMPTS = 8;

/**
 * What `mutate` returns: the new file body, or `undefined` to leave the file
 * exactly as it is (nothing to change, or the caller refuses to write).
 */
export type ConfigMutation = (current: ConfigReadResult) => string | undefined;

/** `written`: the new body is on disk. `unchanged`: `mutate` declined. `failed`: nothing was written. */
export type ConfigUpdateOutcome = "written" | "unchanged" | "failed";

function sameRead(a: ConfigReadResult, b: ConfigReadResult): boolean {
  if (a.ok && b.ok) return a.text === b.text;
  if (!a.ok && !b.ok) return a.reason === b.reason;
  return false;
}

function applyOnce(file: string, mutate: ConfigMutation, verify: boolean): ConfigUpdateOutcome | "changed" {
  const read = readConfigFile(file);
  const next = mutate(read);
  if (next === undefined) return "unchanged";
  // Without the lock, another writer may have renamed in since our read. An
  // exact content compare, not mtime/size: a same-length write landing in the
  // same millisecond would pass a stat check. The window left between this
  // compare and the rename is microseconds, against the whole read-modify-write
  // that was unguarded before.
  if (verify && !sameRead(read, readConfigFile(file))) return "changed";
  writeOwnerOnlyFileAtomic(file, next);
  return "written";
}

/**
 * Apply `mutate` to the current content of `file` and write the result
 * atomically (owner-only), serialised across processes through `${file}.lock`.
 *
 * `mutate` may run more than once (on the fallback path), always against a
 * fresh read, so it must derive its result from its argument alone and treat
 * any state it records for the caller as overwritten by the last call.
 *
 * The caller creates the parent directory first (`ensureKeryxConfigDir`), so
 * the directory keeps its owner-only mode. Throws what the write throws; never
 * waits longer than {@link CONFIG_UPDATE_LOCK_TIMEOUT_MS} for the lock.
 */
export function updateConfigFile(file: string, mutate: ConfigMutation): ConfigUpdateOutcome {
  const locked = withFileLock(`${file}.lock`, () => applyOnce(file, mutate, false), {
    timeoutMs: CONFIG_UPDATE_LOCK_TIMEOUT_MS,
    staleMs: CONFIG_UPDATE_LOCK_STALE_MS,
  });
  if (locked !== null) return locked as ConfigUpdateOutcome;
  for (let attempt = 0; attempt < OPTIMISTIC_ATTEMPTS; attempt += 1) {
    const outcome = applyOnce(file, mutate, true);
    if (outcome !== "changed") return outcome;
  }
  return "failed";
}

// Lock-protected storage skeleton for a session-local Slate (SLATE-1).
//
// Phase 1 builds and tests the storage primitive only — wiring it into the
// harness's open/close lifecycle (a real session dir, a real attemptId,
// populating anchors/course/seeds with real content) is Phase 2 (SLATE-5)
// and later. See docs/requirements/slate/specification.md's "Data contracts"
// section for the full shape this mirrors.
//
// `slate.json` lives as a sibling file inside the session dir produced by
// `sessionDir()` (src/session/paths.ts) — this module itself takes an
// already-resolved `dir: string` and never re-derives a session path. A
// prior unclosed `slate.json` is archived (never silently overwritten) to
// `slate-archive/<attemptId>.json` before a fresh attempt's first write.
//
// Pure storage over `withFileLock`/`writeFileAtomic` (src/lib/fs.ts) —
// deliberately no dependency on src/sac/* or src/harness/*.

import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { isNotFound, withFileLock, writeFileAtomic } from "../lib/fs";

/**
 * Mirrors `ProposalKind` from `src/sac/proposal-lifecycle.ts`. Duplicated
 * here rather than imported: this module intentionally has no dependency on
 * `src/sac/*`.
 */
export type SlateSeedKind = "decision" | "wiki-update" | "memory-entry" | "follow-up" | "contract-change" | "risk";

export type SlateAnchors = {
  root: string;
  tree?: string;
  runtime?: { provider: string; model: string };
  touched: string[];
  fence?: string[];
};

export type SlateCourse = {
  flowRef?: string;
};

export type SlateSeed = {
  id: string;
  text: string;
  ts: string;
  kind?: SlateSeedKind;
};

export type SlateChildDispatch = {
  anchors: SlateAnchors;
  course: SlateCourse;
  seeds: SlateSeed[];
  status: "completed" | "incomplete";
};

/**
 * Informal, non-normative Slate data contract — see
 * docs/requirements/slate/specification.md's "Data contracts" section.
 * Full shape is present even though only storage is exercised this phase.
 */
export type Slate = {
  workspaceId?: string;
  anchors: SlateAnchors;
  course: SlateCourse;
  seeds: SlateSeed[];
  childDispatches?: Record<string, SlateChildDispatch>;
};

function slatePath(dir: string): string {
  return path.join(dir, "slate.json");
}

function slateLockPath(dir: string): string {
  return `${slatePath(dir)}.lock`;
}

/** Plain read of `slate.json`; `undefined` when it does not exist yet. */
export async function readSlate(dir: string): Promise<Slate | undefined> {
  try {
    const raw = await readFile(slatePath(dir), "utf8");
    return JSON.parse(raw) as Slate;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * Read-modify-write under a single `withFileLock` hold: the read of the
 * current value and the write of `update`'s result happen inside the same
 * lock hold, so a second same-turn writer's `update` always runs against the
 * first writer's already-committed value, never a stale pre-lock read. This
 * is what makes two overlapping `writeSlate` calls against the same session
 * dir never lose data to a read-modify-write race — a plain `write(dir,
 * value)` API without an in-lock read cannot satisfy that.
 */
export async function writeSlate(dir: string, update: (prev: Slate | undefined) => Slate): Promise<Slate> {
  await mkdir(dir, { recursive: true });
  return withFileLock(slateLockPath(dir), async () => {
    const prev = await readSlate(dir);
    const next = update(prev);
    await writeFileAtomic(slatePath(dir), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

/**
 * Archive-on-close primitive: under the same lock, if `slate.json` exists,
 * move its content to `slate-archive/<attemptId>.json` (mkdir the archive
 * dir first, `writeFileAtomic` the archive copy, then `rm` the live file so
 * a mid-crash never leaves both files claiming to be current) — never a
 * silent overwrite. No-op (not an error) when no `slate.json` exists yet.
 *
 * `attemptId` must be a safe filename token (`[A-Za-z0-9._-]+`) — an invalid
 * value is a caller bug (programmer error), not a runtime condition to
 * swallow, so it throws rather than silently no-oping or continuing.
 */
export async function archiveSlate(dir: string, attemptId: string): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(attemptId)) throw new Error(`invalid attemptId: ${JSON.stringify(attemptId)}`);
  await mkdir(dir, { recursive: true });
  return withFileLock(slateLockPath(dir), () => archiveIfExistsLocked(dir, attemptId));
}

/**
 * Same "archive whatever is live, if anything" behavior as `archiveSlate`,
 * but assumes the caller already holds `slateLockPath(dir)`'s lock (used by
 * `openSlateAtomic` below to fold archive-then-write into one lock hold).
 * Not exported: re-entering `withFileLock` on the same lock path from inside
 * itself would deadlock (the lock is a non-reentrant `mkdir`-based mutex),
 * so this must only ever run already-inside a hold, never acquire its own.
 */
async function archiveIfExistsLocked(dir: string, attemptId: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(slatePath(dir), "utf8");
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  const archiveDir = path.join(dir, "slate-archive");
  await mkdir(archiveDir, { recursive: true });
  await writeFileAtomic(path.join(archiveDir, `${attemptId}.json`), raw);
  await rm(slatePath(dir), { force: true });
}

/**
 * Atomic "archive an unclosed prior slate, then write a fresh one" primitive
 * for `openSlate` (`slate-lifecycle.ts`), fixing a concurrency bug (F-001):
 * `openSlate` used to be three SEPARATE lock holds — an unlocked `readSlate`,
 * then a separately-locked `archiveSlate`, then a separately-locked
 * `writeSlate` whose update callback ignored `prev` entirely. Between the
 * archive lock's release and the write lock's re-acquire there was a real
 * window where two concurrent `openSlate` calls against the same session dir
 * could interleave: the second caller's own freshly-archived-and-written
 * slate could be silently clobbered by the first caller's later write, with
 * no archive step ever having seen the discarded state.
 *
 * Folding the "is there an unclosed prior slate?" check, the conditional
 * archive, and the fresh write into ONE `withFileLock` hold closes that
 * window — a second concurrent caller blocks on lock acquisition until the
 * first caller's archive+write has fully committed, then sees the first
 * caller's just-written slate as the "existing" slate it must itself archive
 * (never silently overwrite).
 *
 * `mintAttemptId` is still invoked only when an existing slate is actually
 * found on disk (never speculatively), matching
 * `OpenSlateOptions.mintAttemptId`'s existing contract — `build` is called
 * unconditionally to produce the fresh slate to persist.
 */
export async function openSlateAtomic(dir: string, mintAttemptId: () => string, build: () => Slate): Promise<Slate> {
  await mkdir(dir, { recursive: true });
  return withFileLock(slateLockPath(dir), async () => {
    const existing = await readSlate(dir);
    if (existing !== undefined) {
      await archiveIfExistsLocked(dir, mintAttemptId());
    }
    const next = build();
    await writeFileAtomic(slatePath(dir), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

/**
 * Append-only Seed write (SLATE-4) on top of `writeSlate`'s already-locked
 * read-modify-write. `seed` is a fully-formed `SlateSeed` — this module has
 * no clock/RNG dependency of its own (see the module doc comment), so id/ts
 * minting is the caller's responsibility, not this helper's.
 *
 * Requires an already-open slate: appending a Seed to a session dir with no
 * live `slate.json` is a caller bug (the lifecycle layer must open a slate
 * before any Seed can be written), so this throws rather than silently
 * fabricating a slate with placeholder Anchors.
 */
export async function appendSeed(dir: string, seed: SlateSeed): Promise<Slate> {
  return writeSlate(dir, (prev) => {
    if (!prev) throw new Error(`appendSeed: no open slate in ${dir}`);
    return { ...prev, seeds: [...prev.seeds, seed] };
  });
}

/**
 * Pure Seed dedup for the wrap-up composer (SLATE-4, spec AC-23): two Seeds
 * are duplicates only when their `text` fields are identical after
 * `.trim()` — no similarity/embedding model in v1. Keeps the first
 * occurrence of each distinct trimmed text; does not mutate `seeds`.
 */
export function dedupeSeeds(seeds: SlateSeed[]): SlateSeed[] {
  const seen = new Set<string>();
  const result: SlateSeed[] = [];
  for (const seed of seeds) {
    const key = seed.text.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(seed);
  }
  return result;
}

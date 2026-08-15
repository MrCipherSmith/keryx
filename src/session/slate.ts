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
  return withFileLock(slateLockPath(dir), async () => {
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
  });
}

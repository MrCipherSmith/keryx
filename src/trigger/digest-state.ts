// Flow 389: the on-disk state of a scheduled digest, in the zone that owns schedules.
//
// `trigger/schedules.ts` confirms, resumes and removes stored schedules, and a digest schedule
// carries state next to them (`.metaproject/data/digest/<name>/fired.json`): confirm anchors it,
// resume marks it. That state is plain files and pure helpers, so it lives here, in `src/trigger/`,
// and `src/scheduler/` (the ticker, the snapshot, the delivery queue) imports it. The direction
// is scheduler -> trigger, never the other way: the core `trigger` module must not import a
// client/adapter module.
//
// The ticker (`../scheduler/digest-ticker.ts`) decides WHEN a slot is due; this file only reads and
// writes the claim.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isNotFound, writeFileAtomic } from "../lib/fs";

export function digestDataDir(projectRoot: string): string {
  return path.join(projectRoot, ".metaproject", "data", "digest");
}

/** `.metaproject/data/digest/<schedule>`. The name is a schedule name, already restricted to a safe charset by the store. */
export function digestScheduleDir(projectRoot: string, name: string): string {
  return path.join(digestDataDir(projectRoot), name.replace(/[^A-Za-z0-9._-]/g, "-"));
}

/** Make `.metaproject/data/digest/` ignore everything in it. Idempotent. */
export async function ensureDigestDataIgnored(projectRoot: string): Promise<void> {
  const dir = digestDataDir(projectRoot);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, ".gitignore");
  try {
    await readFile(file, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await writeFile(file, "# Scheduled digest state: snapshots, delivery queue, fired slots. Never committed.\n*\n!.gitignore\n", "utf8");
  }
}

export interface FiredState {
  readonly version: 1;
  /** ISO time of the last slot that was claimed (or, for a new or resumed digest, the moment it was armed). */
  readonly slot: string;
  /** True when a run was started for `slot`; false when `slot` is only the anchor. */
  readonly fired: boolean;
  /** Set while the digest is paused; the next enabled tick re-anchors instead of catching up. */
  readonly pausedAt?: string;
}

export function firedPath(projectRoot: string, name: string): string {
  return path.join(digestScheduleDir(projectRoot, name), "fired.json");
}

export async function readFired(projectRoot: string, name: string): Promise<FiredState | undefined> {
  try {
    const raw = JSON.parse(await readFile(firedPath(projectRoot, name), "utf8")) as Record<string, unknown> | null;
    if (raw !== null && typeof raw["slot"] === "string" && typeof raw["fired"] === "boolean") {
      return { version: 1, slot: raw["slot"], fired: raw["fired"], ...(typeof raw["pausedAt"] === "string" ? { pausedAt: raw["pausedAt"] } : {}) };
    }
    return undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    return undefined;
  }
}

export async function writeFired(projectRoot: string, name: string, state: FiredState): Promise<void> {
  await ensureDigestDataIgnored(projectRoot);
  await writeFileAtomic(firedPath(projectRoot, name), `${JSON.stringify(state, null, 2)}\n`);
}

export function minuteFloor(d: Date): Date {
  const t = new Date(d.getTime());
  t.setSeconds(0, 0);
  return t;
}

/**
 * A new digest is anchored at its creation time, not at the first tick that happens to see it. A cron time
 * between the creation and the first tick (serve was down when the schedule was confirmed) then counts as a
 * missed slot and fires once, the same as any other missed slot. Overwrites a leftover claim of an earlier
 * schedule of the same name: a new schedule owes nothing for the time before it existed.
 */
export async function anchorDigest(projectRoot: string, name: string, at: Date): Promise<void> {
  await writeFired(projectRoot, name, { version: 1, slot: minuteFloor(at).toISOString(), fired: false });
}

/**
 * Resume records that the digest was paused, whether or not a tick saw the pause. A pause that happened while
 * serve was not running leaves no `pausedAt` behind (only a running ticker writes it), so without this the first
 * tick after the resume would take the old anchor for the last claim and fire a catch-up digest. With the mark
 * the next enabled tick re-anchors instead. A digest that was never armed has nothing to mark.
 */
export async function markDigestResumed(projectRoot: string, name: string, at: Date = new Date()): Promise<void> {
  const state = await readFired(projectRoot, name);
  if (state === undefined || state.pausedAt !== undefined) return;
  await writeFired(projectRoot, name, { ...state, pausedAt: at.toISOString() });
}

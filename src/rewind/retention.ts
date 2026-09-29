import type { RewindEntry } from "./manifest";
import { git, type ShadowRepo } from "./shadow";
import { deleteSnapshotRef } from "./snapshot";

export const REWIND_MAX_SNAPSHOTS = 50;

/** Keeps the newest `max` entries by sequence number; the rest are dropped oldest-first. */
export function pruneManifest(entries: readonly RewindEntry[], max: number = REWIND_MAX_SNAPSHOTS): { keep: RewindEntry[]; drop: RewindEntry[] } {
  const ordered = [...entries].sort((left, right) => left.seq - right.seq);
  const cut = Math.max(0, ordered.length - Math.max(1, max));
  return { keep: ordered.slice(cut), drop: ordered.slice(0, cut) };
}

/** Drops the refs of pruned snapshots and lets git discard the objects only they reached. */
export async function enforceRetention(repo: ShadowRepo, entries: readonly RewindEntry[], max: number = REWIND_MAX_SNAPSHOTS): Promise<{ keep: RewindEntry[]; dropped: number }> {
  const { keep, drop } = pruneManifest(entries, max);
  if (drop.length === 0) return { keep, dropped: 0 };
  for (const entry of drop) await deleteSnapshotRef(repo, entry.seq);
  await git(repo, ["prune", "--expire=now"]);
  return { keep, dropped: drop.length };
}

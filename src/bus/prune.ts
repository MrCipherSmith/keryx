// `keryx bus prune` and the lazy clean-up it shares (artifact-lifecycle.md).
//
// Removes:
//   - presence records classified gone (D-09) whose heartbeat is more than 24 h
//     old; live and stale records are never touched;
//   - inactive pause leases (§4.3). Each is re-checked under `append.lock` and
//     only then gets its `lease-expired` event and is deleted, so the event is
//     written exactly once however many pruners race;
//   - rotated log segments beyond the retention bound (2 kept, 7 days).

import { randomUUID } from "node:crypto";
import { pathExists, withFileLock } from "../lib/fs";
import { removeFile } from "./files";
import { holderLivenessFrom, isLeaseActive, listLeases, readLease } from "./leases";
import { appendEvent, pruneRotatedSegments } from "./log";
import { appendLockPath, leasePath } from "./paths";
import { classifyPresence, listPresence, type PresenceClassifyOptions, removePresence } from "./presence";

export const GONE_PRESENCE_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface PruneOptions {
  now?: (() => number) | undefined;
  isAlive?: ((pid: number) => boolean) | undefined;
  host?: string | undefined;
  staleMs?: number | undefined;
}

export interface PruneResult {
  /** Instance ids whose presence record was removed. */
  presence: string[];
  /** Lease ids removed (each with its `lease-expired` event). */
  leases: string[];
  /** Rotated segment files removed. */
  segments: string[];
}

class LeaseStillActive extends Error {}

export async function pruneBus(root: string, options: PruneOptions = {}): Promise<PruneResult> {
  const now = options.now ?? Date.now;
  const classify = (): PresenceClassifyOptions => ({
    now: now(),
    isAlive: options.isAlive,
    host: options.host,
    staleMs: options.staleMs,
  });
  const result: PruneResult = { presence: [], leases: [], segments: [] };

  for (const record of await listPresence(root)) {
    const at = classify();
    if (classifyPresence(record, at) !== "gone") continue;
    if (at.now - Date.parse(record.heartbeatAt) <= GONE_PRESENCE_RETENTION_MS) continue;
    await removePresence(root, record.instanceId);
    result.presence.push(record.instanceId);
  }

  for (const lease of await listLeases(root)) {
    const activity = async () => ({
      now: now(),
      holderLiveness: holderLivenessFrom(await listPresence(root), classify()),
    });
    if (isLeaseActive(lease, await activity())) continue;
    try {
      await appendEvent(
        root,
        {
          from: { instanceId: randomUUID(), name: "system", origin: "system" },
          to: ["*"],
          toLabel: "@all",
          kind: "lease-expired",
          refs: { leaseId: lease.leaseId },
        },
        {
          now,
          // The re-check under the lock is what makes the event exactly-once.
          underLock: async () => {
            const still = await readLease(root, lease.leaseId);
            if (still === undefined || isLeaseActive(still, await activity())) throw new LeaseStillActive();
          },
          afterAppend: () => removeFile(leasePath(root, lease.leaseId)),
        },
      );
      result.leases.push(lease.leaseId);
    } catch (error) {
      if (error instanceof LeaseStillActive) continue;
      throw error;
    }
  }

  if (await pathExists(root)) {
    result.segments = await withFileLock(appendLockPath(root), () => pruneRotatedSegments(root, { now }), {
      timeoutMs: 30_000,
    });
  }
  return result;
}

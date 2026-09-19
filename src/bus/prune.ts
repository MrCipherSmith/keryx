// `keryx bus prune` and the lazy clean-up it shares (artifact-lifecycle.md).
//
// Removes:
//   - presence records classified gone (D-09) whose heartbeat is more than 24 h
//     old; live and stale records are never touched;
//   - inactive pause leases (§4.3). Under `append.lock`, each is re-checked,
//     the log is searched for a `lease-expired` already written for it, and
//     the file is deleted BEFORE the event is appended. So the event is
//     written at most once however many pruners race or crash: a crash after
//     the append leaves an event the next prune finds, a crash or failed
//     delete before it leaves no event and the lease is retried next time;
//   - rotated log segments beyond the retention bound (2 kept, 7 days).

import { randomUUID } from "node:crypto";
import { pathExists, withFileLock } from "../lib/fs";
import { removeFile } from "./files";
import { holderLivenessFrom, isLeaseActive, listLeases, readLease } from "./leases";
import { appendEvent, BUS_LOCK_STALE_MS, cursorAtStart, pruneRotatedSegments, readEvents } from "./log";
import { appendLockPath, leasePath } from "./paths";
import { classifyPresence, listPresence, type PresenceClassifyOptions, removePresence } from "./presence";

export const GONE_PRESENCE_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface PruneOptions {
  now?: (() => number) | undefined;
  isAlive?: ((pid: number) => boolean) | undefined;
  host?: string | undefined;
  staleMs?: number | undefined;
  /** TEST SEAM, never set in production: replaces the lease-file delete. */
  removeLeaseFile?: ((file: string) => Promise<void>) | undefined;
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
class AlreadyExpired extends Error {}

/** True when the retained log already holds a `lease-expired` for `leaseId`. */
async function expiryAlreadyLogged(root: string, leaseId: string): Promise<boolean> {
  const { events } = await readEvents(root, await cursorAtStart(root));
  return events.some((event) => event.kind === "lease-expired" && event.refs?.leaseId === leaseId);
}

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

  const removeLeaseFile = options.removeLeaseFile ?? removeFile;
  for (const lease of await listLeases(root)) {
    const activity = async () => ({
      now: now(),
      holderLiveness: holderLivenessFrom(await listPresence(root), classify()),
    });
    if (isLeaseActive(lease, await activity())) continue;
    const file = leasePath(root, lease.leaseId);
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
          // All under the one lock hold, in this order (review r1 F4):
          underLock: async () => {
            // 1. still there and still inactive;
            const still = await readLease(root, lease.leaseId);
            if (still === undefined || isLeaseActive(still, await activity())) throw new LeaseStillActive();
            // 2. an earlier prune that crashed after its append: only the file is left;
            if (await expiryAlreadyLogged(root, lease.leaseId)) {
              await removeLeaseFile(file);
              throw new AlreadyExpired();
            }
            // 3. delete first; a failed delete throws here and nothing is appended.
            await removeLeaseFile(file);
          },
        },
      );
      result.leases.push(lease.leaseId);
    } catch (error) {
      if (error instanceof LeaseStillActive) continue;
      if (error instanceof AlreadyExpired) {
        result.leases.push(lease.leaseId);
        continue;
      }
      throw error;
    }
  }

  if (await pathExists(root)) {
    result.segments = await withFileLock(appendLockPath(root), () => pruneRotatedSegments(root, { now }), {
      timeoutMs: 30_000,
      staleMs: BUS_LOCK_STALE_MS,
    });
  }
  return result;
}

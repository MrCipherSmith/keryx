// Pause leases, read side (specification §4.3, decisions D-03 and D-09).
//
// Writing leases is P4. P1 lists them and applies the active rule, which both
// `keryx bus list` and `keryx bus prune` need:
//
//   active = the file exists
//        AND now < expiresAt
//        AND (the holder is not gone OR the holder's origin is `cli`)
//
// A stale holder keeps its lease. A CLI holder has no presence and is bounded
// by the TTL alone.

import { listDirNames, readJsonRecord } from "./files";
import { idFromRecordFileName, isBusId, leasePath, leasesDir } from "./paths";
import { classifyPresence, type PresenceClassifyOptions, type PresenceLiveness } from "./presence";
import { type PauseLease, parsePauseLease, type PresenceRecord } from "./schema";

export interface LeaseActivityOptions {
  /** Clock in epoch ms. */
  now: number;
  /** D-09 liveness of the holder instance; see `holderLivenessFrom`. */
  holderLiveness: (holderInstanceId: string) => PresenceLiveness;
}

/**
 * A holder-liveness function over a presence listing: a holder with no
 * presence record is gone (it exited, or its record was pruned).
 */
export function holderLivenessFrom(
  presence: readonly PresenceRecord[],
  options: PresenceClassifyOptions,
): (holderInstanceId: string) => PresenceLiveness {
  const byId = new Map(presence.map((record) => [record.instanceId, record]));
  return (holderInstanceId) => {
    const record = byId.get(holderInstanceId);
    return record === undefined ? "gone" : classifyPresence(record, options);
  };
}

export function isLeaseActive(lease: PauseLease, options: LeaseActivityOptions): boolean {
  const expiresAt = Date.parse(lease.expiresAt);
  if (Number.isNaN(expiresAt) || options.now >= expiresAt) return false;
  if (lease.holder.origin === "cli") return true;
  return options.holderLiveness(lease.holder.instanceId) !== "gone";
}

/** The lease with `leaseId`, or undefined when absent or invalid. Never throws. */
export async function readLease(root: string, leaseId: string): Promise<PauseLease | undefined> {
  if (!isBusId(leaseId)) return undefined;
  try {
    const lease = parsePauseLease(await readJsonRecord(leasePath(root, leaseId)));
    return lease !== undefined && lease.leaseId === leaseId ? lease : undefined;
  } catch {
    return undefined;
  }
}

/** Every valid lease file, active or not, oldest first. Invalid files are skipped. Never throws. */
export async function listLeases(root: string): Promise<PauseLease[]> {
  let names: string[];
  try {
    names = await listDirNames(leasesDir(root));
  } catch {
    return [];
  }
  const leases: PauseLease[] = [];
  for (const fileName of names) {
    const id = idFromRecordFileName(fileName);
    if (id === undefined) continue;
    const lease = await readLease(root, id);
    if (lease !== undefined) leases.push(lease);
  }
  return leases.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.leaseId.localeCompare(b.leaseId));
}

/** The leases that are active now under the §4.3 rule. */
export async function listActiveLeases(root: string, options: LeaseActivityOptions): Promise<PauseLease[]> {
  return (await listLeases(root)).filter((lease) => isLeaseActive(lease, options));
}

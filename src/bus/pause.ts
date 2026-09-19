// Pause leases, write side (specification §4.3, §4.4, §5.4; decisions D-03,
// D-09, D-12).
//
// The read side — `isLeaseActive`, `listActiveLeases`, `holderLivenessFrom` —
// lives in `./leases.ts`; the exactly-once `lease-expired` write on natural
// expiry lives in `./prune.ts`. This module owns the three lease-holder
// actions (`createPauseLease`, `resumePauseLease`, `overridePauseLease`) and
// `createLeaseView`, a small cached reader the TUI, readline and agent
// surfaces poll to answer "does a lease apply to me right now" without
// re-listing `leases/` on every check.
//
// `createPauseLease` writes the lease file together with its `pause-request`
// event under one `append.lock` hold (§4.3): the two checks that can refuse
// the request — one active lease per holder, and at most one active
// CLI-origin lease per clone (D-12) — run inside `appendEvent`'s `underLock`,
// so a concurrent second request cannot slip past either bound. The file
// itself is written from `afterAppend`, which `./log.ts` runs under the SAME
// lock hold, right after the event's line and `head.json` land; nothing
// written by this call is ever visible to another writer without the event
// also being visible. `writeBusFileAtomic` (temp file + rename) means the
// file write itself cannot leave a half-written lease behind; the guard below
// only covers the pathological case where the atomic write throws after some
// side effect regardless — a currently-unreachable belt worn alongside the
// suspenders.

import { randomUUID } from "node:crypto";
import { BusRefusal } from "./errors";
import { ensureBusDir, removeFile, writeBusFileAtomic } from "./files";
import { holderLivenessFrom, isLeaseActive, listLeases, readLease, type LeaseActivityOptions } from "./leases";
import { appendEvent } from "./log";
import { isBusId, leasePath, leasesDir } from "./paths";
import { listPresence, type PresenceClassifyOptions, type PresenceLiveness } from "./presence";
import { resolveRecipients } from "./send";
import { MAX_LEASE_TTL_MS, type LeaseScope, type PauseLease } from "./schema";
import { displaySafe } from "./display";

/** specification §4.3: the default TTL is 30 minutes. */
export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;
/** specification §4.3 / this dispatch's contract: the minimum TTL is 1 minute. */
export const MIN_LEASE_TTL_MS = 60 * 1000;
export { MAX_LEASE_TTL_MS };

/** The three origins a lease HOLDER may have (`LEASE_HOLDER_ORIGINS`, schema.ts). */
export type PauseLeaseHolderOrigin = PauseLease["holder"]["origin"];

/** Identity of a lease holder, or of whoever is acting on a lease (`resume`'s `by`). */
export interface PauseLeaseActor {
  instanceId: string;
  name: string;
  origin: PauseLeaseHolderOrigin;
}

export interface CreatePauseLeaseInput {
  holder: PauseLeaseActor;
  /** `@<name>` or `@all` — the address as the caller typed it. */
  toLabel: string;
  scope: LeaseScope;
  /** Defaults to {@link DEFAULT_LEASE_TTL_MS}; refused outside [{@link MIN_LEASE_TTL_MS}, {@link MAX_LEASE_TTL_MS}]. */
  ttlMs?: number;
  reason: string;
  now?: () => number;
  /** D-09 inputs for recipient/holder liveness; defaults to this host and `processIsAlive`. */
  liveness?: Omit<PresenceClassifyOptions, "now">;
}

export interface ResumePauseLeaseInput {
  leaseId: string;
  by: PauseLeaseActor;
  now?: () => number;
}

export interface OverridePauseLeaseInput {
  leaseId: string;
  /** Only `instanceId` is used (the target instance releasing itself); kept as the full actor shape for symmetry with `resume`. */
  by: Pick<PauseLeaseActor, "instanceId">;
  now?: () => number;
}

/** Sentinel used to unwind `appendEvent` without surfacing an error: the lease was already gone before this call took effect. */
class LeaseAlreadyGone extends Error {}

/**
 * Display label for a `resume` event, addressed like the lease's own
 * `targets` (specification §4.2's `resume` row: "wakes: yes" — the targets
 * that were held are exactly who should wake up now). `["*"]` is `@all`; a
 * single concrete target's CURRENT name is looked up from presence (it may
 * have renamed since the lease was created) and falls back to `@all` when it
 * cannot be resolved — `toLabel` is a display-only field, so an imprecise
 * fallback here costs nothing functional (`to` is what actually routes it).
 */
async function resumeToLabel(root: string, targets: readonly string[]): Promise<string> {
  if (targets.length !== 1 || targets[0] === "*") return "@all";
  const holderId = targets[0] as string;
  const record = (await listPresence(root)).find((p) => p.instanceId === holderId);
  return record !== undefined ? `@${record.name}` : "@all";
}

/**
 * Create a pause lease and its `pause-request` event together, under one
 * `append.lock` hold (specification §4.3).
 *
 * Refuses:
 * - `ttl-out-of-range` — `ttlMs` outside [{@link MIN_LEASE_TTL_MS}, {@link MAX_LEASE_TTL_MS}];
 * - `unknown-recipient` / `recipient-not-live` — from resolving `toLabel` (`./send.ts`'s `resolveRecipients`);
 * - `recipient-is-self` — `toLabel` resolves only to the holder's own instance;
 * - `lease-already-held` — this holder already has an active lease, or (holder
 *   origin `cli`) another CLI-origin lease is already active anywhere in the clone.
 *
 * `@all` is stored as `["*"]` (read dynamically as "every instance but the
 * holder" by `isOverridable` below); an explicit `@name` is refused up front
 * when it resolves only to the holder itself.
 */
export async function createPauseLease(root: string, input: CreatePauseLeaseInput): Promise<PauseLease> {
  const now = input.now ?? Date.now;
  const ttlMs = input.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs < MIN_LEASE_TTL_MS || ttlMs > MAX_LEASE_TTL_MS) {
    throw new BusRefusal(
      "ttl-out-of-range",
      `ttl ${ttlMs}ms must be between ${MIN_LEASE_TTL_MS}ms (1 min) and ${MAX_LEASE_TTL_MS}ms (4 h)`,
    );
  }

  const resolveOptions: PresenceClassifyOptions = { ...input.liveness, now: now() };
  const targets = await resolveRecipients(root, input.toLabel, resolveOptions);
  if (targets.length === 1 && targets[0] === input.holder.instanceId) {
    throw new BusRefusal("recipient-is-self", `${input.toLabel} resolves only to this instance`);
  }

  const leaseId = randomUUID();
  let fileWritten = false;
  let lease: PauseLease | undefined;

  try {
    await appendEvent(
      root,
      {
        from: { instanceId: input.holder.instanceId, name: input.holder.name, origin: input.holder.origin },
        to: targets,
        toLabel: input.toLabel,
        kind: "pause-request",
        body: input.reason,
        refs: { leaseId },
      },
      {
        now,
        underLock: async () => {
          const presence = await listPresence(root);
          const holderLiveness = holderLivenessFrom(presence, { ...input.liveness, now: now() });
          const activity: LeaseActivityOptions = { now: now(), holderLiveness };
          const existing = await listLeases(root);
          if (existing.some((l) => l.holder.instanceId === input.holder.instanceId && isLeaseActive(l, activity))) {
            throw new BusRefusal("lease-already-held", `${input.holder.name} already holds an active pause lease`);
          }
          if (
            input.holder.origin === "cli" &&
            existing.some((l) => l.holder.origin === "cli" && isLeaseActive(l, activity))
          ) {
            throw new BusRefusal("lease-already-held", "a CLI-origin pause lease is already active in this clone");
          }
        },
        afterAppend: async (event) => {
          const draft: PauseLease = {
            schemaVersion: 1,
            leaseId,
            holder: { instanceId: input.holder.instanceId, name: input.holder.name, origin: input.holder.origin },
            targets,
            scope: input.scope,
            reason: input.reason,
            createdAt: event.ts,
            expiresAt: new Date(Date.parse(event.ts) + ttlMs).toISOString(),
            requestEventSeq: event.seq,
          };
          await ensureBusDir(root);
          await ensureBusDir(leasesDir(root));
          await writeBusFileAtomic(leasePath(root, leaseId), `${JSON.stringify(draft)}\n`);
          fileWritten = true;
          lease = draft;
        },
      },
    );
  } catch (error) {
    // The event and the file land together: if anything after the file write
    // started went wrong regardless, do not leave a partial file behind.
    if (fileWritten) await removeFile(leasePath(root, leaseId)).catch(() => {});
    throw error;
  }

  return lease as PauseLease;
}

/**
 * End a lease: append `resume` and delete its file, under `append.lock`
 * (specification §4.3, §5.4). Allowed only for the holder itself
 * (`by.instanceId === holder.instanceId`) or an operator acting through the
 * CLI (`by.origin === "cli"`, D-13's escape hatch) — anyone else is refused
 * `not-lease-holder`. Idempotent: resuming a lease that is already gone (this
 * call, a concurrent resume, expiry, or prune) is a silent no-op, never a
 * refusal.
 */
export async function resumePauseLease(root: string, input: ResumePauseLeaseInput): Promise<void> {
  if (!isBusId(input.leaseId)) {
    throw new BusRefusal("invalid-id", `leaseId ${JSON.stringify(input.leaseId)} is not a UUID`);
  }
  const now = input.now ?? Date.now;
  const lease = await readLease(root, input.leaseId);
  if (lease === undefined) return; // already ended: idempotent

  if (lease.holder.instanceId !== input.by.instanceId && input.by.origin !== "cli") {
    throw new BusRefusal(
      "not-lease-holder",
      `only ${lease.holder.name}, or an operator through the CLI, may resume this lease`,
    );
  }

  try {
    const toLabel = await resumeToLabel(root, lease.targets);
    await appendEvent(
      root,
      {
        from: { instanceId: input.by.instanceId, name: input.by.name, origin: input.by.origin },
        to: lease.targets,
        toLabel,
        kind: "resume",
        refs: { leaseId: input.leaseId },
      },
      {
        now,
        underLock: async () => {
          const still = await readLease(root, input.leaseId);
          if (still === undefined) throw new LeaseAlreadyGone();
        },
        afterAppend: async () => {
          await removeFile(leasePath(root, input.leaseId));
        },
      },
    );
  } catch (error) {
    if (error instanceof LeaseAlreadyGone) return;
    throw error;
  }
}

/**
 * Release ONE target from a lease without ending it for the others
 * (specification §4.3, D-03): appends `override` — `from.origin: "system"`
 * (the schema requires it for this kind), `refs.leaseId`, addressed to the
 * lease's HOLDER so they are informed — and does NOT delete the file, which
 * stays active for every other target. `by.instanceId` is carried as the
 * event's `from.instanceId` for traceability, with `from.name: "system"` so
 * the sender shape stays valid whatever name the overriding instance holds.
 * A no-op when the lease is already gone.
 */
export async function overridePauseLease(root: string, input: OverridePauseLeaseInput): Promise<void> {
  if (!isBusId(input.leaseId)) {
    throw new BusRefusal("invalid-id", `leaseId ${JSON.stringify(input.leaseId)} is not a UUID`);
  }
  const now = input.now ?? Date.now;
  const lease = await readLease(root, input.leaseId);
  if (lease === undefined) return;

  await appendEvent(
    root,
    {
      from: { instanceId: input.by.instanceId, name: "system", origin: "system" },
      to: [lease.holder.instanceId],
      toLabel: `@${lease.holder.name}`,
      kind: "override",
      refs: { leaseId: input.leaseId },
    },
    { now },
  );
}

// ---------------------------------------------------------------------------
// createLeaseView: a cached reader over `leases/`, refreshed by the caller
// (the TUI/readline poll loop, or a test) rather than on every call.
// ---------------------------------------------------------------------------

export interface LeaseViewOptions {
  root: string;
  instanceId: string;
  now?: () => number;
  /** D-09 inputs for holder liveness; defaults to this host and `processIsAlive`. */
  liveness?: Omit<PresenceClassifyOptions, "now">;
}

export interface PauseLeaseView {
  /** Re-lists `leases/` and re-applies the §4.3 active rule. Never throws. */
  refresh(): Promise<void>;
  /**
   * An active lease of this `scope` targets this instance (`*` counts unless
   * this instance is the holder) and this instance has not overridden it.
   */
  appliesToMe(scope: LeaseScope): boolean;
  /** `appliesToMe("turns")`. */
  held(): boolean;
  /** The `turns` lease currently held against this instance, if any. */
  heldBy(): PauseLease | undefined;
  /** A display-ready banner for the held lease, or undefined when not held. */
  banner(): string | undefined;
  /** Release THIS instance from `leaseId`: records the override locally and in the log. */
  override(leaseId: string): Promise<void>;
  /** This instance's own active leases (as holder). */
  myLeases(): PauseLease[];
}

function targetsInstance(lease: PauseLease, instanceId: string): boolean {
  return lease.targets.includes(instanceId) || (lease.targets.length === 1 && lease.targets[0] === "*");
}

/** Minutes remaining, rounded up, never negative — what the banner shows. */
function minutesLeft(lease: PauseLease, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(lease.expiresAt) - now) / 60_000));
}

export function createLeaseView(options: LeaseViewOptions): PauseLeaseView {
  const now = options.now ?? Date.now;
  const overridden = new Set<string>();
  let active: PauseLease[] = [];

  const classify = (): PresenceClassifyOptions => ({ ...options.liveness, now: now() });

  // D-03: a lease never applies to its own holder, even when it targets
  // "*" — @all is read dynamically as "every instance but the holder".
  const isOverridable = (lease: PauseLease): boolean =>
    lease.holder.instanceId !== options.instanceId &&
    targetsInstance(lease, options.instanceId) &&
    !overridden.has(lease.leaseId);

  return {
    async refresh() {
      const [leases, presence] = await Promise.all([listLeases(options.root), listPresence(options.root)]);
      const holderLiveness = holderLivenessFrom(presence, classify());
      const activity: LeaseActivityOptions = { now: now(), holderLiveness };
      active = leases.filter((lease) => isLeaseActive(lease, activity));
    },
    appliesToMe(scope) {
      return active.some((lease) => lease.scope === scope && isOverridable(lease));
    },
    held() {
      return this.appliesToMe("turns");
    },
    heldBy() {
      return active.find((lease) => lease.scope === "turns" && isOverridable(lease));
    },
    banner() {
      const lease = this.heldBy();
      if (lease === undefined) return undefined;
      const minutes = minutesLeft(lease, now());
      return displaySafe(
        `⏸ turns held by @${lease.holder.name} — "${lease.reason}" — ${minutes}m left · /bus override to continue`,
      );
    },
    async override(leaseId) {
      overridden.add(leaseId);
      await overridePauseLease(options.root, { leaseId, by: { instanceId: options.instanceId }, now });
    },
    myLeases() {
      return active.filter((lease) => lease.holder.instanceId === options.instanceId);
    },
  };
}

// Re-exported so a caller of `createLeaseView` never needs its own import of
// `./presence` just to build the `liveness` option's shape.
export type { PresenceLiveness };

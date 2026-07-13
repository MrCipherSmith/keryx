// Release 1 append-only branching (flow 012, W9 / B-01).
//
// `forkBranch` records a new session-tree branch as an append-only
// `branch_metadata` marker entry (a child of an immutable `forkEntryId`) plus a
// deep-frozen `BranchMetadata` record. It is DETERMINISTIC (clock + id source
// injected via `deps`; never `Date.now`/`Math.random`), OFFLINE (no socket, no
// filesystem), and PURE with respect to the input `snapshot` — it never pushes
// into `snapshot.entries` nor mutates `snapshot.manifest`; the caller persists
// the returned `entry` (e.g. via the W8 `SessionStore.append`).
//
// Ancestry: `immutableAncestorIds` is INCLUSIVE of `forkEntryId`, walking back
// through `causal.parentEventId` to the root. For a root fork this is
// `[forkEntryId]` — still non-empty, satisfying the frozen schema's
// `nonEmptyStringArray`. A deeper fork's ancestor set is therefore always a
// superset of a shallower fork's ancestor set from the same chain.
//
// Merge is EXCLUDED from v1 (no-merge-v1, AC2): `mergeBranches` always returns a
// typed `{ kind: "rejected", reason }` and mutates nothing.
//
// Reuses (unmodified): W7 `session/types.ts` (SessionEntry / SessionEntryPayload
// `branch_metadata` variant), W8 `resume/store.ts` (SessionSnapshot), and
// `node:crypto` for content-addressed ids/hashes.
import { createHash } from "node:crypto";
import type { SessionSnapshot } from "../resume/store";
import type { ArtifactRef, SessionEntry, SessionEntryCausal, SessionEntryPayload } from "../session/types";

/** Every durable harness contract in Release 0/1 is schemaVersion 1. */
const SCHEMA_VERSION = 1;

/** Injected non-determinism: a fixed clock and a monotonic id source. */
export interface BranchDeps {
  clock: () => string;
  idSeq: () => string;
}

/**
 * A deep-frozen, append-only branch record. Mirrors `branch-metadata.schema.json`
 * (schemaVersion / branchId / sessionId / forkEntryId / leafEntryId /
 * immutableAncestorIds / createdAt). `immutableAncestorIds` is inclusive of
 * `forkEntryId`; `leafEntryId` is the entryId of the appended `branch_metadata`
 * marker entry.
 */
export interface BranchMetadata {
  schemaVersion: number;
  branchId: string;
  sessionId: string;
  forkEntryId: string;
  leafEntryId: string;
  immutableAncestorIds: readonly string[];
  createdAt: string;
}

/** Input for {@link forkBranch}: the source snapshot plus the fork coordinates. */
export interface ForkBranchInput {
  snapshot: SessionSnapshot;
  sessionId: string;
  forkEntryId: string;
  /** Optional; a deterministic non-empty id is generated when omitted. */
  branchId?: string;
}

/** The result of forking: the branch record and the marker entry to persist. */
export interface ForkBranchResult {
  branch: BranchMetadata;
  entry: SessionEntry;
}

/**
 * The v1 merge decision. Merge is excluded from Release 1, so the only variant is
 * a typed rejection carrying a non-empty human-readable `reason`.
 */
export type MergeDecision = { kind: "rejected"; reason: string };

// Stable, key-sorted serialization so a content fingerprint is independent of
// property insertion order. Mirrors the W7 session `canonicalStringify`.
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// Deep-freeze mirroring the W7 `session.ts` convention: recursively freeze nested
// objects/arrays so a returned record cannot be mutated in place.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Walk from `forkEntryId` back to the root through `causal.parentEventId`,
 * returning the ancestor ids INCLUSIVE of `forkEntryId` (fork-first). A missing
 * `forkEntryId` still yields `[forkEntryId]` (non-empty); a cycle terminates via
 * the `seen` guard.
 */
function collectAncestorIds(snapshot: SessionSnapshot, forkEntryId: string): string[] {
  const byId = new Map<string, SessionEntry>();
  for (const entry of snapshot.entries) {
    byId.set(entry.entryId, entry);
  }

  const ancestors: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = forkEntryId;
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    ancestors.push(cursor);
    const parentId: string | undefined = byId.get(cursor)?.causal.parentEventId;
    cursor = typeof parentId === "string" && parentId.length > 0 ? parentId : undefined;
  }
  return ancestors;
}

/**
 * Fork a new branch at the immutable `forkEntryId`. Returns a deep-frozen
 * {@link BranchMetadata} plus the append-only `branch_metadata` marker
 * {@link SessionEntry} whose `entryId` becomes the branch's leaf. Pure with
 * respect to `input.snapshot`; the caller persists `result.entry`.
 */
export function forkBranch(input: ForkBranchInput, deps: BranchDeps): ForkBranchResult {
  const { snapshot, sessionId, forkEntryId } = input;
  const branchId = input.branchId ?? `branch-${deps.idSeq()}`;
  const createdAt = deps.clock();
  const immutableAncestorIds = collectAncestorIds(snapshot, forkEntryId);

  // Content-address the branch metadata artifact over the STABLE fork identity
  // (never the leaf, which is derived from this payload) so there is no cycle.
  const artifactHash = sha256(
    canonicalStringify({ schemaVersion: SCHEMA_VERSION, branchId, sessionId, forkEntryId, immutableAncestorIds, createdAt }),
  );
  const artifactRef: ArtifactRef = {
    artifactId: `branch-metadata:${branchId}`,
    kind: "branch_metadata",
    hash: artifactHash,
  };

  const payload: SessionEntryPayload = { type: "branch_metadata", artifactRef };

  // Content-addressed entryId, mirroring the W7 session content key (payload +
  // parent). Deterministic and stable across identical inputs.
  const entryId = sha256(canonicalStringify({ entry: payload, parentEventId: forkEntryId }));

  const causal: SessionEntryCausal = {
    runId: snapshot.manifest.runId,
    sessionId,
    correlationId: deps.idSeq(),
    parentEventId: forkEntryId,
  };
  if (branchId.length > 0) causal.branchId = branchId;

  const entry = deepFreeze<SessionEntry>({
    schemaVersion: SCHEMA_VERSION,
    entryId,
    sequence: snapshot.entries.length,
    timestamp: createdAt,
    causal,
    entry: payload,
  });

  const branch = deepFreeze<BranchMetadata>({
    schemaVersion: SCHEMA_VERSION,
    branchId,
    sessionId,
    forkEntryId,
    leafEntryId: entryId,
    immutableAncestorIds,
    createdAt,
  });

  return { branch, entry };
}

/** The active leaf entryId for `branch` — its appended `branch_metadata` marker. */
export function currentLeaf(branch: BranchMetadata): string {
  return branch.leafEntryId;
}

/**
 * no-merge-v1 (AC2): merge is excluded from Release 1. Always returns a typed
 * rejection with a non-empty reason and mutates neither input branch nor any
 * underlying snapshot.
 */
export function mergeBranches(_a: BranchMetadata, _b: BranchMetadata): MergeDecision {
  return {
    kind: "rejected",
    reason: "Branch merge is excluded from Release 1 (no-merge-v1): reconcile branches by re-forking from a shared immutable ancestor.",
  };
}

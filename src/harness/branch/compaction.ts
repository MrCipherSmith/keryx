// Release 1 typed compaction (flow 012, W9 / B-02).
//
// `compact` records context compaction as an append-only, NON-authoritative
// derived record: a typed `CompactionEntry` (provenance over the compacted
// source range, the summary hash, and the evidence-ledger cursor) plus one new
// `compaction` marker `SessionEntry` whose `entryId` becomes the compaction's
// `derivedEntryId`. It is DETERMINISTIC (clock + id source injected via `deps`;
// never `Date.now`/`Math.random`), OFFLINE (no socket, no filesystem), and PURE
// with respect to the input `snapshot` — it never pushes into `snapshot.entries`
// nor mutates `snapshot.manifest`, and it never rewrites a source entry. The
// caller persists the returned `entry` (e.g. via the W8 `SessionStore.append`).
//
// Evidence/history preservation (SC_R06): the derived summary is an ADDITIONAL
// record, never a replacement, so no source or evidence entry is deleted or
// promoted. `assertEvidencePreserved` enforces this at the call site — every
// pre-compaction entry (not only `evidence_link`-typed ones) must still be
// present after compaction, else `EvidenceDeletionError` is thrown.
//
// Rebuild (SC_R07): `rebuildBoundedContext` re-derives the addressable project
// scope (the compaction's `sourceEntryIds`) and evidence ids (the `artifactId`
// of every `evidence_link` entry in the snapshot) as a deduplicated,
// order-stable `references` list, carrying the `summaryHash` through unchanged.
//
// Reuses (unmodified): W7 `session/types.ts` (SessionEntry / SessionEntryPayload
// `compaction`/`evidence_link` variants, ArtifactRef), W8 `resume/store.ts`
// (SessionSnapshot), B-01 `branch.ts` patterns, and `node:crypto` for
// content-addressed ids/hashes.
import { createHash } from "node:crypto";
import type { SessionSnapshot } from "../resume/store";
import type { ArtifactRef, SessionEntry, SessionEntryCausal, SessionEntryPayload } from "../session/types";

/** Every durable harness contract in Release 0/1 is schemaVersion 1. */
const SCHEMA_VERSION = 1;

/** Injected non-determinism: a fixed clock and a monotonic id source. */
export interface CompactionDeps {
  clock: () => string;
  idSeq: () => string;
}

/**
 * A deep-frozen, append-only typed compaction record. Mirrors
 * `compaction-entry.schema.json` (schemaVersion / compactionId / sessionId /
 * sourceEntryIds / derivedEntryId / summaryHash / evidenceLedgerCursor /
 * createdAt). `sourceEntryIds` is the compacted source range; `derivedEntryId`
 * is the entryId of the appended `compaction` marker entry; `summaryHash` is
 * the plain sha256 of the summary text; `evidenceLedgerCursor` is retained so
 * the evidence ledger stays addressable after compaction.
 */
export interface CompactionEntry {
  schemaVersion: number;
  compactionId: string;
  sessionId: string;
  sourceEntryIds: readonly string[];
  derivedEntryId: string;
  summaryHash: string;
  evidenceLedgerCursor: number;
  createdAt: string;
}

/** Input for {@link compact}: the source snapshot plus the compaction coordinates. */
export interface CompactInput {
  snapshot: SessionSnapshot;
  sessionId: string;
  /** The compacted source range (entryIds), in caller-supplied order. */
  sourceEntryIds: string[];
  /** The non-authoritative, derived summary text; hashed, never trusted. */
  summary: string;
  /** The evidence-ledger cursor retained through compaction. */
  evidenceLedgerCursor: number;
}

/** The result of compacting: the typed record and the marker entry to persist. */
export interface CompactResult {
  compaction: CompactionEntry;
  entry: SessionEntry;
}

/** Input for {@link rebuildBoundedContext}: the snapshot plus a compaction record. */
export interface RebuildContextInput {
  snapshot: SessionSnapshot;
  compaction: CompactionEntry;
}

/** The rebuilt bounded context: addressable references + the carried summary hash. */
export interface RebuildContextResult {
  references: string[];
  summaryHash: string;
}

/**
 * Raised when a post-compaction entry set drops a pre-compaction entry — i.e.
 * evidence or history was deleted. Compaction is append-only, so this is always
 * a contract violation.
 */
export class EvidenceDeletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceDeletionError";
  }
}

// Stable, key-sorted serialization so a content fingerprint is independent of
// property insertion order. Mirrors the W7 session / B-01 `canonicalStringify`.
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

// Deep-freeze mirroring the W7 `session.ts` / B-01 convention: recursively freeze
// nested objects/arrays so a returned record cannot be mutated in place.
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
 * Compact the `sourceEntryIds` range into one typed, append-only derived record.
 * Returns a deep-frozen {@link CompactionEntry} plus the `compaction` marker
 * {@link SessionEntry} whose `entryId` is the compaction's `derivedEntryId`.
 * Pure with respect to `input.snapshot`; the caller persists `result.entry`.
 * The derived summary is non-authoritative — no source entry is rewritten.
 */
export function compact(input: CompactInput, deps: CompactionDeps): CompactResult {
  const { snapshot, sessionId, sourceEntryIds, summary, evidenceLedgerCursor } = input;
  const createdAt = deps.clock();

  // Plain sha256 of the raw UTF-8 summary text — independent of sourceEntryIds
  // order and of injected clock/id output (T7 binding #1).
  const summaryHash = sha256(summary);

  // Content-address the compaction identity over its STABLE fields (never the
  // derived entryId, which is computed from this payload) so there is no cycle
  // and the id is stable across identically-seeded deterministic calls.
  const compactionId = `compaction:${sha256(
    canonicalStringify({
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      sourceEntryIds,
      summaryHash,
      evidenceLedgerCursor,
      createdAt,
    }),
  )}`;

  // The artifact hash covers the same stable identity (excludes derivedEntryId
  // to avoid a cycle: derivedEntryId is derived from this artifactRef).
  const artifactHash = sha256(
    canonicalStringify({
      schemaVersion: SCHEMA_VERSION,
      compactionId,
      sessionId,
      sourceEntryIds,
      summaryHash,
      evidenceLedgerCursor,
      createdAt,
    }),
  );
  const artifactRef: ArtifactRef = {
    artifactId: compactionId,
    kind: "compaction",
    hash: artifactHash,
  };

  const payload: SessionEntryPayload = { type: "compaction", artifactRef };

  // Parent the derived marker on the newest source entry (append-only, at the
  // tip of the compacted range) when present; a root compaction has none.
  const parentEventId = sourceEntryIds.length > 0 ? sourceEntryIds[sourceEntryIds.length - 1] : undefined;

  // Content-addressed entryId, mirroring the W7 session / B-01 content key
  // (payload + parent). Deterministic and stable across identical inputs.
  const entryId = sha256(canonicalStringify({ entry: payload, parentEventId }));

  const causal: SessionEntryCausal = {
    runId: snapshot.manifest.runId,
    sessionId,
    correlationId: deps.idSeq(),
  };
  if (parentEventId !== undefined && parentEventId.length > 0) causal.parentEventId = parentEventId;

  const entry = deepFreeze<SessionEntry>({
    schemaVersion: SCHEMA_VERSION,
    entryId,
    sequence: snapshot.entries.length,
    timestamp: createdAt,
    causal,
    entry: payload,
  });

  const compaction = deepFreeze<CompactionEntry>({
    schemaVersion: SCHEMA_VERSION,
    compactionId,
    sessionId,
    sourceEntryIds: [...sourceEntryIds],
    derivedEntryId: entryId,
    summaryHash,
    evidenceLedgerCursor,
    createdAt,
  });

  return { compaction, entry };
}

/**
 * Enforce that compaction deleted no history: every entry present in
 * `before.entries` (not only `evidence_link`-typed ones) must still be present,
 * by entryId, in `afterEntries`. Throws {@link EvidenceDeletionError} on the
 * first missing entry. Append-only additions to `afterEntries` are permitted.
 */
export function assertEvidencePreserved(before: SessionSnapshot, afterEntries: SessionEntry[]): void {
  const afterIds = new Set(afterEntries.map((entry) => entry.entryId));
  for (const entry of before.entries) {
    if (!afterIds.has(entry.entryId)) {
      throw new EvidenceDeletionError(
        `Compaction must not delete history: pre-compaction entry "${entry.entryId}" is missing from the post-compaction entries.`,
      );
    }
  }
}

/**
 * Rebuild the bounded context addressable after compaction (SC_R07). Returns
 * `references` = the deduplicated, order-stable union of the compaction's
 * `sourceEntryIds` (the project scope / source range) and the `artifactId` of
 * every `evidence_link` entry in the snapshot (the evidence ids), plus the
 * compaction's `summaryHash` unchanged. Deterministic: identical input yields a
 * deep-equal result regardless of the injected clock.
 */
export function rebuildBoundedContext(
  input: RebuildContextInput,
  _deps: { clock: () => string },
): RebuildContextResult {
  const { snapshot, compaction } = input;

  const references: string[] = [];
  const seen = new Set<string>();
  const add = (reference: string): void => {
    if (!seen.has(reference)) {
      seen.add(reference);
      references.push(reference);
    }
  };

  for (const id of compaction.sourceEntryIds) {
    add(id);
  }
  for (const entry of snapshot.entries) {
    if (entry.entry.type === "evidence_link") {
      add(entry.entry.artifactRef.artifactId);
    }
  }

  return { references, summaryHash: compaction.summaryHash };
}

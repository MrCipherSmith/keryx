// Durable-resume session store (flow 011, W8 / RS-01, R0-02).
//
// A `SessionStore` is the durable boundary a resume reads its prior
// `(manifest, entries, checkpoint?)` snapshot from. `InMemorySessionStore` is the
// deterministic, OFFLINE implementation behind the @task-RS-01 scenarios: it is a
// plain in-process `Map` seeded at construction — there is NO real filesystem, no
// clock, no RNG, and no network anywhere. A real durable store (fs/db) drops in
// behind the same interface without changing resume logic.
//
// `Checkpoint` mirrors `checkpoint.schema.json` verbatim (required:
// schemaVersion / checkpointId / sessionId / atEntryId / stateHash / createdAt /
// evidenceLedgerCursor; optional `artifact`). A checkpoint is a typed DERIVED
// recovery view — it never replaces session history or evidence, exactly as the
// frozen schema's description states, so the store keeps the append-only
// `entries` as the authoritative trail and treats `checkpoint` as an optional
// side-view.
import type { ArtifactRef, SessionEntry, SessionManifest } from "../session/types";

/**
 * A typed derived recovery view. Mirrors `checkpoint.schema.json`: it must never
 * replace session history or evidence — it only records where (`atEntryId`) and
 * against what recomputable state (`stateHash`) a recovery may resume, plus how
 * far the evidence ledger had advanced (`evidenceLedgerCursor`).
 */
export interface Checkpoint {
  schemaVersion: number;
  checkpointId: string;
  sessionId: string;
  atEntryId: string;
  stateHash: string;
  createdAt: string;
  evidenceLedgerCursor: number;
  /** Optional pointer to a persisted checkpoint artifact. */
  artifact?: ArtifactRef;
}

/**
 * A persisted session as read back for resume: the authoritative append-only
 * `manifest` + `entries`, plus an optional derived `checkpoint`.
 */
export interface SessionSnapshot {
  manifest: SessionManifest;
  entries: SessionEntry[];
  checkpoint?: Checkpoint;
}

/**
 * The durable boundary resume reads from and writes through. `read` returns the
 * authoritative snapshot; `append` extends the append-only trail idempotently by
 * `entryId`; `writeCheckpoint` records/updates the optional derived recovery
 * view. Implementations must never mutate a previously persisted entry.
 */
export interface SessionStore {
  /** The persisted snapshot for `sessionId`, or `undefined` when unknown. */
  read(sessionId: string): SessionSnapshot | undefined;
  /**
   * Append `entry` to the session's trail (idempotent by `entryId`: re-appending
   * an already-persisted entry is a no-op), advancing the manifest head.
   */
  append(sessionId: string, entry: SessionEntry): void;
  /** Record or replace the optional derived checkpoint for `sessionId`. */
  writeCheckpoint(sessionId: string, checkpoint: Checkpoint): void;
}

/** Typed rejection for an operation against an unknown session id. */
export class UnknownSessionError extends Error {
  constructor(sessionId: string) {
    super(`InMemorySessionStore: no session snapshot for id ${sessionId}`);
    this.name = "UnknownSessionError";
  }
}

/**
 * Deterministic, OFFLINE {@link SessionStore} backed by an in-process map. Seeded
 * at construction with a `Record<sessionId, SessionSnapshot>`; no filesystem,
 * clock, RNG, or network. Reads return the live snapshot object (the resume path
 * treats it as read-only and reconstructs an immutable session over it).
 */
export class InMemorySessionStore implements SessionStore {
  private readonly snapshots: Map<string, SessionSnapshot>;

  constructor(seed: Record<string, SessionSnapshot> = {}) {
    this.snapshots = new Map(Object.entries(seed));
  }

  read(sessionId: string): SessionSnapshot | undefined {
    return this.snapshots.get(sessionId);
  }

  append(sessionId: string, entry: SessionEntry): void {
    const snapshot = this.snapshots.get(sessionId);
    if (snapshot === undefined) {
      throw new UnknownSessionError(sessionId);
    }
    // Idempotent by entryId: a replayed append (e.g. after a crash/resume) never
    // duplicates an already-persisted entry, mirroring the W7 content-dedup.
    if (snapshot.entries.some((existing) => existing.entryId === entry.entryId)) {
      return;
    }
    snapshot.entries.push(entry);
    snapshot.manifest.appendCursor = snapshot.entries.length;
    snapshot.manifest.currentLeafEntryId = entry.entryId;
  }

  writeCheckpoint(sessionId: string, checkpoint: Checkpoint): void {
    const snapshot = this.snapshots.get(sessionId);
    if (snapshot === undefined) {
      throw new UnknownSessionError(sessionId);
    }
    snapshot.checkpoint = checkpoint;
  }
}

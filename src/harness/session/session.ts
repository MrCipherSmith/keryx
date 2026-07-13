// Release 0 append-only session (flow 009, W7 / S2, R0-02 / RS-01).
//
// `AppendOnlySession` is the deterministic, in-memory store behind the
// @task-RS-01 scenarios. It never reads a clock or RNG directly (both injected
// via `deps`), never opens a socket, and never mutates the filesystem or a
// previously appended entry. Re-appending byte-identical content (same payload
// + same parent) is idempotent: the existing entry is returned rather than
// duplicated — which is exactly what lets a crashed run resume without
// double-recording accepted evidence. Every manifest and entry validates
// against the frozen session-manifest / session-entry schemas.
import { createHash } from "node:crypto";
import type {
  SessionEntry,
  SessionEntryCausal,
  SessionEntryPayload,
  SessionManifest,
  SessionSeed,
} from "./types";

export type {
  ArtifactRef,
  Provenance,
  SessionEntry,
  SessionEntryCausal,
  SessionEntryPayload,
  SessionManifest,
  SessionSeed,
} from "./types";

/** Every durable harness contract in Release 0 is schemaVersion 1. */
const SCHEMA_VERSION = 1;

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Injected non-determinism: a fixed clock and a monotonic id source. */
export interface SessionDeps {
  clock: () => string;
  idSeq: () => string;
}

/**
 * Optional append hints. `parentEntryId` is threaded into `causal.parentEventId`
 * on the persisted entry; `correlationId` overrides the `deps.idSeq()` default;
 * `evidenceId` is session bookkeeping for the caller's evidence ledger and is
 * never stored as a bare key on the entry.
 */
export interface AppendOptions {
  parentEntryId?: string;
  evidenceId?: string;
  correlationId?: string;
  attemptId?: string;
  branchId?: string;
}

// Stable, key-sorted serialization so a content fingerprint is independent of
// property insertion order at the call site.
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

// Content fingerprint shared by dedup + entryId: stable across a process
// restart and independent of the (idSeq-derived) correlationId, so a replayed
// append lands on the exact same entryId instead of duplicating.
function contentKey(entry: SessionEntryPayload, parentEventId: string | null): string {
  return sha256(canonicalStringify({ entry, parentEventId }));
}

export class AppendOnlySession {
  private readonly seed: SessionSeed;
  private readonly deps: SessionDeps;
  private readonly _entries: SessionEntry[] = [];
  private readonly _byContentKey = new Map<string, SessionEntry>();
  private _currentLeafEntryId = "";

  constructor(
    seed: SessionSeed,
    deps: SessionDeps,
    initial?: { entries: readonly SessionEntry[]; currentLeafEntryId?: string },
  ) {
    this.seed = seed;
    this.deps = deps;
    if (initial) {
      for (const raw of initial.entries) {
        const entry = deepFreeze(clone(raw));
        this._entries.push(entry);
        this._byContentKey.set(contentKey(entry.entry, entry.causal.parentEventId ?? null), entry);
      }
      this._currentLeafEntryId =
        initial.currentLeafEntryId ?? this._entries[this._entries.length - 1]?.entryId ?? "";
    }
  }

  /**
   * Append `payload` as a new immutable entry, or — if an entry with identical
   * content and parent already exists — return that existing entry unchanged
   * (no new sequence, no cursor advance, no evidence duplication).
   */
  append(payload: SessionEntryPayload, opts?: AppendOptions): SessionEntry {
    const parentEventId = opts?.parentEntryId ?? null;
    const key = contentKey(payload, parentEventId);

    const existing = this._byContentKey.get(key);
    if (existing) {
      return existing;
    }

    const causal: SessionEntryCausal = {
      runId: this.seed.runId,
      sessionId: this.seed.sessionId,
      correlationId: opts?.correlationId ?? this.deps.idSeq(),
    };
    if (opts?.parentEntryId !== undefined) causal.parentEventId = opts.parentEntryId;
    if (opts?.attemptId !== undefined) causal.attemptId = opts.attemptId;
    if (opts?.branchId !== undefined) causal.branchId = opts.branchId;

    const entry = deepFreeze<SessionEntry>({
      schemaVersion: SCHEMA_VERSION,
      entryId: key,
      sequence: this._entries.length,
      timestamp: this.deps.clock(),
      causal,
      entry: clone(payload),
    });

    this._entries.push(entry);
    this._byContentKey.set(key, entry);
    this._currentLeafEntryId = entry.entryId;
    return entry;
  }

  /** A fresh, schema-valid snapshot of the current session head. */
  manifest(): SessionManifest {
    const manifest: SessionManifest = {
      schemaVersion: SCHEMA_VERSION,
      sessionId: this.seed.sessionId,
      runId: this.seed.runId,
      createdAt: this.seed.createdAt,
      appendCursor: this._entries.length,
      currentLeafEntryId: this._currentLeafEntryId,
      policyFingerprint: this.seed.policyFingerprint,
      contextManifestHash: this.seed.contextManifestHash,
    };
    if (this.seed.parentSessionId !== undefined) {
      manifest.parentSessionId = this.seed.parentSessionId;
    }
    return manifest;
  }

  /** A fresh array of the immutable (deep-frozen) entries, oldest first. */
  entries(): SessionEntry[] {
    return [...this._entries];
  }

  /** The current leaf entry, or `undefined` for an empty session. */
  currentLeaf(): SessionEntry | undefined {
    return this._entries.find((entry) => entry.entryId === this._currentLeafEntryId);
  }
}

/**
 * Reconstruct a live {@link AppendOnlySession} from a persisted
 * `(manifest, entries)` pair. The reconstructed session preserves prior entries
 * verbatim and rebuilds the dedup index, so re-appending already-accepted
 * evidence is idempotent while genuinely new work still appends.
 */
export function resumeSession(
  persisted: { manifest: SessionManifest; entries: readonly SessionEntry[] },
  deps: SessionDeps,
): AppendOnlySession {
  const { manifest } = persisted;
  const seed: SessionSeed = {
    sessionId: manifest.sessionId,
    runId: manifest.runId,
    createdAt: manifest.createdAt,
    policyFingerprint: manifest.policyFingerprint,
    contextManifestHash: manifest.contextManifestHash,
  };
  if (manifest.parentSessionId !== undefined) {
    seed.parentSessionId = manifest.parentSessionId;
  }
  return new AppendOnlySession(seed, deps, {
    entries: persisted.entries,
    currentLeafEntryId: manifest.currentLeafEntryId,
  });
}

/** Typed rejection for a session schema version this reader cannot migrate. */
export class SchemaMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaMigrationError";
  }
}

function asId(value: unknown, fallbackSeed: string): string {
  if (typeof value === "string" && value.length > 0) return value.slice(0, 256);
  return `${fallbackSeed}-${sha256(fallbackSeed).slice(0, 16)}`;
}

function asTimestamp(value: unknown): string {
  if (typeof value === "string" && RFC3339.test(value)) return value;
  return "1970-01-01T00:00:00.000Z";
}

/**
 * Deterministically migrate a prior (schemaVersion 0-style) session into the
 * current schema-1 shape. Two runs over identical input are byte-identical;
 * absent fields receive deterministic non-empty defaults derived from the
 * input; the caller's input objects are never mutated. An unsupported future
 * schemaVersion is rejected with a {@link SchemaMigrationError}.
 */
export function migrateSession(prior: {
  manifest: Record<string, unknown>;
  entries: readonly Record<string, unknown>[];
}): { manifest: SessionManifest; entries: SessionEntry[] } {
  const rawVersion = prior.manifest.schemaVersion;
  const version = typeof rawVersion === "number" ? rawVersion : Number.NaN;
  if (!Number.isFinite(version) || version > SCHEMA_VERSION) {
    throw new SchemaMigrationError(
      `Unsupported schemaVersion ${String(rawVersion)}: cannot migrate this session to schemaVersion ${SCHEMA_VERSION} (typed_schema_incompatible).`,
    );
  }

  const sessionId = asId(prior.manifest.sessionId, "session");
  const runId = asId(prior.manifest.runId, "run");
  const createdAt = asTimestamp(prior.manifest.createdAt);

  const entries: SessionEntry[] = prior.entries.map((rawEntry, index) => {
    const entryId = asId(rawEntry.entryId, `entry-${index}`);
    const rawSequence = rawEntry.sequence;
    const sequence =
      typeof rawSequence === "number" && Number.isInteger(rawSequence) && rawSequence >= 0
        ? rawSequence
        : index;
    const causal: SessionEntryCausal = {
      runId,
      sessionId,
      correlationId: `corr-${entryId}`,
    };
    return {
      schemaVersion: SCHEMA_VERSION,
      entryId,
      sequence,
      timestamp: asTimestamp(rawEntry.timestamp),
      causal,
      entry: clone(rawEntry.entry) as SessionEntryPayload,
    };
  });

  const lastEntry = entries[entries.length - 1];
  const currentLeafEntryId = lastEntry ? lastEntry.entryId : sha256(`empty-leaf:${sessionId}:${runId}`);

  const manifest: SessionManifest = {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    runId,
    createdAt,
    appendCursor: entries.length,
    currentLeafEntryId,
    policyFingerprint: sha256(`policy-fingerprint:${sessionId}:${runId}`),
    contextManifestHash: sha256(`context-manifest:${sessionId}:${runId}`),
  };

  return { manifest, entries };
}

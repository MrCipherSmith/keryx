// RED tests for R0-02 / RS-01 (flow 009, W7 / T7, sub-slice S2).
//
// Pins the Release 0 append-only SESSION contract per
// docs/requirements/keryx-project-agent-harness/acceptance.feature
// `@task-RS-01` scenarios:
//   - @SC_R06_APPEND_ONLY_SESSION   "Reconstruct an append-only session tree"
//   - @SC_R06_RESUME_NO_DUPLICATE   "Resume without duplicating accepted evidence"
//   - @SC_R06_SCHEMA_MIGRATION      "Migrate a prior session schema deterministically"
//
// S2 (impl) implements `src/harness/session/types.ts` (`SessionManifest`,
// `SessionEntry`) and `src/harness/session/session.ts` (`SessionSeed`,
// `AppendOnlySession`, `resumeSession`, `migrateSession`) to make this suite
// GREEN; until then the missing-module import is the expected RED failure.
//
// Deterministic: `deps.clock`/`deps.idSeq` are fixed (see `makeDeps()`); no
// `Date.now()`, `Math.random()`, or network anywhere in this file.
//
// --- API DELTA (see subagent-result "exact API S2 impl must export") -------
// The dispatch's pinned sketch for `SessionEntry.causal` is
// `{ parentEntryId?: string; correlationId?: string }`. That shape cannot
// itself validate against the FROZEN `session-entry.schema.json`, whose
// `causal` property resolves to `harness-envelope.schema.json#/$defs/
// causalIds` — which REQUIRES `runId`, `sessionId`, and `correlationId`, and
// names the parent-link field `parentEventId` (not `parentEntryId`).
// `SessionManifest` needs no change: its shape already matches
// `session-manifest.schema.json`'s required set exactly.
//
// These tests exercise the corrected `causal` shape below (`SessionEntry`'s
// `causal: { runId, sessionId, correlationId, parentEventId?, attemptId?,
// branchId? }`), reusing the seed's `runId`/`sessionId` and generating
// `correlationId` from `deps.idSeq`. `append()`'s public `opts.parentEntryId`
// convenience param is expected to be threaded through into
// `causal.parentEventId` on the persisted entry so every entry produced by
// `AppendOnlySession`/`resumeSession`/`migrateSession` round-trips through
// `validateAgainstSchema` unchanged. S2 impl must export `SessionEntry`
// (and, if it introduces a named alias, `SessionEntryCausal`) matching this
// corrected shape rather than the dispatch's literal sketch.
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";
import { AppendOnlySession, migrateSession, resumeSession } from "./session";
import type { SessionEntry, SessionManifest, SessionSeed } from "./session";

// Frozen schemas dir, computed relative to this file
// (src/harness/session/ -> repo root).
const SCHEMA_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-project-agent-harness",
  "schemas",
);

// ---------------------------------------------------------------------------
// Deterministic deps: fixed clock, fixed id sequence. `makeDeps()` returns a
// *fresh* sequence starting from the same seed every call so two independent
// sessions over identical input are byte-identical (no shared mutable counter
// leaking state between tests). Mirrors `src/harness/startup.test.ts`.
// ---------------------------------------------------------------------------
function makeDeps(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return {
    clock: () => "2026-01-01T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
  };
}

const SHA_PLACEHOLDER = "c".repeat(64);

function artifactRef(artifactId: string, kind = "evidence"): { artifactId: string; kind: string; hash: string } {
  return { artifactId, kind, hash: SHA_PLACEHOLDER };
}

const seed: SessionSeed = {
  sessionId: "session-1",
  runId: "run-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  policyFingerprint: "a".repeat(64),
  contextManifestHash: "b".repeat(64),
};

function validateManifest(manifest: SessionManifest): void {
  const result = validateAgainstSchema("session-manifest.schema.json", manifest, { schemaDir: SCHEMA_DIR });
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
}

function validateEntry(entry: SessionEntry): void {
  const result = validateAgainstSchema("session-entry.schema.json", entry, { schemaDir: SCHEMA_DIR });
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
}

// --- 1. SC_R06_APPEND_ONLY_SESSION ------------------------------------------

describe("SC_R06_APPEND_ONLY_SESSION — reconstruct an append-only session tree", () => {
  test("appending model/tool/evidence entries advances sequence + appendCursor and sets currentLeafEntryId", () => {
    const session = new AppendOnlySession(seed, makeDeps());

    const e0 = session.append({ type: "user_message", text: "start" });
    const e1 = session.append(
      { type: "model_request", modelAttemptId: "attempt-1", artifactRef: artifactRef("artifact-1", "model-request") },
      { parentEntryId: e0.entryId },
    );
    const e2 = session.append({ type: "tool_call", toolCallId: "tc-1" }, { parentEntryId: e1.entryId });
    const e3 = session.append(
      { type: "evidence_link", artifactRef: artifactRef("evidence-1") },
      { parentEntryId: e2.entryId, evidenceId: "evidence-1" },
    );

    expect([e0, e1, e2, e3].map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
    expect(session.manifest().appendCursor).toBe(4);
    expect(session.manifest().currentLeafEntryId).toBe(e3.entryId);
    expect(session.currentLeaf()?.entryId).toBe(e3.entryId);
  });

  test("every appended entry has a stable non-empty entryId and an RFC 3339 timestamp", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const entries = [
      session.append({ type: "user_message", text: "a" }),
      session.append({ type: "assistant_message", text: "b" }),
      session.append({ type: "tool_call", toolCallId: "tc-2" }),
    ];

    const seenIds = new Set<string>();
    for (const entry of entries) {
      expect(typeof entry.entryId).toBe("string");
      expect(entry.entryId.length).toBeGreaterThan(0);
      expect(seenIds.has(entry.entryId)).toBe(false);
      seenIds.add(entry.entryId);
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
    }
  });

  test("parent links reconstruct the chain from currentLeaf back to the root, with a single current leaf", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const root = session.append({ type: "user_message", text: "root" });
    const mid = session.append({ type: "assistant_message", text: "mid" }, { parentEntryId: root.entryId });
    const leaf = session.append({ type: "assistant_message", text: "leaf" }, { parentEntryId: mid.entryId });

    const byId = new Map(session.entries().map((entry: SessionEntry) => [entry.entryId, entry]));
    const chain: string[] = [];
    let cursor: SessionEntry | undefined = session.currentLeaf();
    while (cursor) {
      chain.push(cursor.entryId);
      const parentId = cursor.causal.parentEventId;
      cursor = parentId ? byId.get(parentId) : undefined;
    }
    expect(chain).toEqual([leaf.entryId, mid.entryId, root.entryId]);

    // Single current leaf: exactly one entry is nobody's parent.
    const parentIds = new Set(
      session
        .entries()
        .map((entry: SessionEntry) => entry.causal.parentEventId)
        .filter((id: string | undefined): id is string => Boolean(id)),
    );
    const leaves = session.entries().filter((entry: SessionEntry) => !parentIds.has(entry.entryId));
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.entryId).toBe(leaf.entryId);
  });

  test("appended entries are immutable: mutating a returned snapshot never affects internal state", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    session.append({ type: "user_message", text: "one" });

    const snapshot = session.entries();
    const firstBefore = snapshot[0];
    if (!firstBefore) throw new Error("expected at least one entry after first append");

    const mutableCopy = snapshot as unknown as SessionEntry[];
    mutableCopy[0] = { ...firstBefore, sequence: 999, entryId: "forged-mutation" };
    mutableCopy.push({ ...firstBefore, entryId: "forged-push", sequence: 999 });

    session.append({ type: "user_message", text: "two" });

    const after = session.entries();
    expect(after).toHaveLength(2);
    const afterFirst = after[0];
    if (!afterFirst) throw new Error("expected at least one entry after second append");
    expect(afterFirst.sequence).toBe(0);
    expect(afterFirst.entryId).not.toBe("forged-mutation");
    expect(after.some((entry: SessionEntry) => entry.entryId === "forged-push")).toBe(false);
  });

  test("manifest() and each appended SessionEntry validate against their frozen schemas", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    session.append({ type: "user_message", text: "hi" });
    session.append(
      { type: "evidence_link", artifactRef: artifactRef("evidence-x") },
      { evidenceId: "evidence-x" },
    );

    validateManifest(session.manifest());
    for (const entry of session.entries()) {
      validateEntry(entry);
    }
  });
});

// --- 2. SC_R06_RESUME_NO_DUPLICATE -------------------------------------------

describe("SC_R06_RESUME_NO_DUPLICATE — resume without duplicating accepted evidence", () => {
  test("resuming and re-appending an entry carrying an already-accepted evidenceId does not duplicate it", () => {
    const original = new AppendOnlySession(seed, makeDeps());
    const first = original.append({ type: "user_message", text: "start" });
    const accepted = original.append(
      { type: "evidence_link", artifactRef: artifactRef("evidence-1") },
      { parentEntryId: first.entryId, evidenceId: "evidence-1" },
    );

    const manifestBeforeExit = original.manifest();
    const entriesBeforeExit = original.entries();

    // Simulate process exit + resume over the persisted (manifest, entries) pair.
    const resumed = resumeSession(
      { manifest: manifestBeforeExit, entries: [...entriesBeforeExit] },
      makeDeps(),
    );

    expect(resumed.manifest()).toEqual(manifestBeforeExit);
    expect(resumed.entries()).toEqual(entriesBeforeExit);

    // Re-appending the SAME evidence (same evidenceId) must not duplicate it.
    const replay = resumed.append(
      { type: "evidence_link", artifactRef: artifactRef("evidence-1") },
      { parentEntryId: first.entryId, evidenceId: "evidence-1" },
    );

    expect(replay.entryId).toBe(accepted.entryId);
    expect(resumed.entries()).toHaveLength(2);
    expect(
      resumed.entries().filter((entry: SessionEntry) => entry.entry.type === "evidence_link"),
    ).toHaveLength(1);
    expect(resumed.manifest().appendCursor).toBe(manifestBeforeExit.appendCursor);
    expect(resumed.manifest().currentLeafEntryId).toBe(manifestBeforeExit.currentLeafEntryId);
  });

  test("resuming and re-appending byte-identical entry content (no evidenceId) is deduped by content hash", () => {
    const original = new AppendOnlySession(seed, makeDeps());
    const accepted = original.append({ type: "assistant_message", text: "identical payload" });

    const resumed = resumeSession(
      { manifest: original.manifest(), entries: [...original.entries()] },
      makeDeps(),
    );

    const replay = resumed.append({ type: "assistant_message", text: "identical payload" });
    expect(replay.entryId).toBe(accepted.entryId);
    expect(resumed.entries()).toHaveLength(1);
  });

  test("genuinely new (stale) work after resume creates a new immutable attempt rather than being dropped", () => {
    const original = new AppendOnlySession(seed, makeDeps());
    const first = original.append({ type: "user_message", text: "start" });

    const resumed = resumeSession(
      { manifest: original.manifest(), entries: [...original.entries()] },
      makeDeps(),
    );

    const staleAttempt = resumed.append(
      { type: "assistant_message", text: "stale retry after crash" },
      { parentEntryId: first.entryId },
    );

    expect(staleAttempt.entryId).not.toBe(first.entryId);
    expect(resumed.entries()).toHaveLength(2);
    expect(resumed.manifest().appendCursor).toBe(2);
    expect(resumed.manifest().currentLeafEntryId).toBe(staleAttempt.entryId);

    // The original entry remains immutable and reachable.
    const originalStill = resumed.entries().find((entry: SessionEntry) => entry.entryId === first.entryId);
    expect(originalStill).toEqual(first);
  });

  test("resumed manifest and every entry still validate against the frozen schemas", () => {
    const original = new AppendOnlySession(seed, makeDeps());
    original.append({ type: "user_message", text: "start" });
    const resumed = resumeSession(
      { manifest: original.manifest(), entries: [...original.entries()] },
      makeDeps(),
    );
    resumed.append({ type: "assistant_message", text: "continued" });

    validateManifest(resumed.manifest());
    for (const entry of resumed.entries()) {
      validateEntry(entry);
    }
  });
});

// --- 3. SC_R06_SCHEMA_MIGRATION ----------------------------------------------

describe("SC_R06_SCHEMA_MIGRATION — migrate a prior session schema deterministically", () => {
  // A hypothetical pre-envelope (schemaVersion 0) session: no appendCursor /
  // currentLeafEntryId / policyFingerprint / contextManifestHash on the
  // manifest, and no `causal` linkage at all on entries — the shape a Release
  // 0 reader must accept per ADR-0001 / TM-01's additive-migration policy and
  // `schema-version-registry.json`'s `defaultRejectionBehavior`.
  const priorManifestV0: Record<string, unknown> = {
    schemaVersion: 0,
    sessionId: "session-legacy-1",
    runId: "run-legacy-1",
    createdAt: "2025-01-01T00:00:00.000Z",
  };
  const priorEntriesV0: Record<string, unknown>[] = [
    {
      schemaVersion: 0,
      entryId: "entry-legacy-1",
      sequence: 0,
      timestamp: "2025-01-01T00:00:00.000Z",
      entry: { type: "user_message", text: "legacy hello" },
    },
    {
      schemaVersion: 0,
      entryId: "entry-legacy-2",
      sequence: 1,
      timestamp: "2025-01-01T00:01:00.000Z",
      entry: { type: "assistant_message", text: "legacy reply" },
    },
  ];

  test("migrating a prior (schemaVersion 0) session produces a current-shape manifest+entries valid against the frozen schemas", () => {
    const migrated = migrateSession({ manifest: priorManifestV0, entries: priorEntriesV0 });

    expect(migrated.manifest.schemaVersion).toBe(1);
    expect(migrated.manifest.sessionId).toBe("session-legacy-1");
    expect(migrated.manifest.runId).toBe("run-legacy-1");
    expect(migrated.manifest.currentLeafEntryId).toBe("entry-legacy-2");
    expect(migrated.manifest.appendCursor).toBe(2);

    validateManifest(migrated.manifest);
    for (const entry of migrated.entries) {
      expect(entry.schemaVersion).toBe(1);
      validateEntry(entry);
    }
  });

  test("migration is deterministic: two independent runs over the same prior input produce byte-identical output", () => {
    const first = migrateSession({ manifest: priorManifestV0, entries: priorEntriesV0 });
    const second = migrateSession({ manifest: priorManifestV0, entries: priorEntriesV0 });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("unknown/absent fields (policyFingerprint, contextManifestHash, causal linkage) receive deterministic non-empty defaults", () => {
    const migrated = migrateSession({ manifest: priorManifestV0, entries: priorEntriesV0 });

    expect(migrated.manifest.policyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(migrated.manifest.contextManifestHash).toMatch(/^[a-f0-9]{64}$/);

    for (const entry of migrated.entries) {
      expect(entry.causal.runId).toBe("run-legacy-1");
      expect(entry.causal.sessionId).toBe("session-legacy-1");
      expect(typeof entry.causal.correlationId).toBe("string");
      expect(entry.causal.correlationId.length).toBeGreaterThan(0);
    }

    // Deterministic, not random-per-call: defaults recomputed on a second run
    // are identical to the first (already covered end-to-end above), and
    // here specifically for the derived causal correlation ids.
    const migratedAgain = migrateSession({ manifest: priorManifestV0, entries: priorEntriesV0 });
    expect(migratedAgain.entries.map((entry: SessionEntry) => entry.causal.correlationId)).toEqual(
      migrated.entries.map((entry: SessionEntry) => entry.causal.correlationId),
    );
  });

  test("an unsupported future schemaVersion is rejected with a typed error mentioning schemaVersion", () => {
    const future = { ...priorManifestV0, schemaVersion: 99 };
    expect(() => migrateSession({ manifest: future, entries: priorEntriesV0 })).toThrow(/schemaVersion/i);
  });

  test("prior history remains immutable: migrating does not mutate the caller's input objects", () => {
    const manifestSnapshot = JSON.stringify(priorManifestV0);
    const entriesSnapshot = JSON.stringify(priorEntriesV0);

    migrateSession({ manifest: priorManifestV0, entries: priorEntriesV0 });

    expect(JSON.stringify(priorManifestV0)).toBe(manifestSnapshot);
    expect(JSON.stringify(priorEntriesV0)).toBe(entriesSnapshot);
  });
});

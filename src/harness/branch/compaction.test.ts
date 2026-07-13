// RED tests for W9 / B-02 (typed compaction), flow 012, dispatch 012-T7.
//
// Pins the Release 1 typed COMPACTION contract per
// docs/requirements/keryx-project-agent-harness/acceptance.feature:
//   - @task-B-02 @SC_R06_TYPED_COMPACTION "Compact as a typed derived entry"
//     Given a session exceeds its context budget
//     When compaction creates a derived entry
//     Then source range, summary hash, active obligations, and evidence
//     cursor are retained.
//   - @task-B-02 @SC_R07_COMPACTION_REBUILDS_REFERENCES
//     "Rebuild bounded context after compaction"
//     Given a compacted session retains its project scope and evidence ids
//     When context is rebuilt
//     Then the same scope and evidence references are addressable.
//
// B-02 impl (next dispatch) implements `src/harness/branch/compaction.ts`
// (`CompactionEntry`, `compact`, `EvidenceDeletionError`,
// `assertEvidencePreserved`, `rebuildBoundedContext`) to make this suite
// GREEN; until then the missing-module import below is the expected RED
// failure ("Cannot find module './compaction'").
//
// Reuses (unmodified, GREEN elsewhere):
//   - W7 src/harness/session/{session,types}.ts — AppendOnlySession,
//     SessionEntry, SessionSeed (a `compaction` SessionEntryPayload variant
//     already exists: `{ type: "compaction", artifactRef }`, same shape as
//     `branch_metadata`/`evidence_link`).
//   - W8 src/harness/resume/store.ts — SessionSnapshot.
//   - src/contracts/validator.ts — validateAgainstSchema against the FROZEN
//     compaction-entry.schema.json / session-entry.schema.json.
//
// --- DESIGN ASSUMPTIONS PINNED BY THIS SUITE (B-02 impl must satisfy) -------
// The dispatch's sketch does not fix every shape; this suite pins the
// following so a concrete B-02 impl has a single, unambiguous target:
//   1. `summaryHash` is the plain sha256 (lowercase hex) of the UTF-8 summary
//      text: `sha256(input.summary)`. It does not depend on `sourceEntryIds`
//      order or on injected clock/id output, so it is stable across
//      independently-seeded deterministic calls with the same `summary`.
//   2. `derivedEntryId` equals the entryId of the returned `entry` (mirrors
//      B-01's `leafEntryId === entry.entryId`): compaction appends one new
//      `compaction` marker entry as the derived record, and that marker's id
//      becomes `derivedEntryId`.
//   3. `compact` is PURE with respect to `input.snapshot`: it never pushes
//      into `snapshot.entries` nor mutates `snapshot.manifest`. The caller
//      persists the returned `entry` explicitly (e.g. via
//      `SessionStore.append`), matching B-01's "returns a value, caller
//      persists it" shape.
//   4. `compact` does not mutate or rewrite any source entry's content: after
//      compaction the source entries (by entryId) are byte-identical to
//      before. The derived compaction entry is an ADDITIONAL append-only
//      record, never a replacement.
//   5. `assertEvidencePreserved(before, afterEntries)` treats EVERY entry
//      present in `before.entries` (not only `evidence_link`-typed ones) as
//      protected: if any `before.entries` entryId is missing from
//      `afterEntries`, it throws `EvidenceDeletionError`. This is the
//      concrete form of "no history/evidence deletion".
//   6. `rebuildBoundedContext` returns `references` = the deduplicated,
//      lexicographically-sorted union of `compaction.sourceEntryIds` and the
//      `artifactRef.artifactId` of every `evidence_link` entry present in
//      `input.snapshot.entries` — i.e. the same project scope (source range)
//      and evidence ids remain addressable after a rebuild. `summaryHash`
//      on the result equals `input.compaction.summaryHash` unchanged. Two
//      calls with identical input (regardless of `deps.clock` value) produce
//      a deep-equal result.
//
// Deterministic: `deps.clock`/`deps.idSeq` are fixed via `makeDeps()`; no
// `Date.now()`, `Math.random()`, or network anywhere in this file. No real
// filesystem — everything is in-process against a hand-built `SessionSnapshot`.
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";
import type { SessionSnapshot } from "../resume/store";
import { AppendOnlySession } from "../session/session";
import type { SessionEntry, SessionSeed } from "../session/types";

// PINNED API (see dispatch 012-T7) — B-02 impl exports these from
// `./compaction`; the import fails until then (expected RED: "Cannot find
// module './compaction'").
import {
  assertEvidencePreserved,
  compact,
  EvidenceDeletionError,
  rebuildBoundedContext,
} from "./compaction";

// Frozen schemas dir, computed relative to this file
// (src/harness/branch/ -> repo root).
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
// Deterministic deps: fixed clock, fresh monotonic id sequence per call.
// Mirrors `src/harness/branch/branch.test.ts` / `session.test.ts` makeDeps().
// ---------------------------------------------------------------------------
function makeDeps(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return {
    clock: () => "2026-01-01T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
  };
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

const SHA_PLACEHOLDER = "c".repeat(64);

function artifactRef(artifactId: string, kind = "evidence"): { artifactId: string; kind: string; hash: string } {
  return { artifactId, kind, hash: SHA_PLACEHOLDER };
}

const seed: SessionSeed = {
  sessionId: "session-compact-1",
  runId: "run-compact-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  policyFingerprint: "a".repeat(64),
  contextManifestHash: "b".repeat(64),
};

/**
 * A four-entry chain (user -> assistant -> evidence_link -> assistant),
 * wrapped as a persisted snapshot, exercised as the "session exceeds its
 * context budget" fixture for compaction.
 */
function buildSnapshotWithEvidence(): {
  snapshot: SessionSnapshot;
  u1: SessionEntry;
  a1: SessionEntry;
  ev1: SessionEntry;
  a2: SessionEntry;
} {
  const session = new AppendOnlySession(seed, makeDeps());
  const u1 = session.append({ type: "user_message", text: "start the task" });
  const a1 = session.append({ type: "assistant_message", text: "working on it" }, { parentEntryId: u1.entryId });
  const ev1 = session.append(
    { type: "evidence_link", artifactRef: artifactRef("evidence-1") },
    { parentEntryId: a1.entryId, evidenceId: "evidence-1" },
  );
  const a2 = session.append({ type: "assistant_message", text: "done, see evidence-1" }, { parentEntryId: ev1.entryId });
  const snapshot: SessionSnapshot = { manifest: session.manifest(), entries: session.entries() };
  return { snapshot, u1, a1, ev1, a2 };
}

function validateCompactionEntry(value: unknown): void {
  const result = validateAgainstSchema("compaction-entry.schema.json", value, { schemaDir: SCHEMA_DIR });
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
}

function validateSessionEntry(value: unknown): void {
  const result = validateAgainstSchema("session-entry.schema.json", value, { schemaDir: SCHEMA_DIR });
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
}

// --- 1. Typed compaction entry (SC_R06_TYPED_COMPACTION) --------------------

describe("compact — typed compaction entry (SC_R06_TYPED_COMPACTION)", () => {
  test("produces a CompactionEntry that validates against compaction-entry.schema.json", () => {
    const { snapshot, u1, a1, ev1, a2 } = buildSnapshotWithEvidence();
    const sourceEntryIds = [u1.entryId, a1.entryId, ev1.entryId, a2.entryId];
    const summary = "Task started, assistant worked on it, evidence-1 attached, task completed.";

    const result = compact(
      { snapshot, sessionId: seed.sessionId, sourceEntryIds, summary, evidenceLedgerCursor: 1 },
      makeDeps(),
    );

    expect(result.compaction.schemaVersion).toBe(1);
    expect(result.compaction.sessionId).toBe(seed.sessionId);
    expect(result.compaction.sourceEntryIds).toEqual(sourceEntryIds);
    expect(result.compaction.derivedEntryId.length).toBeGreaterThan(0);
    expect(result.compaction.evidenceLedgerCursor).toBe(1);
    expect(typeof result.compaction.createdAt).toBe("string");

    validateCompactionEntry(result.compaction);
  });

  test("summaryHash is the deterministic sha256 of the summary text", () => {
    const { snapshot, u1, a1 } = buildSnapshotWithEvidence();
    const summary = "a short, specific compaction summary";

    const result = compact(
      { snapshot, sessionId: seed.sessionId, sourceEntryIds: [u1.entryId, a1.entryId], summary, evidenceLedgerCursor: 0 },
      makeDeps(),
    );

    expect(result.compaction.summaryHash).toBe(sha256(summary));
    expect(result.compaction.summaryHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("the returned entry is a schema-valid `compaction` SessionEntry whose entryId is derivedEntryId", () => {
    const { snapshot, u1, a1 } = buildSnapshotWithEvidence();
    const result = compact(
      {
        snapshot,
        sessionId: seed.sessionId,
        sourceEntryIds: [u1.entryId, a1.entryId],
        summary: "summary for entry-shape test",
        evidenceLedgerCursor: 0,
      },
      makeDeps(),
    );

    expect(result.entry.entry.type).toBe("compaction");
    if (result.entry.entry.type !== "compaction") {
      throw new Error("expected a compaction entry payload");
    }
    expect(result.entry.entry.artifactRef.artifactId.length).toBeGreaterThan(0);
    expect(result.entry.entry.artifactRef.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.entry.entryId).toBe(result.compaction.derivedEntryId);

    validateSessionEntry(result.entry);
  });
});

// --- 2. Evidence preservation — sources remain -------------------------------

describe("compact — evidence preservation: sources remain (no deletion)", () => {
  test("every source entry and every evidence_link entry from the pre-compaction snapshot is still present after compaction", () => {
    const { snapshot, u1, a1, ev1, a2 } = buildSnapshotWithEvidence();
    const beforeEntryIds = snapshot.entries.map((entry) => entry.entryId);
    const beforeEntriesJson = JSON.stringify(snapshot.entries);

    const result = compact(
      {
        snapshot,
        sessionId: seed.sessionId,
        sourceEntryIds: [u1.entryId, a1.entryId, ev1.entryId, a2.entryId],
        summary: "preserve-sources summary",
        evidenceLedgerCursor: 1,
      },
      makeDeps(),
    );

    // compact is PURE w.r.t. the input snapshot: entries unchanged in place.
    expect(JSON.stringify(snapshot.entries)).toBe(beforeEntriesJson);

    // The caller-side "after" view is prior entries + the one derived entry
    // (append-only; nothing removed).
    const afterEntries = [...snapshot.entries, result.entry];
    const afterEntryIds = new Set(afterEntries.map((entry) => entry.entryId));

    for (const id of beforeEntryIds) {
      expect(afterEntryIds.has(id)).toBe(true);
    }
    expect(afterEntryIds.has(ev1.entryId)).toBe(true);
    expect(afterEntryIds.has(result.entry.entryId)).toBe(true);
    expect(afterEntries.length).toBe(snapshot.entries.length + 1);
  });

  test("compact does not mutate the snapshot's manifest", () => {
    const { snapshot, u1, a1 } = buildSnapshotWithEvidence();
    const manifestBefore = JSON.stringify(snapshot.manifest);

    compact(
      {
        snapshot,
        sessionId: seed.sessionId,
        sourceEntryIds: [u1.entryId, a1.entryId],
        summary: "manifest-purity summary",
        evidenceLedgerCursor: 0,
      },
      makeDeps(),
    );

    expect(JSON.stringify(snapshot.manifest)).toBe(manifestBefore);
  });
});

// --- 3. No untrusted-summary promotion ---------------------------------------

describe("compact — no untrusted-summary promotion", () => {
  test("source entries' content is unchanged; the derived summary is a separate entry, never a mutation of a source", () => {
    const { snapshot, u1, a1, ev1, a2 } = buildSnapshotWithEvidence();
    const sourceSnapshotBefore = {
      u1: JSON.stringify(u1),
      a1: JSON.stringify(a1),
      ev1: JSON.stringify(ev1),
      a2: JSON.stringify(a2),
    };

    const result = compact(
      {
        snapshot,
        sessionId: seed.sessionId,
        sourceEntryIds: [u1.entryId, a1.entryId, ev1.entryId, a2.entryId],
        summary: "an untrusted, non-authoritative derived summary",
        evidenceLedgerCursor: 1,
      },
      makeDeps(),
    );

    // The sources, looked up again by id in the (still-pure) snapshot, are
    // byte-identical to their pre-compaction form — no in-place rewrite.
    const byId = new Map(snapshot.entries.map((entry) => [entry.entryId, entry]));
    expect(JSON.stringify(byId.get(u1.entryId))).toBe(sourceSnapshotBefore.u1);
    expect(JSON.stringify(byId.get(a1.entryId))).toBe(sourceSnapshotBefore.a1);
    expect(JSON.stringify(byId.get(ev1.entryId))).toBe(sourceSnapshotBefore.ev1);
    expect(JSON.stringify(byId.get(a2.entryId))).toBe(sourceSnapshotBefore.a2);

    // The derived entry is a DISTINCT record, not one of the sources, and
    // carries no authoritative "text" — it is the `compaction` artifactRef
    // variant, never a `user_message`/`assistant_message` rewrite.
    expect(result.entry.entryId).not.toBe(u1.entryId);
    expect(result.entry.entryId).not.toBe(a1.entryId);
    expect(result.entry.entryId).not.toBe(ev1.entryId);
    expect(result.entry.entryId).not.toBe(a2.entryId);
    expect(result.entry.entry.type).toBe("compaction");
  });
});

// --- 4. assertEvidencePreserved ----------------------------------------------

describe("assertEvidencePreserved — rejects evidence/history deletion", () => {
  test("passes when afterEntries includes every pre-compaction entry plus the derived entry", () => {
    const { snapshot, u1, a1, ev1, a2 } = buildSnapshotWithEvidence();
    const beforeSnapshot: SessionSnapshot = { manifest: snapshot.manifest, entries: [...snapshot.entries] };

    const result = compact(
      {
        snapshot,
        sessionId: seed.sessionId,
        sourceEntryIds: [u1.entryId, a1.entryId, ev1.entryId, a2.entryId],
        summary: "assert-preserved pass case",
        evidenceLedgerCursor: 1,
      },
      makeDeps(),
    );

    const afterEntries = [...snapshot.entries, result.entry];
    expect(() => assertEvidencePreserved(beforeSnapshot, afterEntries)).not.toThrow();
  });

  test("throws EvidenceDeletionError when the evidence_link source entry is missing from afterEntries", () => {
    const { snapshot, u1, a1, ev1, a2 } = buildSnapshotWithEvidence();
    const beforeSnapshot: SessionSnapshot = { manifest: snapshot.manifest, entries: [...snapshot.entries] };

    const result = compact(
      {
        snapshot,
        sessionId: seed.sessionId,
        sourceEntryIds: [u1.entryId, a1.entryId, ev1.entryId, a2.entryId],
        summary: "assert-preserved fail case (evidence dropped)",
        evidenceLedgerCursor: 1,
      },
      makeDeps(),
    );

    const afterEntriesMissingEvidence = [...snapshot.entries, result.entry].filter(
      (entry) => entry.entryId !== ev1.entryId,
    );

    expect(() => assertEvidencePreserved(beforeSnapshot, afterEntriesMissingEvidence)).toThrow(
      EvidenceDeletionError,
    );
  });

  test("throws EvidenceDeletionError when a plain source entry (not evidence-typed) is missing from afterEntries", () => {
    const { snapshot, u1, a1, ev1, a2 } = buildSnapshotWithEvidence();
    const beforeSnapshot: SessionSnapshot = { manifest: snapshot.manifest, entries: [...snapshot.entries] };

    const result = compact(
      {
        snapshot,
        sessionId: seed.sessionId,
        sourceEntryIds: [u1.entryId, a1.entryId, ev1.entryId, a2.entryId],
        summary: "assert-preserved fail case (source dropped)",
        evidenceLedgerCursor: 1,
      },
      makeDeps(),
    );

    const afterEntriesMissingSource = [...snapshot.entries, result.entry].filter(
      (entry) => entry.entryId !== a1.entryId,
    );

    expect(() => assertEvidencePreserved(beforeSnapshot, afterEntriesMissingSource)).toThrow(
      EvidenceDeletionError,
    );
  });

  test("a compaction that only appends the derived entry (no history dropped) never throws", () => {
    const { snapshot, u1, a1, ev1, a2 } = buildSnapshotWithEvidence();
    const beforeSnapshot: SessionSnapshot = { manifest: snapshot.manifest, entries: [...snapshot.entries] };

    const result = compact(
      {
        snapshot,
        sessionId: seed.sessionId,
        sourceEntryIds: [u1.entryId, a1.entryId, ev1.entryId, a2.entryId],
        summary: "assert-preserved append-only case",
        evidenceLedgerCursor: 1,
      },
      makeDeps(),
    );

    const afterEntries = [...snapshot.entries, result.entry];
    expect(afterEntries.length).toBe(snapshot.entries.length + 1);
    expect(() => assertEvidencePreserved(beforeSnapshot, afterEntries)).not.toThrow();
  });
});

// --- 5. Rebuild after compaction (SC_R07_COMPACTION_REBUILDS_REFERENCES) ----

describe("rebuildBoundedContext — rebuild references after compaction (SC_R07)", () => {
  test("rebuilds references from the derived entry + preserved history, and summaryHash matches the compaction's", () => {
    const { snapshot, u1, a1, ev1, a2 } = buildSnapshotWithEvidence();
    const sourceEntryIds = [u1.entryId, a1.entryId, ev1.entryId, a2.entryId];

    const { compaction } = compact(
      { snapshot, sessionId: seed.sessionId, sourceEntryIds, summary: "rebuild-context summary", evidenceLedgerCursor: 1 },
      makeDeps(),
    );

    const rebuilt = rebuildBoundedContext({ snapshot, compaction }, { clock: makeDeps().clock });

    expect(rebuilt.summaryHash).toBe(compaction.summaryHash);
    // The same project scope (source range) is addressable...
    for (const id of sourceEntryIds) {
      expect(rebuilt.references).toContain(id);
    }
    // ...and the same evidence ids remain addressable.
    if (ev1.entry.type !== "evidence_link") {
      throw new Error("expected ev1 to be an evidence_link entry");
    }
    expect(rebuilt.references).toContain(ev1.entry.artifactRef.artifactId);
  });

  test("two rebuilds over identical input are deterministic (deep-equal)", () => {
    const { snapshot, u1, a1, ev1, a2 } = buildSnapshotWithEvidence();
    const sourceEntryIds = [u1.entryId, a1.entryId, ev1.entryId, a2.entryId];

    const { compaction } = compact(
      { snapshot, sessionId: seed.sessionId, sourceEntryIds, summary: "determinism-check summary", evidenceLedgerCursor: 1 },
      makeDeps(),
    );

    const first = rebuildBoundedContext({ snapshot, compaction }, { clock: makeDeps().clock });
    const second = rebuildBoundedContext({ snapshot, compaction }, { clock: makeDeps().clock });

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

// --- 6. Determinism of compact itself ----------------------------------------

describe("compact — deterministic across independently-seeded calls", () => {
  test("two compact calls with identical input + fresh injected clock/id produce identical CompactionEntry", () => {
    const { snapshot, u1, a1, ev1, a2 } = buildSnapshotWithEvidence();
    const input = {
      snapshot,
      sessionId: seed.sessionId,
      sourceEntryIds: [u1.entryId, a1.entryId, ev1.entryId, a2.entryId],
      summary: "byte-identical determinism summary",
      evidenceLedgerCursor: 1,
    };

    const first = compact(input, makeDeps());
    const second = compact(input, makeDeps());

    expect(second.compaction).toEqual(first.compaction);
    expect(second.compaction.summaryHash).toBe(first.compaction.summaryHash);
    expect(second.compaction.compactionId).toBe(first.compaction.compactionId);
    expect(second.compaction.derivedEntryId).toBe(first.compaction.derivedEntryId);
    expect(second.entry.entryId).toBe(first.entry.entryId);
  });

  test("compact never touches Date.now/Math.random-derived state — identical fixed clock output round-trips", () => {
    const { snapshot, u1, a1 } = buildSnapshotWithEvidence();
    const deps = makeDeps();

    const result = compact(
      { snapshot, sessionId: seed.sessionId, sourceEntryIds: [u1.entryId, a1.entryId], summary: "clock summary", evidenceLedgerCursor: 0 },
      deps,
    );

    expect(result.compaction.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result.entry.timestamp).toBe("2026-01-01T00:00:00.000Z");
  });
});

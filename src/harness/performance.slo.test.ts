// Deterministic performance/SLO bound suite (flow 017 W15 H-01, dispatch
// 017-T7, AC4 "performance"). Test-only: exercises the EXISTING
// `src/harness/session/session.ts` (`AppendOnlySession`), `src/harness/resume/
// store.ts` (`InMemorySessionStore`), and `src/harness/branch/compaction.ts`
// (`compact`, `rebuildBoundedContext`) surfaces. No production code is edited
// or added here.
//
// Per the frozen AC4 language: "DETERMINISTIC bounds (no wall-clock): assert
// bounded growth -- e.g. appending N events yields exactly N entries (no
// unbounded duplication), content-fingerprint dedup keeps the session from
// growing on identical re-appends, a compaction/branch operation does not
// increase total retained evidence beyond its inputs." Every assertion below
// is a COUNT/size check over in-memory structures -- there is no
// `Date.now`/`Math.random`/timer anywhere in this file, and every clock/id is
// injected via `makeDeps()`.
import { describe, expect, test } from "bun:test";
import { compact, rebuildBoundedContext } from "./branch/compaction";
import { InMemorySessionStore } from "./resume/store";
import type { SessionSnapshot } from "./resume/store";
import { AppendOnlySession } from "./session/session";
import type { SessionSeed } from "./session/types";

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
  sessionId: "session-perf-slo-1",
  runId: "run-perf-slo-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  policyFingerprint: "a".repeat(64),
  contextManifestHash: "b".repeat(64),
};

// ---------------------------------------------------------------------------
// 1. Appending N distinct events yields exactly N entries -- no unbounded
//    duplication.
// ---------------------------------------------------------------------------
describe("AppendOnlySession — bounded growth: N distinct appends yield exactly N entries", () => {
  test("appending 50 distinct chained entries yields exactly 50 entries, no more, no fewer", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const N = 50;
    let parentEntryId: string | undefined;

    for (let i = 0; i < N; i += 1) {
      const appended = session.append({ type: "assistant_message", text: `perf-slo distinct message ${i}` }, parentEntryId ? { parentEntryId } : undefined);
      parentEntryId = appended.entryId;
    }

    expect(session.entries()).toHaveLength(N);
    expect(session.manifest().appendCursor).toBe(N);
  });
});

// ---------------------------------------------------------------------------
// 2. Content-fingerprint dedup keeps the session from growing on identical
//    re-appends.
// ---------------------------------------------------------------------------
describe("AppendOnlySession — content-fingerprint dedup bounds re-append growth", () => {
  test("re-appending the SAME payload+parent 25 times keeps the session at exactly 1 entry (not 25)", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const payload = { type: "user_message" as const, text: "identical content re-appended repeatedly" };
    const REPEAT_COUNT = 25;

    const first = session.append(payload);
    for (let i = 1; i < REPEAT_COUNT; i += 1) {
      const again = session.append(payload);
      // Every re-append returns the SAME existing entry, not a new one.
      expect(again.entryId).toBe(first.entryId);
    }

    expect(session.entries()).toHaveLength(1);
    expect(session.manifest().appendCursor).toBe(1);
  });

  test("mixing 10 distinct appends with 10 duplicate re-appends of the FIRST of them yields exactly 10 entries total", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const distinctCount = 10;
    const entryIds: string[] = [];

    let parentEntryId: string | undefined;
    for (let i = 0; i < distinctCount; i += 1) {
      const appended = session.append({ type: "assistant_message", text: `distinct-${i}` }, parentEntryId ? { parentEntryId } : undefined);
      entryIds.push(appended.entryId);
      parentEntryId = appended.entryId;
    }
    expect(session.entries()).toHaveLength(distinctCount);

    // Re-append the FIRST distinct entry's exact payload+parent 10 times:
    // content-fingerprint dedup must keep the total at `distinctCount`, not
    // `distinctCount + 10`.
    for (let i = 0; i < 10; i += 1) {
      session.append({ type: "assistant_message", text: "distinct-0" });
    }
    expect(session.entries()).toHaveLength(distinctCount);
  });
});

// ---------------------------------------------------------------------------
// 3. InMemorySessionStore.append is idempotent by entryId -- bounded growth
//    under a repeated (e.g. crash/resume-replayed) append.
// ---------------------------------------------------------------------------
describe("InMemorySessionStore.append — idempotent-by-entryId append bounds growth under replayed appends", () => {
  test("appending the SAME entry object to the store 20 times leaves the snapshot at exactly 1 entry", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const entry = session.append({ type: "user_message", text: "replayed append fixture" });

    const store = new InMemorySessionStore({
      [seed.sessionId]: { manifest: session.manifest(), entries: [] },
    });

    const REPEAT_COUNT = 20;
    for (let i = 0; i < REPEAT_COUNT; i += 1) {
      store.append(seed.sessionId, entry);
    }

    const snapshot = store.read(seed.sessionId);
    expect(snapshot?.entries).toHaveLength(1);
    expect(snapshot?.manifest.appendCursor).toBe(1);
  });

  test("appending K distinct entries once each yields exactly K entries in the store", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const K = 15;
    const entries = [];
    let parentEntryId: string | undefined;
    for (let i = 0; i < K; i += 1) {
      const appended = session.append({ type: "assistant_message", text: `store-distinct-${i}` }, parentEntryId ? { parentEntryId } : undefined);
      entries.push(appended);
      parentEntryId = appended.entryId;
    }

    const store = new InMemorySessionStore({
      [seed.sessionId]: { manifest: session.manifest(), entries: [] },
    });
    for (const entry of entries) {
      store.append(seed.sessionId, entry);
    }

    expect(store.read(seed.sessionId)?.entries).toHaveLength(K);
  });
});

// ---------------------------------------------------------------------------
// 4. A compaction over K source entries produces exactly ONE new derived
//    entry -- total retained evidence grows by 1, never proportionally to K.
// ---------------------------------------------------------------------------
describe("compact — a compaction operation does not increase total retained evidence beyond its inputs (bounded by +1)", () => {
  function buildSnapshotWithNEntries(n: number): { snapshot: SessionSnapshot; entryIds: string[] } {
    const session = new AppendOnlySession(seed, makeDeps());
    const entryIds: string[] = [];
    let parentEntryId: string | undefined;
    for (let i = 0; i < n; i += 1) {
      const appended = session.append(
        i % 3 === 0
          ? { type: "evidence_link" as const, artifactRef: artifactRef(`compaction-evidence-${i}`) }
          : { type: "assistant_message" as const, text: `compaction source ${i}` },
        parentEntryId ? { parentEntryId } : undefined,
      );
      entryIds.push(appended.entryId);
      parentEntryId = appended.entryId;
    }
    const snapshot: SessionSnapshot = { manifest: session.manifest(), entries: session.entries() };
    return { snapshot, entryIds };
  }

  test("compacting 10 source entries adds exactly 1 derived entry, regardless of source count", () => {
    const { snapshot, entryIds } = buildSnapshotWithNEntries(10);
    const before = snapshot.entries.length;

    const result = compact(
      { snapshot, sessionId: seed.sessionId, sourceEntryIds: entryIds, summary: "bounded compaction summary", evidenceLedgerCursor: 3 },
      makeDeps(),
    );

    const after = [...snapshot.entries, result.entry];
    expect(after.length).toBe(before + 1);
  });

  test("compacting 30 source entries STILL adds exactly 1 derived entry (bound is independent of K)", () => {
    const { snapshot, entryIds } = buildSnapshotWithNEntries(30);
    const before = snapshot.entries.length;

    const result = compact(
      { snapshot, sessionId: seed.sessionId, sourceEntryIds: entryIds, summary: "bounded compaction summary, large K", evidenceLedgerCursor: 10 },
      makeDeps(),
    );

    const after = [...snapshot.entries, result.entry];
    expect(after.length).toBe(before + 1);
    // The +1 bound holds regardless of how many entries were compacted.
    expect(after.length).not.toBe(before + entryIds.length);
  });
});

// ---------------------------------------------------------------------------
// 5. rebuildBoundedContext dedups references -- repeated evidence ids don't
//    grow the reference list unboundedly.
// ---------------------------------------------------------------------------
describe("rebuildBoundedContext — deduplicated references bound growth under repeated evidence ids", () => {
  test("N evidence_link entries pointing at the SAME artifactId contribute exactly ONE deduplicated reference", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const repeatedArtifactId = "repeated-evidence-artifact";
    let parentEntryId: string | undefined;
    const N = 12;

    for (let i = 0; i < N; i += 1) {
      // Distinct parent chains so each evidence_link is a genuinely new
      // (non-deduplicated-by-content) entry, yet all point at the SAME
      // underlying artifactId.
      const anchor = session.append({ type: "assistant_message", text: `anchor-${i}` }, parentEntryId ? { parentEntryId } : undefined);
      const link = session.append(
        { type: "evidence_link", artifactRef: artifactRef(repeatedArtifactId) },
        { parentEntryId: anchor.entryId, evidenceId: `evidence-repeat-${i}` },
      );
      parentEntryId = link.entryId;
    }

    const snapshot: SessionSnapshot = { manifest: session.manifest(), entries: session.entries() };
    const sourceEntryIds = snapshot.entries.map((entry) => entry.entryId);
    const { compaction } = compact(
      { snapshot, sessionId: seed.sessionId, sourceEntryIds, summary: "dedup rebuild summary", evidenceLedgerCursor: N },
      makeDeps(),
    );

    const rebuilt = rebuildBoundedContext({ snapshot, compaction }, { clock: makeDeps().clock });

    // Exactly one deduplicated reference for the repeated artifactId, no
    // matter how many evidence_link entries pointed at it.
    const repeatedRefs = rebuilt.references.filter((ref) => ref === repeatedArtifactId);
    expect(repeatedRefs).toHaveLength(1);
  });

  test("rebuilding twice over identical input produces the SAME bounded reference count (no accumulation across calls)", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const u1 = session.append({ type: "user_message", text: "rebuild-bound start" });
    const ev1 = session.append(
      { type: "evidence_link", artifactRef: artifactRef("rebuild-bound-evidence") },
      { parentEntryId: u1.entryId },
    );
    const snapshot: SessionSnapshot = { manifest: session.manifest(), entries: session.entries() };
    const { compaction } = compact(
      { snapshot, sessionId: seed.sessionId, sourceEntryIds: [u1.entryId, ev1.entryId], summary: "rebuild-bound summary", evidenceLedgerCursor: 1 },
      makeDeps(),
    );

    const first = rebuildBoundedContext({ snapshot, compaction }, { clock: makeDeps().clock });
    const second = rebuildBoundedContext({ snapshot, compaction }, { clock: makeDeps().clock });
    const third = rebuildBoundedContext({ snapshot, compaction }, { clock: makeDeps().clock });

    expect(first.references.length).toBe(second.references.length);
    expect(second.references.length).toBe(third.references.length);
    expect(third).toEqual(first);
  });
});

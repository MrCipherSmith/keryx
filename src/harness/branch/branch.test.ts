// RED tests for W9 / B-01 (append-only branching), flow 012, dispatch 012-T5.
//
// Pins the Release 1 append-only BRANCHING contract per
// docs/requirements/keryx-project-agent-harness/acceptance.feature
// `@task-B-01` scenario:
//   - @SC_R06_BRANCH_TREE   "Preserve branch ancestry"
//     Given a session forks at an immutable entry
//     When the new branch becomes current
//     Then branchId, forkEntryId, current leaf, and immutable ancestors are
//     persisted And merge remains excluded from v1.
//
// B-01 impl (next dispatch) implements `src/harness/branch/branch.ts`
// (`BranchMetadata`, `forkBranch`, `currentLeaf`, `MergeDecision`,
// `mergeBranches`) to make this suite GREEN; until then the missing-module
// import below is the expected RED failure ("Cannot find module './branch'").
//
// Reuses (unmodified, GREEN elsewhere):
//   - W7 src/harness/session/{session,types}.ts — AppendOnlySession,
//     SessionEntry, SessionSeed (a `branch_metadata` SessionEntryPayload
//     variant already exists: `{ type: "branch_metadata", artifactRef }`).
//   - W8 src/harness/resume/store.ts — SessionSnapshot, InMemorySessionStore
//     (used here to exercise "append the branch entry without mutating prior
//     history" without inventing a new store).
//   - src/contracts/validator.ts — validateAgainstSchema against the FROZEN
//     branch-metadata.schema.json / session-entry.schema.json.
//
// --- DESIGN ASSUMPTIONS PINNED BY THIS SUITE (B-01 impl must satisfy) -------
// The dispatch's sketch does not fix every shape; this suite pins the
// following so a concrete B-01 impl has a single, unambiguous target:
//   1. `immutableAncestorIds` is INCLUSIVE of `forkEntryId` itself, walking
//      back through `causal.parentEventId` to the root. For a root fork
//      (forkEntryId has no parent) this is `[forkEntryId]` — still non-empty,
//      satisfying the schema's `nonEmptyStringArray` (minItems 1). A deeper
//      fork's ancestor set is therefore always a superset of a shallower
//      fork's ancestor set take from the same chain.
//   2. `immutableAncestorIds` (and the returned `branch` object generally) is
//      deep-frozen, mirroring the `deepFreeze` convention already used by
//      `AppendOnlySession` in `session.ts` — mutating the returned array must
//      not be observable in a fresh, deterministic recomputation from the
//      same input.
//   3. `leafEntryId` equals the entryId of the returned `entry` (forking
//      appends one new `branch_metadata` marker entry as a child of
//      `forkEntryId`, and that marker becomes the new branch's leaf).
//      `currentLeaf(branch)` is exactly `branch.leafEntryId`.
//   4. `forkBranch` is PURE with respect to its input `snapshot`: it never
//      pushes into `snapshot.entries` or mutates `snapshot.manifest`. The
//      caller persists the returned `entry` explicitly (e.g. via
//      `SessionStore.append`), matching the append-only session's own
//      "returns a value, caller persists it" shape.
//   5. There is no dedicated "switch" export in the pinned API. "Atomic
//      switch, no history mutation" is exercised here as: reading
//      `currentLeaf()` for either of two sibling branches, and moving the
//      snapshot manifest's `currentLeafEntryId` pointer between them, changes
//      only that pointer — `snapshot.entries` is never deleted, reordered, or
//      rewritten.
//   6. `mergeBranches` ALWAYS returns `{ kind: "rejected", reason }` in v1
//      (no-merge-v1, AC2) and never mutates either input `BranchMetadata` nor
//      the underlying session snapshot.
//
// Deterministic: `deps.clock`/`deps.idSeq` are fixed via `makeDeps()`; no
// `Date.now()`, `Math.random()`, or network anywhere in this file. No real
// filesystem — `InMemorySessionStore` is the in-process W8 fake.
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";
import { InMemorySessionStore, type SessionSnapshot } from "../resume/store";
import { AppendOnlySession } from "../session/session";
import type { SessionEntry, SessionSeed } from "../session/types";

// PINNED API (see dispatch 012-T5) — B-01 impl exports these from
// `./branch`; the import fails until then (expected RED: "Cannot find module
// './branch'").
import { currentLeaf, forkBranch, mergeBranches } from "./branch";

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
// Mirrors `src/harness/session/session.test.ts` / `src/harness/resume/resume.test.ts`
// `makeDeps()`.
// ---------------------------------------------------------------------------
function makeDeps(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return {
    clock: () => "2026-01-01T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
  };
}

const seed: SessionSeed = {
  sessionId: "session-branch-1",
  runId: "run-branch-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  policyFingerprint: "a".repeat(64),
  contextManifestHash: "b".repeat(64),
};

/** A three-entry chain: root -> mid -> leaf, wrapped as a persisted snapshot. */
function buildChainSnapshot(): {
  snapshot: SessionSnapshot;
  root: SessionEntry;
  mid: SessionEntry;
  leaf: SessionEntry;
} {
  const session = new AppendOnlySession(seed, makeDeps());
  const root = session.append({ type: "user_message", text: "root" });
  const mid = session.append({ type: "assistant_message", text: "mid" }, { parentEntryId: root.entryId });
  const leaf = session.append({ type: "assistant_message", text: "leaf" }, { parentEntryId: mid.entryId });
  const snapshot: SessionSnapshot = { manifest: session.manifest(), entries: session.entries() };
  return { snapshot, root, mid, leaf };
}

// --- 1. Branch metadata valid ------------------------------------------------

describe("forkBranch — branch metadata validity (AC1)", () => {
  test("produces a BranchMetadata that validates against branch-metadata.schema.json", () => {
    const { snapshot, root, mid } = buildChainSnapshot();
    const result = forkBranch(
      { snapshot, sessionId: seed.sessionId, forkEntryId: mid.entryId, branchId: "branch-1" },
      makeDeps(),
    );

    expect(result.branch.schemaVersion).toBe(1);
    expect(result.branch.sessionId).toBe(seed.sessionId);
    expect(result.branch.forkEntryId).toBe(mid.entryId);
    expect(result.branch.leafEntryId.length).toBeGreaterThan(0);
    expect(result.branch.immutableAncestorIds.length).toBeGreaterThan(0);
    expect(result.branch.immutableAncestorIds).toContain(root.entryId);
    expect(result.branch.immutableAncestorIds).toContain(mid.entryId);
    expect(Object.isFrozen(result.branch.immutableAncestorIds)).toBe(true);

    const validation = validateAgainstSchema("branch-metadata.schema.json", result.branch, { schemaDir: SCHEMA_DIR });
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  test("a root fork (no ancestor entry) still produces a non-empty immutableAncestorIds", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const root = session.append({ type: "user_message", text: "root-only" });
    const snapshot: SessionSnapshot = { manifest: session.manifest(), entries: session.entries() };

    const result = forkBranch(
      { snapshot, sessionId: seed.sessionId, forkEntryId: root.entryId, branchId: "branch-root" },
      makeDeps(),
    );

    expect(result.branch.forkEntryId).toBe(root.entryId);
    expect(result.branch.immutableAncestorIds.length).toBeGreaterThan(0);
    expect(result.branch.immutableAncestorIds).toContain(root.entryId);

    const validation = validateAgainstSchema("branch-metadata.schema.json", result.branch, { schemaDir: SCHEMA_DIR });
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  test("leafEntryId matches the returned entry's entryId, and currentLeaf(branch) resolves to it", () => {
    const { snapshot, mid } = buildChainSnapshot();
    const result = forkBranch(
      { snapshot, sessionId: seed.sessionId, forkEntryId: mid.entryId, branchId: "branch-2" },
      makeDeps(),
    );

    expect(result.branch.leafEntryId).toBe(result.entry.entryId);
    expect(currentLeaf(result.branch)).toBe(result.branch.leafEntryId);
  });

  test("branchId defaults to a non-empty generated id when omitted", () => {
    const { snapshot, mid } = buildChainSnapshot();
    const result = forkBranch({ snapshot, sessionId: seed.sessionId, forkEntryId: mid.entryId }, makeDeps());

    expect(typeof result.branch.branchId).toBe("string");
    expect(result.branch.branchId.length).toBeGreaterThan(0);
  });
});

// --- 2. Ancestry preserved (SC_R06_BRANCH_TREE) ------------------------------

describe("forkBranch — ancestry preserved and immutable (SC_R06_BRANCH_TREE)", () => {
  test("mutating the returned immutableAncestorIds array does not change a fresh recomputation from the same input", () => {
    const { snapshot, mid } = buildChainSnapshot();
    const first = forkBranch(
      { snapshot, sessionId: seed.sessionId, forkEntryId: mid.entryId, branchId: "branch-fixed" },
      makeDeps(),
    );
    const before = [...first.branch.immutableAncestorIds];

    // immutableAncestorIds is deep-frozen (AC1) — any mutation attempt throws in
    // strict-mode ESM. Assert that (immutability enforced) rather than a silent
    // no-op, and confirm the recorded ancestry is untouched by the attempt.
    const mutable = first.branch.immutableAncestorIds as unknown as string[];
    expect(() => mutable.push("forged-ancestor")).toThrow();
    const firstElement = mutable[0];
    if (firstElement !== undefined) {
      expect(() => {
        mutable[0] = "forged-overwrite";
      }).toThrow();
    }

    const second = forkBranch(
      { snapshot, sessionId: seed.sessionId, forkEntryId: mid.entryId, branchId: "branch-fixed" },
      makeDeps(),
    );

    expect(second.branch.immutableAncestorIds).toEqual(before);
  });

  test("mutating the snapshot after forking does not change the already-recorded branch", () => {
    const { snapshot, mid } = buildChainSnapshot();
    const result = forkBranch(
      { snapshot, sessionId: seed.sessionId, forkEntryId: mid.entryId, branchId: "branch-3" },
      makeDeps(),
    );
    const capturedBranch = JSON.stringify(result.branch);

    // Simulate a rewrite/deletion attempt on the snapshot after the fork.
    snapshot.entries.length = 0;

    expect(JSON.stringify(result.branch)).toBe(capturedBranch);
  });

  test("a second forkBranch from a deeper entry includes the earlier ancestors", () => {
    const { snapshot, mid, leaf } = buildChainSnapshot();
    const shallow = forkBranch(
      { snapshot, sessionId: seed.sessionId, forkEntryId: mid.entryId, branchId: "branch-shallow" },
      makeDeps(),
    );
    const deep = forkBranch(
      { snapshot, sessionId: seed.sessionId, forkEntryId: leaf.entryId, branchId: "branch-deep" },
      makeDeps(),
    );

    for (const id of shallow.branch.immutableAncestorIds) {
      expect(deep.branch.immutableAncestorIds).toContain(id);
    }
    expect(deep.branch.immutableAncestorIds.length).toBeGreaterThan(shallow.branch.immutableAncestorIds.length);
  });
});

// --- 3. Append-only branch entry ---------------------------------------------

describe("forkBranch — append-only branch_metadata entry", () => {
  test("the returned entry is a schema-valid branch_metadata SessionEntry", () => {
    const { snapshot, mid } = buildChainSnapshot();
    const result = forkBranch(
      { snapshot, sessionId: seed.sessionId, forkEntryId: mid.entryId, branchId: "branch-entry" },
      makeDeps(),
    );

    expect(result.entry.entry.type).toBe("branch_metadata");
    if (result.entry.entry.type !== "branch_metadata") {
      throw new Error("expected a branch_metadata entry payload");
    }
    expect(result.entry.entry.artifactRef.artifactId.length).toBeGreaterThan(0);
    expect(result.entry.entry.artifactRef.hash).toMatch(/^[a-f0-9]{64}$/);

    const validation = validateAgainstSchema("session-entry.schema.json", result.entry, { schemaDir: SCHEMA_DIR });
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  test("appending the entry via the session store does not mutate prior entries", () => {
    const { snapshot, mid } = buildChainSnapshot();
    const priorEntriesJson = JSON.stringify(snapshot.entries);

    const result = forkBranch(
      { snapshot, sessionId: seed.sessionId, forkEntryId: mid.entryId, branchId: "branch-store" },
      makeDeps(),
    );

    const store = new InMemorySessionStore({ [seed.sessionId]: snapshot });
    store.append(seed.sessionId, result.entry);

    const persisted = store.read(seed.sessionId);
    if (!persisted) throw new Error("expected a persisted snapshot after append");
    const priorAfter = persisted.entries.filter((entry) => entry.entryId !== result.entry.entryId);

    expect(JSON.stringify(priorAfter)).toBe(priorEntriesJson);
    expect(persisted.entries.some((entry) => entry.entryId === result.entry.entryId)).toBe(true);
  });
});

// --- 4. Atomic switch, no history mutation -----------------------------------

describe("branch — atomic switch between branches, no history mutation", () => {
  test("currentLeaf resolves independently per branch without mutating the snapshot's entries", () => {
    const { snapshot, mid, leaf } = buildChainSnapshot();
    const entriesBefore = JSON.stringify(snapshot.entries);

    const branchA = forkBranch(
      { snapshot, sessionId: seed.sessionId, forkEntryId: mid.entryId, branchId: "branch-a" },
      makeDeps(),
    );
    const branchB = forkBranch(
      { snapshot, sessionId: seed.sessionId, forkEntryId: leaf.entryId, branchId: "branch-b" },
      makeDeps(),
    );

    expect(currentLeaf(branchA.branch)).toBe(branchA.branch.leafEntryId);
    expect(currentLeaf(branchB.branch)).toBe(branchB.branch.leafEntryId);
    expect(currentLeaf(branchA.branch)).not.toBe(currentLeaf(branchB.branch));

    // Reading the current leaf for either branch never touches session history.
    expect(JSON.stringify(snapshot.entries)).toBe(entriesBefore);
  });

  test("switching the active-leaf pointer between two branches never deletes or rewrites entries", () => {
    const { snapshot, mid, leaf } = buildChainSnapshot();
    const originalEntries = [...snapshot.entries];

    const branchA = forkBranch(
      { snapshot, sessionId: seed.sessionId, forkEntryId: mid.entryId, branchId: "branch-switch-a" },
      makeDeps(),
    );
    const branchB = forkBranch(
      { snapshot, sessionId: seed.sessionId, forkEntryId: leaf.entryId, branchId: "branch-switch-b" },
      makeDeps(),
    );

    // "Switching" is moving which branch's leaf is the manifest's active
    // pointer; it must only move that pointer, never touch entries.
    snapshot.manifest.currentLeafEntryId = currentLeaf(branchA.branch);
    expect(snapshot.entries).toEqual(originalEntries);
    expect(snapshot.entries).toHaveLength(originalEntries.length);

    snapshot.manifest.currentLeafEntryId = currentLeaf(branchB.branch);
    expect(snapshot.entries).toEqual(originalEntries);
    expect(snapshot.entries).toHaveLength(originalEntries.length);

    // Both fork points and all original entries remain reachable/unchanged.
    for (const original of originalEntries) {
      const found = snapshot.entries.find((entry) => entry.entryId === original.entryId);
      expect(found).toEqual(original);
    }
  });
});

// --- 5. no-merge-v1 (AC2) -----------------------------------------------------

describe("mergeBranches — no-merge-v1 (AC2)", () => {
  test("merge is always rejected with a typed, non-empty reason and never mutates either branch", () => {
    const { snapshot, mid, leaf } = buildChainSnapshot();
    const a = forkBranch(
      { snapshot, sessionId: seed.sessionId, forkEntryId: mid.entryId, branchId: "branch-merge-a" },
      makeDeps(),
    );
    const b = forkBranch(
      { snapshot, sessionId: seed.sessionId, forkEntryId: leaf.entryId, branchId: "branch-merge-b" },
      makeDeps(),
    );
    const aBefore = JSON.stringify(a.branch);
    const bBefore = JSON.stringify(b.branch);

    const decision = mergeBranches(a.branch, b.branch);

    expect(decision.kind).toBe("rejected");
    expect(typeof decision.reason).toBe("string");
    expect(decision.reason.length).toBeGreaterThan(0);

    expect(JSON.stringify(a.branch)).toBe(aBefore);
    expect(JSON.stringify(b.branch)).toBe(bBefore);
  });

  test("merge rejection does not mutate the underlying session snapshot", () => {
    const { snapshot, mid, leaf } = buildChainSnapshot();
    const a = forkBranch(
      { snapshot, sessionId: seed.sessionId, forkEntryId: mid.entryId, branchId: "branch-merge-c" },
      makeDeps(),
    );
    const b = forkBranch(
      { snapshot, sessionId: seed.sessionId, forkEntryId: leaf.entryId, branchId: "branch-merge-d" },
      makeDeps(),
    );
    const entriesBefore = JSON.stringify(snapshot.entries);
    const manifestBefore = JSON.stringify(snapshot.manifest);

    mergeBranches(a.branch, b.branch);

    expect(JSON.stringify(snapshot.entries)).toBe(entriesBefore);
    expect(JSON.stringify(snapshot.manifest)).toBe(manifestBefore);
  });
});

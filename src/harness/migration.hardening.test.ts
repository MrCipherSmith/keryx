// Hardening/regression-lock suite for read-time `schemaVersion` migration
// (flow 017 W15 H-01, dispatch 017-T7, AC4 "migration"). Test-only:
// exercises the EXISTING `src/harness/session/session.ts` (`migrateSession`,
// `SchemaMigrationError`) and the EXISTING `src/flow/store.ts` (`migrateFlow`)
// surfaces. No production code is edited or added here.
//
// Both migrations are PURE, synchronous, in-memory functions -- `migrateFlow`
// takes/returns a plain `FlowState` object and `migrateSession` takes/returns
// plain `manifest`/`entries` records, so this whole suite runs with ZERO real
// filesystem access (unlike `src/flow/migration.test.ts`, which exercises the
// same `migrateFlow` logic indirectly through `readFlow`'s fs-backed read
// path -- this suite pins the pure migration function directly).
//
// Per the frozen AC4 language: "a v1 session/flow fixture migrated twice
// yields byte-identical output; an unknown/newer schemaVersion is handled
// safely ... matching existing behavior ... ; migration never mutates the
// on-disk/original input object."
//
// Deterministic: no Date.now/Math.random/network/real fs anywhere in this
// file.
import { describe, expect, test } from "bun:test";
import { migrateFlow } from "../flow/store";
import type { FlowState, FlowTask } from "../flow/types";
import { migrateSession, SchemaMigrationError } from "./session/session";

// ---------------------------------------------------------------------------
// Part A -- session migration (src/harness/session/session.ts:migrateSession)
// ---------------------------------------------------------------------------

const priorManifestV0: Record<string, unknown> = {
  schemaVersion: 0,
  sessionId: "session-migration-hardening-1",
  runId: "run-migration-hardening-1",
  createdAt: "2025-01-01T00:00:00.000Z",
};
const priorEntriesV0: Record<string, unknown>[] = [
  {
    schemaVersion: 0,
    entryId: "entry-migration-hardening-1",
    sequence: 0,
    timestamp: "2025-01-01T00:00:00.000Z",
    entry: { type: "user_message", text: "hardening legacy hello" },
  },
  {
    schemaVersion: 0,
    entryId: "entry-migration-hardening-2",
    sequence: 1,
    timestamp: "2025-01-01T00:01:00.000Z",
    entry: { type: "assistant_message", text: "hardening legacy reply" },
  },
];

describe("migrateSession — deterministic and idempotent (AC4 migration, session)", () => {
  test("migrating the same v1 (schemaVersion 0) session fixture TWICE yields byte-identical output", () => {
    const first = migrateSession({ manifest: priorManifestV0, entries: priorEntriesV0 });
    const second = migrateSession({ manifest: priorManifestV0, entries: priorEntriesV0 });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second).toEqual(first);
  });

  test("migrating an empty-entries session is deterministic and produces a schema-1 manifest with a stable synthetic leaf", () => {
    const emptyManifest: Record<string, unknown> = {
      schemaVersion: 0,
      sessionId: "session-migration-hardening-empty",
      runId: "run-migration-hardening-empty",
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    const first = migrateSession({ manifest: emptyManifest, entries: [] });
    const second = migrateSession({ manifest: emptyManifest, entries: [] });

    expect(first.entries).toHaveLength(0);
    expect(first.manifest.appendCursor).toBe(0);
    expect(first.manifest.currentLeafEntryId.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  test("an unparseable (NaN) schemaVersion is rejected the same way as an unsupported future version (fail-closed, matching existing behavior)", () => {
    const nanVersion = { ...priorManifestV0, schemaVersion: Number.NaN };
    const futureVersion = { ...priorManifestV0, schemaVersion: 42 };

    expect(() => migrateSession({ manifest: nanVersion, entries: priorEntriesV0 })).toThrow(SchemaMigrationError);
    expect(() => migrateSession({ manifest: nanVersion, entries: priorEntriesV0 })).toThrow(/schemaVersion/i);
    expect(() => migrateSession({ manifest: futureVersion, entries: priorEntriesV0 })).toThrow(SchemaMigrationError);
  });

  test("a non-numeric (string) schemaVersion also fails closed rather than silently defaulting", () => {
    const stringVersion = { ...priorManifestV0, schemaVersion: "not-a-version" };
    expect(() => migrateSession({ manifest: stringVersion, entries: priorEntriesV0 })).toThrow(SchemaMigrationError);
  });

  test("migration never mutates the caller's original manifest/entries objects, including nested entry payloads", () => {
    const manifestSnapshot = JSON.stringify(priorManifestV0);
    const entriesSnapshot = JSON.stringify(priorEntriesV0);
    const firstEntryPayloadRef = priorEntriesV0[0]?.entry;

    const migrated = migrateSession({ manifest: priorManifestV0, entries: priorEntriesV0 });

    expect(JSON.stringify(priorManifestV0)).toBe(manifestSnapshot);
    expect(JSON.stringify(priorEntriesV0)).toBe(entriesSnapshot);
    // The migrated entry's payload is a clone, not the same reference as the
    // caller's original nested object.
    expect(migrated.entries[0]?.entry).not.toBe(firstEntryPayloadRef);
    expect(JSON.stringify(migrated.entries[0]?.entry)).toBe(JSON.stringify(firstEntryPayloadRef));
  });

  test("migrated output is schema-1 shaped and independent of prior entries' array identity (fresh array each call)", () => {
    const first = migrateSession({ manifest: priorManifestV0, entries: priorEntriesV0 });
    const second = migrateSession({ manifest: priorManifestV0, entries: priorEntriesV0 });

    expect(first.manifest.schemaVersion).toBe(1);
    expect(first.entries).not.toBe(second.entries);
    expect(first.entries).toEqual(second.entries);
  });
});

// ---------------------------------------------------------------------------
// Part B -- flow migration (src/flow/store.ts:migrateFlow)
// ---------------------------------------------------------------------------

function v1Task(overrides: Partial<FlowTask> & Pick<FlowTask, "id" | "title" | "kind" | "status">): FlowTask {
  return { ...overrides };
}

function v1Flow(tasks: FlowTask[]): FlowState {
  const createdAt = "2026-07-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    id: "017",
    slug: "migration-hardening-fixture",
    title: "Migration hardening fixture flow",
    status: "in-progress",
    createdAt,
    updatedAt: createdAt,
    source: { type: "description", ref: null },
    acChecksum: null,
    acConfirmed: {},
    pr: { url: null },
    tasks,
    history: [{ at: createdAt, event: "created" }],
  };
}

describe("migrateFlow — deterministic and idempotent (AC4 migration, flow)", () => {
  test("migrating the same v1 flow fixture TWICE (independently) yields byte-identical output", () => {
    const raw = v1Flow([v1Task({ id: "T1", title: "Collect remaining context", kind: "context", status: "todo" })]);

    const first = migrateFlow(raw);
    const second = migrateFlow(raw);

    expect(first.schemaVersion).toBe(2);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second).toEqual(first);
  });

  test("an already-v2 flow passes through unchanged (idempotent re-migration)", () => {
    const raw = v1Flow([v1Task({ id: "T1", title: "Collect remaining context", kind: "context", status: "todo" })]);
    const migratedOnce = migrateFlow(raw);
    const migratedTwice = migrateFlow(migratedOnce);

    expect(migratedTwice).toEqual(migratedOnce);
    expect(JSON.stringify(migratedTwice)).toBe(JSON.stringify(migratedOnce));
  });

  test("an unsupported/future schemaVersion (3) is rejected deterministically, matching existing behavior", () => {
    const raw = { ...v1Flow([v1Task({ id: "T1", title: "Collect remaining context", kind: "context", status: "todo" })]), schemaVersion: 3 } as unknown as FlowState;

    expect(() => migrateFlow(raw)).toThrow(/schemaVersion/i);
    // Deterministic: repeated calls fail the same way, not intermittently.
    expect(() => migrateFlow(raw)).toThrow(/schemaVersion/i);
  });

  test("migration never mutates the caller's original v1 flow object (including nested tasks/history)", () => {
    const raw = v1Flow([
      v1Task({ id: "T1", title: "Collect remaining context", kind: "context", status: "done" }),
      v1Task({ id: "T2", title: "Implement per plan", kind: "implement", status: "in-progress" }),
    ]);
    const rawSnapshot = JSON.stringify(raw);
    const originalTasksRef = raw.tasks;
    const originalFirstTaskRef = raw.tasks[0];

    const migrated = migrateFlow(raw);

    expect(JSON.stringify(raw)).toBe(rawSnapshot);
    expect(raw.tasks).toBe(originalTasksRef);
    expect(raw.tasks[0]).toBe(originalFirstTaskRef);
    // The migrated result is a NEW object/array, not the caller's original.
    expect(migrated).not.toBe(raw);
    expect(migrated.tasks).not.toBe(raw.tasks);
    expect(migrated.tasks[0]).not.toBe(raw.tasks[0]);
  });

  test("a 'todo' task and a 'done' task migrate to their exact deterministic v2 defaults on every call", () => {
    const raw = v1Flow([
      v1Task({ id: "T1", title: "Collect remaining context", kind: "context", status: "todo" }),
      v1Task({ id: "T2", title: "Implement per plan", kind: "implement", status: "done" }),
    ]);

    const migrated = migrateFlow(raw);
    const todoTask = migrated.tasks[0];
    const doneTask = migrated.tasks[1];

    expect(todoTask?.attempts).toEqual({ count: 0, log: [] });
    expect("disposition" in (todoTask ?? {})).toBe(false);
    expect(doneTask?.disposition).toBe("completed");
    expect(doneTask?.attempts?.count).toBe(1);

    // Idempotent + deterministic: migrating again from the pristine raw
    // fixture reproduces the identical defaults.
    const migratedAgain = migrateFlow(raw);
    expect(migratedAgain).toEqual(migrated);
  });
});

// ---------------------------------------------------------------------------
// Part C -- cross-module consistency: both migrations fail closed the same
// structural way on an unsupported version (typed error mentioning
// "schemaVersion"), matching AC4's "unknown/newer schemaVersion is handled
// safely" for BOTH the session and the flow migration surfaces.
// ---------------------------------------------------------------------------

describe("migration — session and flow migrations both fail closed on an unsupported schemaVersion", () => {
  test("both migrateSession and migrateFlow throw an error whose message mentions 'schemaVersion' for an out-of-range version", () => {
    const futureSession = { ...priorManifestV0, schemaVersion: 99 };
    const futureFlow = {
      ...v1Flow([v1Task({ id: "T1", title: "Collect remaining context", kind: "context", status: "todo" })]),
      schemaVersion: 99,
    } as unknown as FlowState;

    let sessionError: unknown;
    try {
      migrateSession({ manifest: futureSession, entries: priorEntriesV0 });
    } catch (error) {
      sessionError = error;
    }
    let flowError: unknown;
    try {
      migrateFlow(futureFlow);
    } catch (error) {
      flowError = error;
    }

    expect(sessionError).toBeInstanceOf(Error);
    expect(flowError).toBeInstanceOf(Error);
    expect((sessionError as Error).message).toMatch(/schemaVersion/i);
    expect((flowError as Error).message).toMatch(/schemaVersion/i);
  });
});

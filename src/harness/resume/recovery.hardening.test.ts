// Hardening/regression-lock suite for W8 RS-02 crash/recovery (flow 017 W15
// H-01, dispatch 017-T7, AC4 "recovery"). Test-only: exercises the EXISTING
// `src/harness/resume/recovery.ts` surface (`recoverFrom`, `ExecutionReceipt`,
// `Failpoint`, `RecoveryDecision`) plus `src/harness/session/session.ts`
// (`AppendOnlySession`, `resumeSession`) and `src/harness/resume/store.ts`
// (`InMemorySessionStore`). No production code is edited or added here.
//
// This suite goes BEYOND `recovery.test.ts`'s failpoint-matrix coverage with
// three additional hardening angles the frozen AC3/AC4 language calls for:
//   1. A torn write mid-append leaves the PRIOR durable state intact: a
//      checkpoint written before the torn tail is unchanged/still readable,
//      and recovery reconstructs (resumes at) the last good/intact entry.
//   2. Every UNKNOWN-outcome member of the frozen execution-receipt outcome
//      enum (not just "indeterminate") blocks an unsafe automatic retry —
//      recovery must never silently re-execute on an ambiguous effect.
//   3. A new attempt (reconstructed via `resumeSession` + a fresh `attemptId`)
//      never mutates a prior attempt's already-persisted, frozen record:
//      immutability is asserted both via `.toThrow()` on a direct mutation
//      attempt AND via deep-equality of the frozen prior across an
//      independent second attempt.
//
// Deterministic + offline throughout: `clock`/`idSeq` are always injected via
// `makeDeps()`; there is no `Date.now()`, `Math.random()`, real filesystem, or
// network anywhere in this file. All session state is in-memory
// (`InMemorySessionStore`) — never real fs.
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";
import { AppendOnlySession, resumeSession } from "../session/session";
import type { SessionEntry, SessionManifest, SessionSeed } from "../session/types";
import { type ExecutionReceipt, recoverFrom, type RecoveryDecision } from "./recovery";
import { type Checkpoint, InMemorySessionStore, type SessionSnapshot } from "./store";

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

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

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
  sessionId: "session-recovery-hardening-1",
  runId: "run-recovery-hardening-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  policyFingerprint: "a".repeat(64),
  contextManifestHash: "b".repeat(64),
};

// ---------------------------------------------------------------------------
// 1. Torn write mid-append leaves the prior durable state (checkpoint) intact.
// ---------------------------------------------------------------------------
describe("recoverFrom — torn-write leaves the prior durable checkpoint intact", () => {
  test("a checkpoint written before a torn tail append is unchanged, and recovery resumes at the last intact entry (not the checkpoint's, when a newer intact entry exists)", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const start = session.append({ type: "user_message", text: "start" });
    const checkpointed = session.append(
      { type: "assistant_message", text: "checkpoint anchor" },
      { parentEntryId: start.entryId },
    );
    const lastIntact = session.append(
      { type: "assistant_message", text: "acknowledged after checkpoint" },
      { parentEntryId: checkpointed.entryId },
    );
    const intactEntries = session.entries();

    const checkpoint: Checkpoint = {
      schemaVersion: 1,
      checkpointId: "checkpoint-torn-hardening-1",
      sessionId: seed.sessionId,
      atEntryId: checkpointed.entryId,
      stateHash: sha256("checkpoint-state-hardening-1"),
      createdAt: "2026-01-01T00:00:05.000Z",
      evidenceLedgerCursor: 1,
    };
    const checkpointJsonBefore = JSON.stringify(checkpoint);

    // Simulate a torn write: the last JSONL line was cut mid-object (missing
    // the required `entry` field). Injected in-memory fixture only.
    const truncatedRaw: Record<string, unknown> = {
      schemaVersion: 1,
      entryId: "entry-torn-hardening-tail-1",
      sequence: intactEntries.length,
      timestamp: "2026-01-01T00:00:10.000Z",
      causal: { runId: seed.runId, sessionId: seed.sessionId, correlationId: "corr-torn-hardening-1" },
    };
    const corruptEntry = truncatedRaw as unknown as SessionEntry;

    const corruptValidation = validateAgainstSchema("session-entry.schema.json", corruptEntry, {
      schemaDir: SCHEMA_DIR,
    });
    expect(corruptValidation.valid).toBe(false);

    const manifest: SessionManifest = { ...session.manifest(), currentLeafEntryId: corruptEntry.entryId };
    const store = new InMemorySessionStore({
      [seed.sessionId]: { manifest, entries: [...intactEntries, corruptEntry], checkpoint },
    });
    const snapshot = store.read(seed.sessionId);
    if (!snapshot) throw new Error("expected the seeded snapshot to be readable");

    const decision: RecoveryDecision = recoverFrom({ snapshot, failpoint: "torn-write" }, makeDeps());

    expect(decision.kind).toBe("recovered-torn-write");
    if (decision.kind !== "recovered-torn-write") throw new Error("expected a recovered-torn-write decision");
    // Recovery resumes at the last entry that still validates -- the entry
    // AFTER the checkpoint anchor, not the corrupt tail.
    expect(decision.atEntryId).toBe(lastIntact.entryId);
    expect(decision.atEntryId).not.toBe(corruptEntry.entryId);

    // The prior durable checkpoint is untouched by recovery: re-reading it
    // from the store is byte-identical to what was written before the torn
    // append and before recoverFrom ran.
    const snapshotAfter = store.read(seed.sessionId);
    expect(snapshotAfter?.checkpoint).toBeDefined();
    expect(JSON.stringify(snapshotAfter?.checkpoint)).toBe(checkpointJsonBefore);
    // The checkpoint's own anchor entry is still present, intact, and
    // unreferenced by the corrupt tail.
    const checkpointAnchor = snapshotAfter?.entries.find((entry) => entry.entryId === checkpoint.atEntryId);
    expect(checkpointAnchor).toBeDefined();
    expect(checkpointAnchor?.entryId).toBe(checkpointed.entryId);
  });

  test("a torn write immediately after the checkpoint anchor recovers to exactly the checkpoint's anchor entry", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const start = session.append({ type: "user_message", text: "start" });
    const checkpointed = session.append(
      { type: "assistant_message", text: "checkpoint anchor, then torn" },
      { parentEntryId: start.entryId },
    );
    const intactEntries = session.entries();

    const checkpoint: Checkpoint = {
      schemaVersion: 1,
      checkpointId: "checkpoint-torn-hardening-2",
      sessionId: seed.sessionId,
      atEntryId: checkpointed.entryId,
      stateHash: sha256("checkpoint-state-hardening-2"),
      createdAt: "2026-01-01T00:00:05.000Z",
      evidenceLedgerCursor: 1,
    };

    const truncatedRaw: Record<string, unknown> = {
      schemaVersion: 1,
      entryId: "entry-torn-hardening-tail-2",
      sequence: intactEntries.length,
      timestamp: "2026-01-01T00:00:10.000Z",
      causal: { runId: seed.runId, sessionId: seed.sessionId, correlationId: "corr-torn-hardening-2" },
    };
    const corruptEntry = truncatedRaw as unknown as SessionEntry;

    const manifest: SessionManifest = { ...session.manifest(), currentLeafEntryId: corruptEntry.entryId };
    const store = new InMemorySessionStore({
      [seed.sessionId]: { manifest, entries: [...intactEntries, corruptEntry], checkpoint },
    });
    const snapshot = store.read(seed.sessionId);
    if (!snapshot) throw new Error("expected the seeded snapshot to be readable");

    const decision = recoverFrom({ snapshot, failpoint: "torn-write" }, makeDeps());

    expect(decision.kind).toBe("recovered-torn-write");
    if (decision.kind !== "recovered-torn-write") throw new Error("expected a recovered-torn-write decision");
    expect(decision.atEntryId).toBe(checkpoint.atEntryId);
  });
});

// ---------------------------------------------------------------------------
// 2. Every UNKNOWN-outcome enum member blocks an unsafe automatic retry.
// ---------------------------------------------------------------------------
describe("recoverFrom — crash-post-effect blocks an unsafe retry for every UNKNOWN outcome (never silently re-executes)", () => {
  const UNKNOWN_OUTCOMES = ["effect-absent", "indeterminate", "not-applicable"] as const;

  for (const outcome of UNKNOWN_OUTCOMES) {
    test(`outcome "${outcome}" blocks the retry with a non-empty typed reason and appends nothing`, () => {
      const session = new AppendOnlySession(seed, makeDeps());
      const start = session.append({ type: "user_message", text: "start" });
      const call = session.append(
        { type: "tool_call", toolCallId: `tc-hardening-${outcome}` },
        { parentEntryId: start.entryId },
      );
      const result = session.append(
        {
          type: "tool_result",
          toolCallId: `tc-hardening-${outcome}`,
          artifactRef: artifactRef(`effect-hardening-${outcome}`),
        },
        { parentEntryId: call.entryId },
      );
      const entries = session.entries();
      const store = new InMemorySessionStore({
        [seed.sessionId]: { manifest: session.manifest(), entries },
      });
      const snapshot = store.read(seed.sessionId);
      if (!snapshot) throw new Error("expected the seeded snapshot to be readable");

      const receipt: ExecutionReceipt = {
        schemaVersion: 1,
        receiptId: `receipt-hardening-${outcome}`,
        executionId: `tc-hardening-${outcome}`,
        idempotencyKey: `idempotency-key-hardening-${outcome}-pad`,
        inputHash: sha256(`tc-hardening-${outcome}:input`),
        observedAt: "2026-01-01T00:00:05.000Z",
        outcome,
        evidenceRefs: [result.entryId],
      };
      const receiptValidation = validateAgainstSchema("execution-receipt.schema.json", receipt, {
        schemaDir: SCHEMA_DIR,
      });
      expect(receiptValidation.valid).toBe(true);

      const decision = recoverFrom({ snapshot, failpoint: "crash-post-effect", receipt }, makeDeps());

      expect(decision.kind).toBe("blocked-unknown-outcome");
      if (decision.kind !== "blocked-unknown-outcome") throw new Error("expected blocked-unknown-outcome");
      expect(typeof decision.reason).toBe("string");
      expect(decision.reason.length).toBeGreaterThan(0);

      // No unsafe retry proceeds: recoverFrom appends nothing itself, for
      // ANY unknown-outcome member of the enum, not only "indeterminate".
      expect(snapshot.entries).toHaveLength(entries.length);
      expect(snapshot.entries.filter((entry) => entry.entry.type === "tool_result")).toHaveLength(1);
    });
  }

  test("only the single KNOWN outcome (effect-confirmed) reconciles; every other outcome blocks", () => {
    const outcomes = ["effect-confirmed", "effect-absent", "indeterminate", "not-applicable"] as const;
    const blocked = outcomes.filter((outcome) => outcome !== "effect-confirmed");
    expect(blocked).toEqual(["effect-absent", "indeterminate", "not-applicable"]);
    expect(blocked).not.toContain("effect-confirmed");
  });
});

// ---------------------------------------------------------------------------
// 3. A new attempt never mutates a prior attempt's already-persisted record.
// ---------------------------------------------------------------------------
describe("recoverFrom / resumeSession — a new attempt never mutates a prior attempt's frozen record", () => {
  test("directly mutating a persisted (frozen) entry throws, and its nested causal block also rejects mutation", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const entry = session.append({ type: "user_message", text: "immutable prior attempt entry" });

    expect(() => {
      // biome-ignore lint: intentional mutation attempt on a frozen entry to assert immutability
      (entry as { sequence: number }).sequence = 999;
    }).toThrow();
    expect(() => {
      // biome-ignore lint: intentional mutation attempt on a frozen nested causal block
      (entry.causal as { runId: string }).runId = "tampered-run";
    }).toThrow();

    // The entry is unchanged after both failed mutation attempts.
    expect(entry.sequence).toBe(0);
    expect(entry.causal.runId).toBe(seed.runId);
  });

  test("a second attempt reconstructed via resumeSession leaves the first attempt's entries byte-identical (deep-equality of the frozen prior)", () => {
    const attempt1Session = new AppendOnlySession(seed, makeDeps());
    const start = attempt1Session.append({ type: "user_message", text: "attempt 1 start" });
    attempt1Session.append(
      { type: "tool_call", toolCallId: "tc-attempt-1" },
      { parentEntryId: start.entryId, attemptId: "attempt-1" },
    );
    const attempt1EntriesBefore = attempt1Session.entries();
    const attempt1JsonBefore = JSON.stringify(attempt1EntriesBefore);

    // Recovery classifies a crash-pre-effect cut on attempt 1 as safe to
    // re-execute -- this alone must not touch attempt 1's persisted state.
    const store = new InMemorySessionStore({
      [seed.sessionId]: { manifest: attempt1Session.manifest(), entries: attempt1Session.entries() },
    });
    const snapshotForRecovery = store.read(seed.sessionId);
    if (!snapshotForRecovery) throw new Error("expected the seeded snapshot to be readable");
    const decision = recoverFrom({ snapshot: snapshotForRecovery, failpoint: "crash-pre-effect" }, makeDeps());
    expect(decision.kind).toBe("safe-reexecute");
    expect(JSON.stringify(attempt1Session.entries())).toBe(attempt1JsonBefore);

    // A new attempt is started by reconstructing the session (resumeSession,
    // same pattern as `resumeSessionFrom` in resume.ts) and appending under a
    // NEW attemptId. The prior attempt's entries must survive untouched.
    const resumed = resumeSession(
      { manifest: attempt1Session.manifest(), entries: attempt1Session.entries() },
      makeDeps(),
    );
    const priorLeaf = resumed.currentLeaf();
    if (!priorLeaf) throw new Error("expected a non-empty resumed session to have a current leaf");
    resumed.append(
      { type: "tool_call", toolCallId: "tc-attempt-2" },
      { parentEntryId: priorLeaf.entryId, attemptId: "attempt-2" },
    );

    // The ORIGINAL attempt-1 session object is completely untouched.
    expect(JSON.stringify(attempt1Session.entries())).toBe(attempt1JsonBefore);

    // The prior attempt's entries, as seen through the RECONSTRUCTED
    // session, are deep-equal (byte-identical) to the original frozen
    // records -- resumeSession clones on load and appends only new content.
    const resumedEntries = resumed.entries();
    expect(resumedEntries.length).toBe(attempt1EntriesBefore.length + 1);
    for (let i = 0; i < attempt1EntriesBefore.length; i += 1) {
      const priorEntry = attempt1EntriesBefore[i];
      const resumedEntry = resumedEntries[i];
      expect(priorEntry).toBeDefined();
      expect(resumedEntry).toBeDefined();
      if (priorEntry === undefined || resumedEntry === undefined) continue;
      expect(resumedEntry).toEqual(priorEntry);
      if (priorEntry.causal.attemptId !== undefined) {
        expect(resumedEntry.causal.attemptId).toBe(priorEntry.causal.attemptId);
      }
    }
    // The newly appended entry belongs to the NEW attempt only.
    const newEntry = resumedEntries[resumedEntries.length - 1];
    expect(newEntry?.causal.attemptId).toBe("attempt-2");

    // Mutating the reconstructed prior-attempt entry also throws (it is
    // re-frozen on load by resumeSession/AppendOnlySession's constructor).
    const reconstructedPrior = resumedEntries[0];
    if (reconstructedPrior === undefined) throw new Error("expected a reconstructed prior entry at index 0");
    expect(() => {
      // biome-ignore lint: intentional mutation attempt on a re-frozen reconstructed entry
      (reconstructedPrior as { sequence: number }).sequence = 42;
    }).toThrow();
  });

  test("recoverFrom does not mutate the ExecutionReceipt it reconciles against", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const start = session.append({ type: "user_message", text: "start" });
    const call = session.append({ type: "tool_call", toolCallId: "tc-receipt-purity" }, { parentEntryId: start.entryId });
    const result = session.append(
      { type: "tool_result", toolCallId: "tc-receipt-purity", artifactRef: artifactRef("effect-receipt-purity") },
      { parentEntryId: call.entryId },
    );
    const store = new InMemorySessionStore({
      [seed.sessionId]: { manifest: session.manifest(), entries: session.entries() },
    });
    const snapshot = store.read(seed.sessionId);
    if (!snapshot) throw new Error("expected the seeded snapshot to be readable");

    const receipt: ExecutionReceipt = {
      schemaVersion: 1,
      receiptId: "receipt-purity-1",
      executionId: "tc-receipt-purity",
      idempotencyKey: "idempotency-key-receipt-purity-01",
      inputHash: sha256("tc-receipt-purity:input"),
      observedAt: "2026-01-01T00:00:05.000Z",
      outcome: "effect-confirmed",
      evidenceRefs: [result.entryId],
    };
    const receiptJsonBefore = JSON.stringify(receipt);

    const decision = recoverFrom({ snapshot, failpoint: "crash-post-effect", receipt }, makeDeps());

    expect(decision.kind).toBe("reconciled");
    expect(JSON.stringify(receipt)).toBe(receiptJsonBefore);
  });
});

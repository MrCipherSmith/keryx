// RED tests for W8 RS-02 crash/recovery (flow 011, dispatch 011-T7, R12/R6).
//
// Pins the failpoint-matrix + ambiguous-side-effect-reconciliation contract
// per docs/requirements/keryx-project-agent-harness/acceptance.feature
// `@task-RS-02` scenarios exercised in this suite:
//   - @SC_R12_CRASH_CUT_PRE_EFFECT         "Recover a crash before a side effect"
//   - @SC_R12_CRASH_CUT_POST_EFFECT        "Reconcile a crash after a side effect"
//   - @SC_R17_ISOLATED_REEXECUTE_DEFERRED  "Keep isolated replay re-execution deferred"
// plus two additional failpoints from the dispatched matrix (torn-write,
// cancellation) that are not separately scenario-tagged but are required by
// the RS-02 acceptance criterion (frozen AC3): "failpoint matrix passes:
// crash-pre-effect safe; crash-post-effect + unknown outcome BLOCKS unsafe
// retry (reconcile via execution-receipt; known reconciles without dup);
// torn-write/cancellation recover; isolated replay re-exec deferred
// (SC_R17). Durable payloads validate via src/contracts."
//
// RS-02 impl (next dispatch) implements `src/harness/resume/recovery.ts`
// (`ExecutionReceipt`, `Failpoint`, `RecoveryDecision`, `recoverFrom`) to make
// this suite GREEN; until then the missing-module import below is the
// expected RED failure ("Cannot find module './recovery'").
//
// Scenario -> test mapping:
//   1. crash-pre-effect                    -> describe("recoverFrom — crash-pre-effect ...")
//   2. crash-post-effect + KNOWN outcome    -> describe("recoverFrom — crash-post-effect ... KNOWN ...")
//   3. crash-post-effect + UNKNOWN outcome  -> describe("recoverFrom — crash-post-effect ... UNKNOWN ...")
//   4. torn-write                           -> describe("recoverFrom — torn-write ...")
//   5. cancellation                         -> describe("recoverFrom — cancellation ...")
//   6. SC_R17 isolated re-exec deferred     -> describe("recoverFrom — isolated replay re-execution ...")
//   7. receipt validity                     -> describe("ExecutionReceipt — validates ...")
//
// API DELTA vs. the dispatch's pinned sketch:
//   1. `ExecutionReceipt.outcome` — the dispatch's sketch left this a bare
//      `string` with a placeholder comment "(e.g. success/failure/unknown —
//      READ it)". The frozen `execution-receipt.schema.json#/properties/outcome`
//      enum is actually `["effect-confirmed", "effect-absent", "indeterminate",
//      "not-applicable"]` — there is no literal "success"/"failure"/"unknown".
//      This suite treats `"indeterminate"` as the UNKNOWN-outcome case (the
//      ambiguous side-effect state that must block an unsafe retry) and
//      `"effect-confirmed"` as a KNOWN outcome that reconciles cleanly. The
//      exported `ExecutionReceipt.outcome` field type is left as `string` per
//      the pinned sketch (no narrower literal union) to avoid a second,
//      independent delta; RS-02 impl may tighten it to the enum literal union
//      without breaking this suite.
//   2. `Failpoint` gains a 5th literal `"isolated-replay-reexecute"` beyond the
//      4 the dispatch pinned ("crash-pre-effect" | "crash-post-effect" |
//      "torn-write" | "cancellation"). Reason: the pinned `RecoveryDecision`
//      already carries a `"replay-deferred"` branch for @SC_R17, but the
//      pinned `Failpoint` union has no value that could ever select it. Rather
//      than add a second, differently-shaped entry point solely for @SC_R17,
//      this suite reuses the single `recoverFrom` decision surface (consistent
//      with `replayOffline`'s single-entry-point style in
//      `src/harness/replay/replay.ts`) and extends `Failpoint` with one literal
//      so @SC_R17's "isolated replay re-execution request" is representable.
//
// Deterministic + offline: `clock`/`idSeq` are always injected via
// `makeDeps()`; no `Date.now()`, `Math.random()`, or network anywhere in this
// file outside the explicit monkey-patched `fetch` guard (which itself only
// ever throws — it is never expected to be called, since `recoverFrom` is a
// pure decision function with no provider/tool/network dependency at all).
// Failpoints are INJECTED via the `failpoint` input field — there is no real
// crash, no real filesystem, no real cancellation signal anywhere here.
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";
import { AppendOnlySession } from "../session/session";
import type { SessionEntry, SessionManifest, SessionSeed } from "../session/types";

// PINNED API under test — RS-02 impl exports these from "./recovery"; the
// import fails until then (expected RED: "Cannot find module './recovery'").
import {
  type ExecutionReceipt,
  type Failpoint,
  recoverFrom,
  type RecoveryDecision,
} from "./recovery";
import type { SessionSnapshot } from "./store";
import { InMemorySessionStore } from "./store";

// Frozen schemas dir, computed relative to this file
// (src/harness/resume/ -> repo root).
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

// ---------------------------------------------------------------------------
// Deterministic deps: fixed clock, fresh monotonic id sequence per call.
// Mirrors `src/harness/resume/resume.test.ts` / `src/harness/replay/replay.test.ts`
// `makeDeps()`.
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
  sessionId: "session-recovery-1",
  runId: "run-recovery-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  policyFingerprint: "a".repeat(64),
  contextManifestHash: "b".repeat(64),
};

/**
 * Runs `fn` with `globalThis.fetch` monkey-patched to throw if it is ever
 * called, then asserts it was NOT called. `recoverFrom` is a pure decision
 * function over a `SessionSnapshot` — it has no provider/tool/network
 * dependency at all, so this proves every failpoint decision is effect-free
 * at the process boundary too (mirrors `replay.test.ts`'s fetch guard).
 */
function withFetchGuard<T>(fn: () => T): T {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    callCount += 1;
    throw new Error(`recoverFrom must never call fetch (args: ${JSON.stringify(args)})`);
  }) as unknown as typeof fetch;
  try {
    const result = fn();
    expect(callCount).toBe(0);
    return result;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** Seeds a fresh `InMemorySessionStore` with one session and reads it back. */
function seedSnapshot(entries: SessionEntry[], manifest: SessionManifest): SessionSnapshot {
  const store = new InMemorySessionStore({ [seed.sessionId]: { manifest, entries } });
  const snapshot = store.read(seed.sessionId);
  if (!snapshot) throw new Error("seedSnapshot: expected the freshly-seeded snapshot to be readable");
  return snapshot;
}

// ---------------------------------------------------------------------------
// 1. crash-pre-effect (@SC_R12_CRASH_CUT_PRE_EFFECT)
// ---------------------------------------------------------------------------
describe("recoverFrom — crash-pre-effect is safe to re-execute (SC_R12_CRASH_CUT_PRE_EFFECT)", () => {
  test("a prepared tool_call with no observed effect and no receipt resumes as safe-reexecute", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const start = session.append({ type: "user_message", text: "start" });
    session.append({ type: "tool_call", toolCallId: "tc-pre-effect-1" }, { parentEntryId: start.entryId });
    // Crash happens here: no tool_result / receipt was ever observed for
    // tc-pre-effect-1 — the effect never started.
    const entries = session.entries();
    const snapshot = seedSnapshot(entries, session.manifest());

    const decision: RecoveryDecision = withFetchGuard(() =>
      recoverFrom({ snapshot, failpoint: "crash-pre-effect" }, makeDeps()),
    );

    expect(decision.kind).toBe("safe-reexecute");
    // The execution is not reported as succeeded and no duplicate effect is
    // attempted automatically: recoverFrom is a pure decision — it never
    // appends/auto-retries the effect itself.
    expect(snapshot.entries).toHaveLength(entries.length);
    expect(snapshot.entries.some((entry) => entry.entry.type === "tool_result")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. crash-post-effect + KNOWN outcome (@SC_R12_CRASH_CUT_POST_EFFECT)
// ---------------------------------------------------------------------------
describe("recoverFrom — crash-post-effect with a KNOWN outcome reconciles without duplicating evidence (SC_R12_CRASH_CUT_POST_EFFECT)", () => {
  test("a receipt with outcome effect-confirmed reconciles to the existing receipt, no duplicate tool_result", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const start = session.append({ type: "user_message", text: "start" });
    const call = session.append(
      { type: "tool_call", toolCallId: "tc-post-known-1" },
      { parentEntryId: start.entryId },
    );
    const result = session.append(
      { type: "tool_result", toolCallId: "tc-post-known-1", artifactRef: artifactRef("effect-known-1") },
      { parentEntryId: call.entryId },
    );
    const entries = session.entries();
    const snapshot = seedSnapshot(entries, session.manifest());

    const receipt: ExecutionReceipt = {
      schemaVersion: 1,
      receiptId: "receipt-known-1",
      executionId: "tc-post-known-1",
      idempotencyKey: "idempotency-key-known-outcome-01",
      inputHash: sha256("tc-post-known-1:input"),
      observedAt: "2026-01-01T00:00:05.000Z",
      outcome: "effect-confirmed",
      evidenceRefs: [result.entryId],
    };
    const receiptValidation = validateAgainstSchema("execution-receipt.schema.json", receipt, {
      schemaDir: SCHEMA_DIR,
    });
    expect(receiptValidation.valid).toBe(true);
    expect(receiptValidation.errors).toEqual([]);

    const decision: RecoveryDecision = withFetchGuard(() =>
      recoverFrom({ snapshot, failpoint: "crash-post-effect", receipt }, makeDeps()),
    );

    expect(decision.kind).toBe("reconciled");
    if (decision.kind !== "reconciled") throw new Error("expected a reconciled decision");
    expect(decision.receiptId).toBe(receipt.receiptId);

    // Reconciling picks up the EXISTING receipt/evidence: no duplicate
    // tool_result / effect is appended by recoverFrom.
    expect(snapshot.entries.filter((entry) => entry.entry.type === "tool_result")).toHaveLength(1);
    expect(snapshot.entries).toHaveLength(entries.length);
  });
});

// ---------------------------------------------------------------------------
// 3. crash-post-effect + UNKNOWN outcome
// ---------------------------------------------------------------------------
describe("recoverFrom — crash-post-effect with an UNKNOWN outcome blocks unsafe retry", () => {
  test("a receipt with outcome indeterminate blocks the retry with a non-empty typed reason", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const start = session.append({ type: "user_message", text: "start" });
    const call = session.append(
      { type: "tool_call", toolCallId: "tc-post-unknown-1" },
      { parentEntryId: start.entryId },
    );
    const result = session.append(
      { type: "tool_result", toolCallId: "tc-post-unknown-1", artifactRef: artifactRef("effect-unknown-1") },
      { parentEntryId: call.entryId },
    );
    const entries = session.entries();
    const snapshot = seedSnapshot(entries, session.manifest());

    const receipt: ExecutionReceipt = {
      schemaVersion: 1,
      receiptId: "receipt-unknown-1",
      executionId: "tc-post-unknown-1",
      idempotencyKey: "idempotency-key-unknown-outcome-01",
      inputHash: sha256("tc-post-unknown-1:input"),
      observedAt: "2026-01-01T00:00:05.000Z",
      outcome: "indeterminate",
      evidenceRefs: [result.entryId],
    };
    const receiptValidation = validateAgainstSchema("execution-receipt.schema.json", receipt, {
      schemaDir: SCHEMA_DIR,
    });
    expect(receiptValidation.valid).toBe(true);
    expect(receiptValidation.errors).toEqual([]);

    const decision: RecoveryDecision = withFetchGuard(() =>
      recoverFrom({ snapshot, failpoint: "crash-post-effect", receipt }, makeDeps()),
    );

    expect(decision.kind).toBe("blocked-unknown-outcome");
    if (decision.kind !== "blocked-unknown-outcome") throw new Error("expected a blocked-unknown-outcome decision");
    expect(typeof decision.reason).toBe("string");
    expect(decision.reason.length).toBeGreaterThan(0);

    // NO unsafe retry proceeds: the harness will not re-run the
    // side-effecting action — recoverFrom appends nothing itself.
    expect(snapshot.entries).toHaveLength(entries.length);
  });

  test("a recorded effect with NO receipt at all also blocks the retry (cannot reconcile blind)", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const start = session.append({ type: "user_message", text: "start" });
    const call = session.append(
      { type: "tool_call", toolCallId: "tc-post-missing-receipt-1" },
      { parentEntryId: start.entryId },
    );
    session.append(
      { type: "tool_result", toolCallId: "tc-post-missing-receipt-1", artifactRef: artifactRef("effect-missing-1") },
      { parentEntryId: call.entryId },
    );
    const entries = session.entries();
    const snapshot = seedSnapshot(entries, session.manifest());

    // No `receipt` key at all: the effect was observed but never reconciled.
    const decision: RecoveryDecision = withFetchGuard(() =>
      recoverFrom({ snapshot, failpoint: "crash-post-effect" }, makeDeps()),
    );

    expect(decision.kind).toBe("blocked-unknown-outcome");
    expect(snapshot.entries).toHaveLength(entries.length);
  });
});

// ---------------------------------------------------------------------------
// 4. torn-write
// ---------------------------------------------------------------------------
describe("recoverFrom — torn-write recovers to the last intact entry", () => {
  test("a truncated/corrupt tail entry is not treated as committed; recovery points at the last intact entry", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const start = session.append({ type: "user_message", text: "start" });
    const lastIntact = session.append(
      { type: "assistant_message", text: "acknowledged" },
      { parentEntryId: start.entryId },
    );
    const intactEntries = session.entries();

    // Simulate a torn write: the last JSONL line was cut mid-object, so the
    // persisted record is missing required fields (here: `entry` itself).
    // This is an injected, in-memory fixture — no real filesystem is touched.
    const truncatedRaw: Record<string, unknown> = {
      schemaVersion: 1,
      entryId: "entry-torn-tail-1",
      sequence: intactEntries.length,
      timestamp: "2026-01-01T00:00:10.000Z",
      causal: { runId: seed.runId, sessionId: seed.sessionId, correlationId: "corr-torn-tail-1" },
      // "entry" intentionally omitted.
    };
    const corruptEntry = truncatedRaw as unknown as SessionEntry;

    // Sanity-check the fixture actually IS torn per the frozen schema, and
    // that the entry immediately before it is genuinely intact.
    const corruptValidation = validateAgainstSchema("session-entry.schema.json", corruptEntry, {
      schemaDir: SCHEMA_DIR,
    });
    expect(corruptValidation.valid).toBe(false);
    const intactValidation = validateAgainstSchema("session-entry.schema.json", lastIntact, {
      schemaDir: SCHEMA_DIR,
    });
    expect(intactValidation.valid).toBe(true);

    const manifest: SessionManifest = { ...session.manifest(), currentLeafEntryId: corruptEntry.entryId };
    const snapshot = seedSnapshot([...intactEntries, corruptEntry], manifest);

    const decision: RecoveryDecision = withFetchGuard(() =>
      recoverFrom({ snapshot, failpoint: "torn-write" }, makeDeps()),
    );

    expect(decision.kind).toBe("recovered-torn-write");
    if (decision.kind !== "recovered-torn-write") throw new Error("expected a recovered-torn-write decision");
    expect(decision.atEntryId).toBe(lastIntact.entryId);
    expect(decision.atEntryId).not.toBe(corruptEntry.entryId);
  });
});

// ---------------------------------------------------------------------------
// 5. cancellation
// ---------------------------------------------------------------------------
describe("recoverFrom — cancellation leaves the session resumable", () => {
  test("a cancellation cut reports cancelled-resumable without mutating the session", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    const start = session.append({ type: "user_message", text: "start" });
    session.append({ type: "tool_call", toolCallId: "tc-cancel-1" }, { parentEntryId: start.entryId });
    const entries = session.entries();
    const snapshot = seedSnapshot(entries, session.manifest());

    const decision: RecoveryDecision = withFetchGuard(() =>
      recoverFrom({ snapshot, failpoint: "cancellation" }, makeDeps()),
    );

    expect(decision.kind).toBe("cancelled-resumable");
    // The attempt is cancelled but the session itself is left untouched and
    // resumable — recoverFrom does not append or discard anything.
    expect(snapshot.entries).toHaveLength(entries.length);
  });
});

// ---------------------------------------------------------------------------
// 6. SC_R17 isolated replay re-execution stays deferred
// ---------------------------------------------------------------------------
describe("recoverFrom — isolated replay re-execution stays deferred (SC_R17_ISOLATED_REEXECUTE_DEFERRED)", () => {
  test("an isolated replay re-execute request reports replay-deferred and invokes no provider/tool/fetch", () => {
    const session = new AppendOnlySession(seed, makeDeps());
    session.append({ type: "user_message", text: "start" });
    const entries = session.entries();
    const snapshot = seedSnapshot(entries, session.manifest());

    const failpoint: Failpoint = "isolated-replay-reexecute";
    const decision: RecoveryDecision = withFetchGuard(() => recoverFrom({ snapshot, failpoint }, makeDeps()));

    // Release 0/1 does not re-execute isolated effects: it remains
    // unavailable until containment and policy gates pass.
    expect(decision.kind).toBe("replay-deferred");
    expect(snapshot.entries).toHaveLength(entries.length);
  });
});

// ---------------------------------------------------------------------------
// 7. ExecutionReceipt — schema validity
// ---------------------------------------------------------------------------
describe("ExecutionReceipt — validates against the frozen execution-receipt schema", () => {
  test("a constructed ExecutionReceipt round-trips through validateAgainstSchema unchanged", () => {
    const receipt: ExecutionReceipt = {
      schemaVersion: 1,
      receiptId: "receipt-schema-valid-1",
      executionId: "execution-schema-valid-1",
      idempotencyKey: "idempotency-key-schema-valid-01",
      inputHash: sha256("schema-valid-input"),
      observedAt: "2026-01-01T00:00:00.000Z",
      outcome: "effect-confirmed",
      evidenceRefs: ["entry-evidence-schema-valid-1"],
    };

    const result = validateAgainstSchema("execution-receipt.schema.json", receipt, { schemaDir: SCHEMA_DIR });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("every frozen outcome enum member individually validates", () => {
    const outcomes = ["effect-confirmed", "effect-absent", "indeterminate", "not-applicable"] as const;
    for (const outcome of outcomes) {
      const receipt: ExecutionReceipt = {
        schemaVersion: 1,
        receiptId: `receipt-outcome-${outcome}`,
        executionId: `execution-outcome-${outcome}`,
        idempotencyKey: `idempotency-key-outcome-${outcome}-pad`,
        inputHash: sha256(`outcome-fixture:${outcome}`),
        observedAt: "2026-01-01T00:00:00.000Z",
        outcome,
        evidenceRefs: [`entry-evidence-${outcome}`],
      };
      const result = validateAgainstSchema("execution-receipt.schema.json", receipt, { schemaDir: SCHEMA_DIR });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    }
  });
});

// RED tests for W10 M-02 monitored trusted-local guarded mutation + execution
// receipt + reconciliation tie-in (flow 013, dispatch 013-T7, task-M-02,
// reviewer track: security/logic).
//
// Pins the execute-and-record half of the frozen guarded-mutation contract per
// `docs/requirements/keryx-project-agent-harness/acceptance.feature`:
//   - @SC_R04_GUARDED_MUTATION       "Record a guarded mutation after approval"
//   - @SC_R15_FAIL_CLOSED_ISOLATION  "Fail closed when required isolation is unavailable"
// plus the frozen `execution-receipt.schema.json` (outcome enum
// `["effect-confirmed","effect-absent","indeterminate","not-applicable"]`) and
// the W8 `recoverFrom` `crash-post-effect` contract (an UNKNOWN/indeterminate
// outcome blocks an unsafe retry — see `src/harness/resume/recovery.ts`).
//
// M-02 impl (next dispatch) implements `src/harness/mutation/execute.ts`
// (`MutationAdapter`, `ExecuteOutcome`, `executeGuardedMutation`) to make this
// suite GREEN; until then the missing-module import below is the expected RED
// failure ("Cannot find module './execute'").
//
// Scenario -> test mapping:
//   1. guarded mutation happy path (SC_R04_GUARDED_MUTATION)
//        -> describe("executeGuardedMutation — guarded mutation happy path ...")
//   2. fail-closed on guard/approval
//        -> describe("executeGuardedMutation — fail-closed on guard/approval denial ...")
//   3. unattended-untrusted blocked without isolation (SC_R15_FAIL_CLOSED_ISOLATION)
//        -> describe("executeGuardedMutation — unattended-untrusted blocked without isolation ...")
//   4. unknown side-effect -> reconciliation (ties to W8 recoverFrom)
//        -> describe("executeGuardedMutation — unknown side-effect requires reconciliation ...")
//   5. no real fs / no network
//        -> describe("executeGuardedMutation — no real fs/network mutation ...")
//   6. read-only trustMode cannot mutate
//        -> describe("executeGuardedMutation — read-only trustMode never mutates ...")
//
// ---------------------------------------------------------------------------
// API DELTA vs. the dispatch's pinned sketch:
//
// 1. `executeGuardedMutation`'s `input` in the dispatch sketch is an inline
//    object type (not a named export). This suite defines a LOCAL
//    `ExecuteInput` alias (mirrors the `GuardTestInput` pattern in
//    `guard.test.ts`) purely for fixture-builder readability; it is
//    structurally identical to the pinned inline shape, so it type-checks at
//    every call site without altering the pinned surface.
//
// 2. `receipt.inputHash` — the dispatch requires "the receipt's inputHash
//    matches the action fingerprint" but `executeGuardedMutation` is not
//    handed a `worktreeRoot`/`envAllowlist` (unlike `guardAction`, which
//    composes `actionFingerprint(spec, { worktreeRoot, envAllowlist: [] })`).
//    This suite resolves the ambiguity by fixing `spec.path` to an ABSOLUTE
//    path in every fixture: `path.resolve(anyRoot, absolutePath)` returns
//    `absolutePath` regardless of `anyRoot` (Node path-resolution semantics),
//    so `actionFingerprint(spec, { worktreeRoot: <anything>, envAllowlist: [] })`
//    is well-defined independent of which worktreeRoot M-02 impl resolves
//    internally. The suite asserts `receipt.inputHash` equals that
//    root-independent fingerprint, mirroring `guardAction`'s own
//    `envAllowlist: []` convention.
//
// Deterministic: `deps.clock`/`deps.idSeq` are fixed via `makeDeps()` (mirrors
// `guard.test.ts` / `recovery.test.ts`); no `Date.now()`, `Math.random()`, or
// network anywhere in this file outside the explicit monkey-patched `fetch`
// guard (which only ever throws — proving `executeGuardedMutation` never
// reaches the network). NO real fs: `MutationAdapter` is a FAKE, in-memory-only
// double — there is no real filesystem mutation anywhere in this suite.
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";
import type { PolicyTrustMode } from "../policy/types";
import { recoverFrom } from "../resume/recovery";
import { InMemorySessionStore, type SessionSnapshot } from "../resume/store";
import { AppendOnlySession } from "../session/session";
import type { SessionSeed } from "../session/types";
import type { ApprovalCheck, ApprovalInvalidReason } from "./approval";
import { actionFingerprint, type ActionSpec } from "./fingerprint";
import type { GuardOutcome } from "./guard";

// PINNED API under test — M-02 impl exports these from "./execute"; the
// import fails until then (expected RED: "Cannot find module './execute'").
import {
  executeGuardedMutation,
  type ExecuteOutcome,
  type MutationAdapter,
} from "./execute";

// Frozen schemas dir, computed relative to this file
// (src/harness/mutation/ -> repo root), mirrors `recovery.test.ts`.
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
// Mirrors `guard.test.ts` / `recovery.test.ts` `makeDeps()`.
// ---------------------------------------------------------------------------
function makeDeps(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return {
    clock: () => "2026-01-01T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
  };
}

// ---------------------------------------------------------------------------
// Action-spec builder. `path`/`argv` are always ABSOLUTE (see API DELTA #2
// above) so the expected fingerprint is well-defined without knowing which
// worktreeRoot M-02 impl resolves internally.
// ---------------------------------------------------------------------------
const worktreeRoot = "/repo/worktree";

function makeSpec(overrides: Partial<ActionSpec> = {}): ActionSpec {
  return {
    path: `${worktreeRoot}/src/index.ts`,
    argv: ["write", `${worktreeRoot}/src/index.ts`],
    env: {},
    ...overrides,
  };
}

/** Root-independent expected fingerprint (spec.path is always absolute). */
function expectedInputHash(spec: ActionSpec): string {
  return actionFingerprint(spec, { worktreeRoot: "/any-root-ignored-because-path-is-absolute", envAllowlist: [] });
}

// ---------------------------------------------------------------------------
// FAKE mutation adapter — records calls IN-MEMORY ONLY. No real fs, no
// network, no process spawn anywhere in this double.
// ---------------------------------------------------------------------------
class FakeMutationAdapter implements MutationAdapter {
  calls: ActionSpec[] = [];
  constructor(
    private readonly outcome: "effect-confirmed" | "effect-absent" | "indeterminate",
    private readonly observedHash: string = sha256("fake-observed-effect"),
  ) {}

  apply(spec: ActionSpec): { outcome: "effect-confirmed" | "effect-absent" | "indeterminate"; observedHash: string } {
    this.calls.push(spec);
    return { outcome: this.outcome, observedHash: this.observedHash };
  }
}

// See API DELTA #1 above: a local, structurally-identical alias of the pinned
// inline `input` shape, purely for fixture-builder readability.
interface ExecuteInput {
  spec: ActionSpec;
  trustMode: PolicyTrustMode;
  isolationAvailable: boolean;
  guard: GuardOutcome;
  approval: ApprovalCheck;
  adapter: MutationAdapter;
}

function baseInput(overrides: Partial<ExecuteInput> = {}): ExecuteInput {
  return {
    spec: makeSpec(),
    trustMode: "trusted-local",
    isolationAvailable: true,
    guard: { kind: "allow" },
    approval: { kind: "valid" },
    adapter: new FakeMutationAdapter("effect-confirmed"),
    ...overrides,
  };
}

function invalidApproval(reason: ApprovalInvalidReason): ApprovalCheck {
  return { kind: "invalid", reason };
}

// ---------------------------------------------------------------------------
// A minimal, valid `SessionSnapshot` fixture for the W8 `recoverFrom` tie-in
// test (test 4b below). `recoverFrom`'s `crash-post-effect` branch only reads
// `input.receipt` (see `src/harness/resume/recovery.ts`), so an otherwise-empty
// but real, schema-shaped snapshot is sufficient — no `as never`/`as any` cast
// is needed anywhere here.
// ---------------------------------------------------------------------------
const reconciliationSeed: SessionSeed = {
  sessionId: "session-execute-reconciliation-1",
  runId: "run-execute-reconciliation-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  policyFingerprint: "a".repeat(64),
  contextManifestHash: "b".repeat(64),
};

function seedReconciliationSnapshot(): SessionSnapshot {
  const session = new AppendOnlySession(reconciliationSeed, makeDeps());
  session.append({ type: "user_message", text: "start" });
  const store = new InMemorySessionStore({
    [reconciliationSeed.sessionId]: { manifest: session.manifest(), entries: session.entries() },
  });
  const snapshot = store.read(reconciliationSeed.sessionId);
  if (!snapshot) throw new Error("seedReconciliationSnapshot: expected the freshly-seeded snapshot to be readable");
  return snapshot;
}

/**
 * Runs `fn` with `globalThis.fetch` monkey-patched to throw if it is ever
 * called, then asserts it was NOT called. Mirrors `recovery.test.ts`'s
 * `withFetchGuard`: `executeGuardedMutation` must never reach the network —
 * the only "effect" surface is the injected FAKE `MutationAdapter`.
 */
function withFetchGuard<T>(fn: () => T): T {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    callCount += 1;
    throw new Error(`executeGuardedMutation must never call fetch (args: ${JSON.stringify(args)})`);
  }) as unknown as typeof fetch;
  try {
    const result = fn();
    expect(callCount).toBe(0);
    return result;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------------
// 1. Guarded mutation happy path (SC_R04_GUARDED_MUTATION)
// ---------------------------------------------------------------------------
describe("executeGuardedMutation — guarded mutation happy path (SC_R04_GUARDED_MUTATION)", () => {
  test("trusted-local + allow guard + valid approval + effect-confirmed adapter -> executed with a schema-valid receipt", () => {
    const spec = makeSpec();
    const adapter = new FakeMutationAdapter("effect-confirmed");
    const outcome: ExecuteOutcome = withFetchGuard(() =>
      executeGuardedMutation(baseInput({ spec, adapter }), makeDeps()),
    );

    expect(outcome.kind).toBe("executed");
    if (outcome.kind !== "executed") throw new Error("expected an executed outcome");

    const { receipt, evidenceRefs } = outcome;
    expect(receipt.outcome).toBe("effect-confirmed");
    expect(evidenceRefs.length).toBeGreaterThan(0);
    expect(receipt.evidenceRefs.length).toBeGreaterThan(0);

    const validation = validateAgainstSchema("execution-receipt.schema.json", receipt, { schemaDir: SCHEMA_DIR });
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);

    // The adapter (the only side-effecting surface) was invoked exactly once
    // with the exact action spec.
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]).toEqual(spec);
  });

  test("the receipt's inputHash matches the action fingerprint of the spec", () => {
    const spec = makeSpec();
    const outcome = withFetchGuard(() =>
      executeGuardedMutation(baseInput({ spec, adapter: new FakeMutationAdapter("effect-confirmed") }), makeDeps()),
    );
    if (outcome.kind !== "executed") throw new Error("expected an executed outcome");
    expect(outcome.receipt.inputHash).toBe(expectedInputHash(spec));
  });

  test("two independent runs with fixed deps produce identical receipts (deterministic, no Date.now/Math.random)", () => {
    const spec = makeSpec();

    const run1 = withFetchGuard(() =>
      executeGuardedMutation(baseInput({ spec, adapter: new FakeMutationAdapter("effect-confirmed") }), makeDeps()),
    );
    const run2 = withFetchGuard(() =>
      executeGuardedMutation(baseInput({ spec, adapter: new FakeMutationAdapter("effect-confirmed") }), makeDeps()),
    );

    expect(run1.kind).toBe("executed");
    expect(run2.kind).toBe("executed");
    if (run1.kind !== "executed" || run2.kind !== "executed") {
      throw new Error("expected both runs to be executed outcomes");
    }
    expect(run1.receipt).toEqual(run2.receipt);
    expect(run1.evidenceRefs).toEqual(run2.evidenceRefs);
  });
});

// ---------------------------------------------------------------------------
// 2. Fail-closed on guard/approval denial
// ---------------------------------------------------------------------------
describe("executeGuardedMutation — fail-closed on guard/approval denial", () => {
  test("guard.kind === deny -> blocked, adapter never called", () => {
    const adapter = new FakeMutationAdapter("effect-confirmed");
    const outcome = withFetchGuard(() =>
      executeGuardedMutation(
        baseInput({ guard: { kind: "deny", reason: "structural denial for the test" }, adapter }),
        makeDeps(),
      ),
    );
    expect(outcome.kind).toBe("blocked");
    expect(adapter.calls).toHaveLength(0);
  });

  test("approval.kind === invalid (denied) -> blocked, adapter never called", () => {
    const adapter = new FakeMutationAdapter("effect-confirmed");
    const outcome = withFetchGuard(() =>
      executeGuardedMutation(baseInput({ approval: invalidApproval("denied"), adapter }), makeDeps()),
    );
    expect(outcome.kind).toBe("blocked");
    expect(adapter.calls).toHaveLength(0);
  });

  test("approval.kind === invalid (stale) -> blocked, adapter never called", () => {
    const adapter = new FakeMutationAdapter("effect-confirmed");
    const outcome = withFetchGuard(() =>
      executeGuardedMutation(baseInput({ approval: invalidApproval("stale"), adapter }), makeDeps()),
    );
    expect(outcome.kind).toBe("blocked");
    expect(adapter.calls).toHaveLength(0);
  });

  test("approval.kind === invalid (headless) -> blocked, adapter never called", () => {
    const adapter = new FakeMutationAdapter("effect-confirmed");
    const outcome = withFetchGuard(() =>
      executeGuardedMutation(baseInput({ approval: invalidApproval("headless"), adapter }), makeDeps()),
    );
    expect(outcome.kind).toBe("blocked");
    expect(adapter.calls).toHaveLength(0);
  });

  test("both guard deny and approval invalid together still block with zero adapter calls", () => {
    const adapter = new FakeMutationAdapter("effect-confirmed");
    const outcome = withFetchGuard(() =>
      executeGuardedMutation(
        baseInput({
          guard: { kind: "deny", reason: "double denial" },
          approval: invalidApproval("expired"),
          adapter,
        }),
        makeDeps(),
      ),
    );
    expect(outcome.kind).toBe("blocked");
    expect(adapter.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Unattended-untrusted blocked without isolation (SC_R15_FAIL_CLOSED_ISOLATION)
// ---------------------------------------------------------------------------
describe("executeGuardedMutation — unattended-untrusted blocked without isolation (SC_R15_FAIL_CLOSED_ISOLATION)", () => {
  test("trustMode untrusted + isolationAvailable=false -> blocked with an isolation/untrusted/unattended reason, adapter never called", () => {
    const adapter = new FakeMutationAdapter("effect-confirmed");
    const outcome = withFetchGuard(() =>
      executeGuardedMutation(
        baseInput({ trustMode: "untrusted", isolationAvailable: false, adapter }),
        makeDeps(),
      ),
    );
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("expected a blocked outcome");
    expect(outcome.reason).toMatch(/isolation|untrusted|unattended/i);
    expect(adapter.calls).toHaveLength(0);
  });

  test("no permission prompt can bypass the fail-closed isolation boundary: denied even with an allow guard and a valid approval", () => {
    const adapter = new FakeMutationAdapter("effect-confirmed");
    const outcome = withFetchGuard(() =>
      executeGuardedMutation(
        baseInput({
          trustMode: "untrusted",
          isolationAvailable: false,
          guard: { kind: "allow" },
          approval: { kind: "valid" },
          adapter,
        }),
        makeDeps(),
      ),
    );
    expect(outcome.kind).toBe("blocked");
    expect(adapter.calls).toHaveLength(0);
  });

  test("trustMode untrusted + isolationAvailable=true is NOT auto-blocked on the isolation axis (still subject to guard/approval)", () => {
    const adapter = new FakeMutationAdapter("effect-confirmed");
    const outcome = withFetchGuard(() =>
      executeGuardedMutation(
        baseInput({
          trustMode: "untrusted",
          isolationAvailable: true,
          guard: { kind: "allow" },
          approval: { kind: "valid" },
          adapter,
        }),
        makeDeps(),
      ),
    );
    // With isolation available and guard/approval both clean, the isolation
    // gate is satisfied: this must not be blocked for an isolation reason,
    // and (given a clean guard/approval and a confirmed adapter effect) it
    // proceeds to execute.
    expect(outcome.kind).toBe("executed");
  });
});

// ---------------------------------------------------------------------------
// 4. Unknown side-effect requires reconciliation (ties to W8 recoverFrom)
// ---------------------------------------------------------------------------
describe("executeGuardedMutation — unknown side-effect requires reconciliation", () => {
  test("adapter outcome indeterminate -> needs-reconciliation with a schema-valid indeterminate receipt", () => {
    const adapter = new FakeMutationAdapter("indeterminate");
    const outcome: ExecuteOutcome = withFetchGuard(() =>
      executeGuardedMutation(baseInput({ adapter }), makeDeps()),
    );

    expect(outcome.kind).toBe("needs-reconciliation");
    if (outcome.kind !== "needs-reconciliation") throw new Error("expected a needs-reconciliation outcome");
    expect(outcome.receipt.outcome).toBe("indeterminate");

    const validation = validateAgainstSchema("execution-receipt.schema.json", outcome.receipt, {
      schemaDir: SCHEMA_DIR,
    });
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);

    expect(adapter.calls).toHaveLength(1);
  });

  test("the needs-reconciliation receipt, fed into W8 recoverFrom at crash-post-effect, yields blocked-unknown-outcome (no unsafe retry)", () => {
    const adapter = new FakeMutationAdapter("indeterminate");
    const outcome = withFetchGuard(() =>
      executeGuardedMutation(baseInput({ adapter }), makeDeps()),
    );
    if (outcome.kind !== "needs-reconciliation") throw new Error("expected a needs-reconciliation outcome");

    // Ties M-02 to W8: feeding an indeterminate-outcome receipt into
    // `recoverFrom` at a post-effect crash must block an unsafe retry, never
    // silently reconcile or re-execute.
    const snapshot = seedReconciliationSnapshot();
    const decision = recoverFrom(
      { snapshot, failpoint: "crash-post-effect", receipt: outcome.receipt },
      makeDeps(),
    );
    expect(decision.kind).toBe("blocked-unknown-outcome");
  });
});

// ---------------------------------------------------------------------------
// 5. No real fs / no network mutation
// ---------------------------------------------------------------------------
describe("executeGuardedMutation — no real fs/network mutation", () => {
  test("executeGuardedMutation never calls fetch on the happy path", () => {
    const adapter = new FakeMutationAdapter("effect-confirmed");
    withFetchGuard(() => executeGuardedMutation(baseInput({ adapter }), makeDeps()));
  });

  test("executeGuardedMutation never calls fetch on a blocked path", () => {
    const adapter = new FakeMutationAdapter("effect-confirmed");
    withFetchGuard(() =>
      executeGuardedMutation(baseInput({ guard: { kind: "deny", reason: "denied" }, adapter }), makeDeps()),
    );
  });

  test("the fake adapter records calls in-memory only (no fs/network handle is ever passed to it)", () => {
    const adapter = new FakeMutationAdapter("effect-confirmed");
    const spec = makeSpec();
    withFetchGuard(() => executeGuardedMutation(baseInput({ spec, adapter }), makeDeps()));
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]).toEqual(spec);
  });
});

// ---------------------------------------------------------------------------
// 6. Read-only trustMode never mutates
// ---------------------------------------------------------------------------
describe("executeGuardedMutation — read-only trustMode never mutates", () => {
  test("trustMode read-only -> blocked regardless of guard/approval, adapter never called", () => {
    const adapter = new FakeMutationAdapter("effect-confirmed");
    const outcome = withFetchGuard(() =>
      executeGuardedMutation(
        baseInput({
          trustMode: "read-only",
          guard: { kind: "allow" },
          approval: { kind: "valid" },
          isolationAvailable: true,
          adapter,
        }),
        makeDeps(),
      ),
    );
    expect(outcome.kind).toBe("blocked");
    expect(adapter.calls).toHaveLength(0);
  });
});

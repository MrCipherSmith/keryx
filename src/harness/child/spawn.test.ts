// RED tests for CA-02 (flow 015, W12 / T7): child spawn, disposition ->
// evidence mapping, and parent-owned completion (D-02).
//
// Pins the frozen spec (implementation-plan.md CA-02): "Add child isolation,
// context budget, provenance, NEEDS_CONTEXT, blocked/failed dispositions."
// Evidence: "parent owns status and completion; prior attempts immutable."
//
// This file covers AC4 (`acceptance-criteria.md`):
//   - NEEDS_CONTEXT / blocked / failed child dispositions are returned to the
//     parent AS EVIDENCE (`EvidenceRecord`);
//   - the parent owns status and completion — a child completion flows ONLY
//     through the W11 `ManagedFlowPort` (the child NEVER writes flow.json;
//     no `writeFlow`/flow.json write is reachable from `src/harness/child/**`);
//   - prior attempts are immutable (reuse W8; a new attempt never mutates a
//     prior attempt's record).
// It also exercises AC3's isolation surface end-to-end through `spawnChild`
// (fail-closed budget/policy denial refuses to spawn at all) and AC5
// determinism for the two new `spawn.ts` exports.
//
// CA-02 impl (next dispatch, T8) implements `src/harness/child/spawn.ts`:
//   - `spawnChild(input, deps)` — composes `./isolation`'s `inheritBudget` +
//     `inheritPolicy` (fail-closed: EITHER denial refuses to spawn — no
//     partial extension/session-entry is produced) and, only when BOTH are
//     granted, builds the child's `ChildContractExtension` (via `./contract`'s
//     `buildChildDispatchExtension`, `canonicalContract:"subagent-dispatch"`)
//     plus a `SessionEntryPayload`/`AppendOptions` pair the PARENT appends
//     into its OWN `AppendOnlySession` (there is no separate child session —
//     isolation is via `attemptId`/`branchId` linkage, not a second store)
//     and a derived child `Provenance` (via `./isolation`'s `childProvenance`).
//     Returns `{ ok: true; extension; dispatchEntryPayload; appendOptions;
//     provenance }` or `{ ok: false; reason }`.
//   - `childResultToEvidence(input, deps)` — maps a canonical child result
//     (`DONE`/`DONE_WITH_CONCERNS`/`NEEDS_CONTEXT`/`BLOCKED`/`FAILED`) plus its
//     `ChildContractExtension` into a parent `EvidenceRecord`
//     (`../evidence/types`): `causal` carries `extension.parentRunId`/
//     `sessionId`/`attempt.attemptId`/`branchId`; `artifact` is derived from
//     `extension.durableResultArtifact` with `kind` set to
//     `` `child-result:${canonical.status}` `` (so the disposition survives
//     onto the evidence record) and, when `input.missingArtifact` is given
//     (the `NEEDS_CONTEXT` case), `artifact.path` names it; `provenance` is
//     `trustLevel:"derived"`, `sourceKind:"child-agent-result"`. Pure aside
//     from `deps.idSeq()`/`deps.clock()`.
//   - Neither function accepts a `FlowService`/`ManagedFlowPort`/fs handle —
//     structurally, nothing under `src/harness/child/**` can reach a
//     flow.json write. The PARENT (not the child) is the only caller that
//     ever imports `ManagedFlowPort`/`createTaskManagerFlowPort` and advances
//     the flow, using the evidence the child returned.
//
// Until `src/harness/child/spawn.ts` exists, the missing-module import is the
// expected RED failure ("Cannot find module './spawn'") — NOT a bug in this
// test file. Do NOT create spawn.ts here (T8's job).
//
// Deterministic: all ids/hashes/timestamps are fixture constants or come from
// injected `deps` (no `Date.now()`, `Math.random()`, network, or real fs
// mutation).
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";
import { evaluateCompletion } from "../completion/gate";
import type { CompletionGateResult, CompletionInput } from "../completion/gate";
import type { EvidenceRecord } from "../evidence/types";
import { createTaskManagerFlowPort } from "../flow/managed-flow-port";
import type { ManagedFlowPort } from "../flow/managed-flow-port";
import type { FlowService, FlowState, TaskDisposition, TaskRunLink } from "../../flow/types";
import type { PolicyProfile } from "../policy/types";
import { AppendOnlySession } from "../session/session";
import type { Provenance, SessionEntry, SessionSeed } from "../session/types";

// PINNED API (see dispatch) — CA-01 (already GREEN, T6). Reused, not rebuilt.
import type { CanonicalSubagentResult, ChildContractExtension } from "./contract";

// PINNED API (see dispatch) — CA-02 impl (T8) exports these; imports fail
// until then (expected RED: "Cannot find module './spawn'").
import { childResultToEvidence, spawnChild } from "./spawn";
import type { ChildResultToEvidenceInput, ChildSpawnResult, SpawnChildDeps, SpawnChildInput } from "./spawn";

// Frozen schemas dir, computed relative to this file
// (src/harness/child/ -> repo root).
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
// Deterministic fixtures.
// ---------------------------------------------------------------------------

function makeSpawnDeps(): SpawnChildDeps {
  let counter = 0;
  return {
    clock: () => "2026-07-13T00:00:00.000Z",
    idSeq: () => `spawn-${counter++}`,
  };
}

function makeSessionDeps(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return {
    clock: () => "2026-07-13T00:00:00.000Z",
    idSeq: () => `session-${counter++}`,
  };
}

const seed: SessionSeed = {
  sessionId: "parent-session-9",
  runId: "parent-run-9",
  createdAt: "2026-07-13T00:00:00.000Z",
  policyFingerprint: "a".repeat(64),
  contextManifestHash: "b".repeat(64),
};

const monitoredProfile: PolicyProfile = {
  schemaVersion: 1,
  profileId: "monitored-trusted-local",
  profileVersion: "1.0.0",
  fingerprint: sha256("monitored-trusted-local:1.0.0"),
  trustMode: "trusted-local",
  defaults: { read: "allow", write: "ask", shell: "ask", network: "ask", delegate: "ask" },
  requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
};

const readOnlyProfile: PolicyProfile = {
  schemaVersion: 1,
  profileId: "read-only-review",
  profileVersion: "1.0.0",
  fingerprint: sha256("read-only-review:1.0.0"),
  trustMode: "read-only",
  defaults: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" },
  requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
};

const unattendedProfile: PolicyProfile = {
  schemaVersion: 1,
  profileId: "unattended-untrusted",
  profileVersion: "1.0.0",
  fingerprint: sha256("unattended-untrusted:1.0.0"),
  trustMode: "untrusted",
  defaults: { read: "ask", write: "deny", shell: "deny", network: "deny", delegate: "deny" },
  requiredControls: { isolation: "required-fail-closed", redactionFailure: "deny", networkBrokerFailure: "deny" },
};

const parentProvenance: Provenance = {
  provenanceId: "provenance-parent-9",
  trustLevel: "trusted",
  sourceKind: "harness-run",
};

function makeSpawnInput(overrides: Partial<SpawnChildInput> = {}): SpawnChildInput {
  return {
    parentRunId: seed.runId,
    parentSessionId: seed.sessionId,
    parentProvenance,
    contextManifestHash: "c".repeat(64),
    canonicalContractVersion: "1.0.0",
    parentRemainingBudget: { maxRuntimeMs: 120_000, maxToolCalls: 40 },
    parentPolicy: monitoredProfile,
    childRequest: {
      attempt: { attemptId: "attempt-1", number: 1 },
      branchId: "branch-1",
      budgetRequest: { reservationId: "res-1", maxRuntimeMs: 30_000, maxToolCalls: 10 },
      policyRequest: readOnlyProfile,
      durableResultArtifact: {
        artifactId: "artifact-child-1",
        kind: "final-report",
        path: "artifacts/child-1.json",
        hash: "d".repeat(64),
      },
    },
    ...overrides,
  };
}

function expectGranted(result: ChildSpawnResult): Extract<ChildSpawnResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected spawnChild to grant, got denial: ${result.reason}`);
  return result;
}

function makeCanonicalResult(
  status: CanonicalSubagentResult["status"],
  extension: ChildContractExtension,
  overrides: Partial<CanonicalSubagentResult> = {},
): CanonicalSubagentResult {
  return {
    contract_version: "1.0.0",
    run_id: extension.parentRunId,
    dispatch_id: "015-T7-spawn",
    status,
    summary: `child reply for ${status}`,
    acceptance: [],
    artifacts: [],
    changed_files: [],
    findings: [],
    questions: [],
    errors: [],
    metrics: {},
    timestamp_utc: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

// ============================================================================
// 1. spawnChild — isolated build, fail-closed on budget/policy denial
// ============================================================================

describe("spawnChild — builds an isolated, schema-valid child extension", () => {
  test("a valid child request within parent budget/policy grants a spawn with a schema-valid extension", () => {
    const result = spawnChild(makeSpawnInput(), makeSpawnDeps());
    const granted = expectGranted(result);

    const validation = validateAgainstSchema(
      "harness-child-contract-extension.schema.json",
      granted.extension,
      { schemaDir: SCHEMA_DIR },
    );
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(granted.extension.canonicalContract).toBe("subagent-dispatch");
    expect(granted.extension.parentRunId).toBe(seed.runId);
    expect(granted.extension.sessionId).toBe(seed.sessionId);
    expect(granted.extension.attempt).toEqual({ attemptId: "attempt-1", number: 1 });
    expect(granted.extension.branchId).toBe("branch-1");
  });

  test("the granted budgetReservation on the extension never exceeds the parent's remaining budget", () => {
    const input = makeSpawnInput({ parentRemainingBudget: { maxRuntimeMs: 30_000, maxToolCalls: 10 } });
    const granted = expectGranted(spawnChild(input, makeSpawnDeps()));

    expect(granted.extension.budgetReservation.maxRuntimeMs).toBeLessThanOrEqual(30_000);
    expect(granted.extension.budgetReservation.maxToolCalls ?? 0).toBeLessThanOrEqual(10);
  });

  test("a child budget request exceeding the parent's remaining budget refuses to spawn at all (no partial extension)", () => {
    const input = makeSpawnInput({
      parentRemainingBudget: { maxRuntimeMs: 5_000, maxToolCalls: 2 },
      childRequest: {
        ...makeSpawnInput().childRequest,
        budgetRequest: { reservationId: "res-over", maxRuntimeMs: 999_999, maxToolCalls: 999 },
      },
    });

    const result = spawnChild(input, makeSpawnDeps());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the over-budget spawn to be denied");
    expect(result.reason.length).toBeGreaterThan(0);
    expect((result as unknown as { extension?: unknown }).extension).toBeUndefined();
  });

  test("a child policy request escalating beyond the parent's profile refuses to spawn at all", () => {
    const input = makeSpawnInput({
      parentPolicy: readOnlyProfile,
      childRequest: { ...makeSpawnInput().childRequest, policyRequest: unattendedProfile },
    });

    const result = spawnChild(input, makeSpawnDeps());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the policy-escalating spawn to be denied");
  });

  test("the returned dispatchEntryPayload/appendOptions append into the PARENT's own session (no separate child store)", () => {
    const parentSession = new AppendOnlySession(seed, makeSessionDeps());
    const parentEntry = parentSession.append({ type: "assistant_message", text: "parent kickoff" });

    const input = makeSpawnInput({ parentLeafEntryId: parentEntry.entryId });
    const granted = expectGranted(spawnChild(input, makeSpawnDeps()));

    const appended = parentSession.append(granted.dispatchEntryPayload, granted.appendOptions);

    expect(appended.causal.parentEventId).toBe(parentEntry.entryId);
    expect(appended.causal.attemptId).toBe("attempt-1");
    expect(appended.causal.branchId).toBe("branch-1");
    expect(parentSession.entries()).toHaveLength(2);
  });

  test("the returned provenance is derived from the parent's provenance (parent-link recorded)", () => {
    const granted = expectGranted(spawnChild(makeSpawnInput(), makeSpawnDeps()));
    expect(granted.provenance.trustLevel).toBe("derived");
    expect(granted.provenance.taintIds).toContain(parentProvenance.provenanceId);
  });
});

// ============================================================================
// 2. Dispositions -> parent evidence (AC4)
// ============================================================================

describe("AC4 — childResultToEvidence: dispositions are returned to the parent as evidence", () => {
  const statuses: CanonicalSubagentResult["status"][] = ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED", "FAILED"];

  for (const status of statuses) {
    test(`a ${status} child result maps to a schema-valid EvidenceRecord preserving the disposition`, () => {
      const granted = expectGranted(spawnChild(makeSpawnInput(), makeSpawnDeps()));
      const canonical = makeCanonicalResult(status, granted.extension);

      const evidenceInput: ChildResultToEvidenceInput = { canonical, extension: granted.extension };
      const record: EvidenceRecord = childResultToEvidence(evidenceInput, makeSpawnDeps());

      const validation = validateAgainstSchema("evidence-record.schema.json", record, { schemaDir: SCHEMA_DIR });
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      expect(record.causal.runId).toBe(granted.extension.parentRunId);
      expect(record.causal.sessionId).toBe(granted.extension.sessionId);
      expect(record.causal.attemptId).toBe(granted.extension.attempt.attemptId);
      expect(record.causal.branchId).toBe(granted.extension.branchId);
      expect(record.artifact.kind).toContain(status);
    });
  }

  test("a NEEDS_CONTEXT result names the missing bounded artifact on the evidence when supplied", () => {
    const granted = expectGranted(spawnChild(makeSpawnInput(), makeSpawnDeps()));
    const canonical = makeCanonicalResult("NEEDS_CONTEXT", granted.extension);

    const record = childResultToEvidence(
      { canonical, extension: granted.extension, missingArtifact: "context/missing-manifest.json" },
      makeSpawnDeps(),
    );

    expect(record.artifact.path).toBe("context/missing-manifest.json");
  });

  test("a DONE result's evidence carries no missing-artifact path", () => {
    const granted = expectGranted(spawnChild(makeSpawnInput(), makeSpawnDeps()));
    const canonical = makeCanonicalResult("DONE", granted.extension);

    const record = childResultToEvidence({ canonical, extension: granted.extension }, makeSpawnDeps());
    expect(record.artifact.path).toBeUndefined();
  });
});

// ============================================================================
// 3. Parent owns status/completion + D-02 (AC4, KEY)
// ============================================================================

interface RecordedCall {
  method: string;
  args: unknown[];
}

function notImplemented<K extends keyof FlowService>(method: K, calls: RecordedCall[]): FlowService[K] {
  return (async (...args: unknown[]) => {
    calls.push({ method, args });
    throw new Error(`unexpected call to FlowService.${method}`);
  }) as FlowService[K];
}

function fabricatedFlowState(taskId: string, disposition: TaskDisposition, evidenceRefs: string[], link: TaskRunLink): FlowState {
  return {
    schemaVersion: 2,
    id: "015",
    slug: "spawn-spy-flow",
    title: "Spawn spy flow",
    status: "in-progress",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    source: { type: "description", ref: null },
    acChecksum: null,
    acConfirmed: {},
    pr: { url: null },
    tasks: [
      { id: taskId, title: "Child task", kind: "implement", status: "done", disposition, evidenceRefs, runLink: link },
    ],
    history: [],
  };
}

function makeSpyFlowService(
  resultFactory: (input: Parameters<FlowService["taskDone"]>[0]) => FlowState,
): { service: FlowService; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const taskDone = (async (input: Parameters<FlowService["taskDone"]>[0]) => {
    calls.push({ method: "taskDone", args: [input] });
    return resultFactory(input);
  }) as FlowService["taskDone"];

  const service: FlowService = {
    init: notImplemented("init", calls),
    list: notImplemented("list", calls),
    get: notImplemented("get", calls),
    freeze: notImplemented("freeze", calls),
    start: notImplemented("start", calls),
    taskAdd: notImplemented("taskAdd", calls),
    taskDone,
    acConfirm: notImplemented("acConfirm", calls),
    acUpdate: notImplemented("acUpdate", calls),
    implemented: notImplemented("implemented", calls),
    complete: notImplemented("complete", calls),
    block: notImplemented("block", calls),
    unblock: notImplemented("unblock", calls),
    check: notImplemented("check", calls),
  };
  return { service, calls };
}

function makeGateDeps(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return { clock: () => "2026-07-13T00:00:00.000Z", idSeq: () => `gate-${counter++}` };
}

function runLink(): TaskRunLink {
  return { runId: seed.runId, sessionId: seed.sessionId, attempt: 1, at: "2026-07-13T00:00:00.000Z" };
}

describe("AC4 — parent owns status/completion (D-02): spawning + finishing a child never writes flow.json from the child path", () => {
  test("a DONE child's evidence flows through the PARENT's ManagedFlowPort.completeFromGate, calling exactly one FlowService.taskDone", async () => {
    const granted = expectGranted(spawnChild(makeSpawnInput(), makeSpawnDeps()));
    const canonical = makeCanonicalResult("DONE", granted.extension);
    const record = childResultToEvidence({ canonical, extension: granted.extension }, makeSpawnDeps());

    // The PARENT (this test, standing in for the coordinator) evaluates its
    // own completion gate over the evidence the child returned — the child
    // never asserts "completed" itself.
    const gateInput: CompletionInput = {
      runId: granted.extension.parentRunId,
      requiredGates: [{ name: "child", status: "pass" }],
      requiredEvidenceRefs: [record.evidenceId],
      presentEvidenceIds: [record.evidenceId],
      undisposedBlockerIds: [],
      finalMessageEmitted: true,
    };
    const gate: CompletionGateResult = evaluateCompletion(gateInput, makeGateDeps());
    expect(gate.status).toBe("pass");

    const link = runLink();
    const { service, calls } = makeSpyFlowService((input) =>
      fabricatedFlowState("T7", input.disposition ?? "completed", input.evidenceRefs ?? [], link),
    );
    const port: ManagedFlowPort = createTaskManagerFlowPort(service);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network access is not permitted anywhere on the child-completion path");
    }) as unknown as typeof fetch;

    try {
      const result = await port.completeFromGate({
        cwd: "/does/not/matter",
        flowId: "015",
        taskId: "T7",
        gate,
        evidenceRefs: [record.evidenceId],
        runLink: link,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("taskDone");
      const task = result.tasks.find((item) => item.id === "T7");
      expect(task?.disposition).toBe("completed");
      expect(task?.evidenceRefs).toEqual([record.evidenceId]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a NEEDS_CONTEXT / BLOCKED child disposition maps through the parent's gate to a 'blocked' completion, never a false 'completed'", async () => {
    const granted = expectGranted(spawnChild(makeSpawnInput(), makeSpawnDeps()));
    const canonical = makeCanonicalResult("BLOCKED", granted.extension);
    const record = childResultToEvidence({ canonical, extension: granted.extension }, makeSpawnDeps());

    const gate = evaluateCompletion(
      {
        runId: granted.extension.parentRunId,
        requiredGates: [{ name: "child", status: "pass" }],
        requiredEvidenceRefs: [record.evidenceId],
        presentEvidenceIds: [record.evidenceId],
        undisposedBlockerIds: [record.evidenceId],
        finalMessageEmitted: true,
      },
      makeGateDeps(),
    );
    expect(gate.status).toBe("blocked");

    const link = runLink();
    const { service, calls } = makeSpyFlowService((input) =>
      fabricatedFlowState("T7", input.disposition ?? "completed", input.evidenceRefs ?? [], link),
    );
    const port = createTaskManagerFlowPort(service);

    const result = await port.completeFromGate({
      cwd: "/does/not/matter",
      flowId: "015",
      taskId: "T7",
      gate,
      evidenceRefs: [record.evidenceId],
      runLink: link,
    });

    expect(calls).toHaveLength(1);
    const task = result.tasks.find((item) => item.id === "T7");
    expect(task?.disposition).toBe("blocked");
    expect(task?.disposition).not.toBe("completed");
  });

  test("a FAILED child disposition maps through the parent's gate to a 'failed' completion, never a false 'completed'", async () => {
    const granted = expectGranted(spawnChild(makeSpawnInput(), makeSpawnDeps()));
    const canonical = makeCanonicalResult("FAILED", granted.extension);
    const record = childResultToEvidence({ canonical, extension: granted.extension }, makeSpawnDeps());

    const gate = evaluateCompletion(
      {
        runId: granted.extension.parentRunId,
        requiredGates: [{ name: "child", status: "fail" }],
        requiredEvidenceRefs: [record.evidenceId],
        presentEvidenceIds: [record.evidenceId],
        undisposedBlockerIds: [],
        finalMessageEmitted: true,
      },
      makeGateDeps(),
    );
    expect(gate.status).toBe("fail");

    const link = runLink();
    const { service, calls } = makeSpyFlowService((input) =>
      fabricatedFlowState("T7", input.disposition ?? "completed", input.evidenceRefs ?? [], link),
    );
    const port = createTaskManagerFlowPort(service);

    const result = await port.completeFromGate({
      cwd: "/does/not/matter",
      flowId: "015",
      taskId: "T7",
      gate,
      evidenceRefs: [record.evidenceId],
      runLink: link,
    });

    expect(calls).toHaveLength(1);
    const task = result.tasks.find((item) => item.id === "T7");
    expect(task?.disposition).toBe("failed");
  });

  test("neither spawnChild nor childResultToEvidence accepts a FlowService/ManagedFlowPort (structurally cannot reach flow.json)", () => {
    // spawnChild's and childResultToEvidence's pinned signatures take only
    // (input, deps) where `deps` is `{ idSeq, clock }` — no FlowService, no
    // ManagedFlowPort, no fs handle. This is asserted at the type level by
    // this file's own imports (SpawnChildDeps has exactly idSeq/clock) and
    // reinforced here: a deps object carrying a `taskDone`-shaped spy must
    // never be invoked by either function.
    const granted = expectGranted(spawnChild(makeSpawnInput(), makeSpawnDeps()));
    const canonical = makeCanonicalResult("DONE", granted.extension);
    const spyCalls: RecordedCall[] = [];
    const baseDeps = makeSpawnDeps();
    const deps: SpawnChildDeps & { taskDone?: unknown } = {
      idSeq: baseDeps.idSeq,
      clock: baseDeps.clock,
      taskDone: () => {
        spyCalls.push({ method: "taskDone", args: [] });
        throw new Error("spawn.ts must never call a flow-writing method");
      },
    };

    childResultToEvidence({ canonical, extension: granted.extension }, deps);
    expect(spyCalls).toHaveLength(0);
  });
});

// ============================================================================
// 4. Prior attempts immutable (AC4)
// ============================================================================

describe("AC4 — prior attempts immutable: a new child attempt never mutates a prior attempt's record", () => {
  test("spawning a second child attempt leaves the first attempt's session entries byte-identical and reachable", () => {
    const parentSession = new AppendOnlySession(seed, makeSessionDeps());
    const kickoff = parentSession.append({ type: "assistant_message", text: "parent kickoff" });

    const firstInput = makeSpawnInput({ parentLeafEntryId: kickoff.entryId });
    const firstGrant = expectGranted(spawnChild(firstInput, makeSpawnDeps()));
    const firstEntry = parentSession.append(firstGrant.dispatchEntryPayload, firstGrant.appendOptions);
    const firstCanonical = makeCanonicalResult("NEEDS_CONTEXT", firstGrant.extension);
    const firstEvidence = childResultToEvidence({ canonical: firstCanonical, extension: firstGrant.extension }, makeSpawnDeps());

    const entriesAfterFirst = parentSession.entries();
    const frozenFirstEntry = entriesAfterFirst.find((entry: SessionEntry) => entry.entryId === firstEntry.entryId);
    if (!frozenFirstEntry) throw new Error("expected the first attempt's entry to be reachable");
    const firstEntrySnapshot = JSON.parse(JSON.stringify(frozenFirstEntry)) as SessionEntry;

    // A new (second) attempt, reusing the SAME branch, on the SAME parent session.
    const secondInput = makeSpawnInput({
      parentLeafEntryId: firstEntry.entryId,
      childRequest: {
        ...makeSpawnInput().childRequest,
        attempt: { attemptId: "attempt-2", number: 2 },
      },
    });
    const secondGrant = expectGranted(spawnChild(secondInput, makeSpawnDeps()));
    parentSession.append(secondGrant.dispatchEntryPayload, secondGrant.appendOptions);

    // The prior (first) attempt's entry is untouched, byte-identical, and
    // still reachable — a new attempt appends, it never rewrites history.
    const entriesAfterSecond = parentSession.entries();
    const stillThere = entriesAfterSecond.find((entry: SessionEntry) => entry.entryId === firstEntry.entryId);
    expect(stillThere).toEqual(firstEntrySnapshot);
    expect(entriesAfterSecond.length).toBeGreaterThan(entriesAfterFirst.length);

    // Direct mutation of the frozen prior-attempt entry throws.
    expect(() => {
      (stillThere as unknown as { entryId: string }).entryId = "forged-rewrite";
    }).toThrow();

    // The first attempt's own evidence record is unaffected by the second spawn.
    expect(firstEvidence.causal.attemptId).toBe("attempt-1");
  });

  test("there is no API to mutate or replace a prior attempt's evidence record on the parent session", () => {
    const parentSession = new AppendOnlySession(seed, makeSessionDeps()) as unknown as Record<string, unknown>;
    expect(parentSession.mutateEntry).toBeUndefined();
    expect(parentSession.replaceEntry).toBeUndefined();
    expect(parentSession.overwrite).toBeUndefined();
  });
});

// ============================================================================
// 5. Determinism (AC5)
// ============================================================================

describe("Determinism — spawnChild / childResultToEvidence are pure aside from injected deps", () => {
  test("spawning twice with identical input and a fresh identical idSeq/clock yields a deep-equal extension", () => {
    const first = expectGranted(spawnChild(makeSpawnInput(), makeSpawnDeps()));
    const second = expectGranted(spawnChild(makeSpawnInput(), makeSpawnDeps()));

    expect(first.extension).toEqual(second.extension);
    expect(first.dispatchEntryPayload).toEqual(second.dispatchEntryPayload);
    expect(first.appendOptions).toEqual(second.appendOptions);
  });

  test("childResultToEvidence twice with identical input and a fresh identical idSeq/clock yields a deep-equal record", () => {
    const granted = expectGranted(spawnChild(makeSpawnInput(), makeSpawnDeps()));
    const canonical = makeCanonicalResult("DONE", granted.extension);

    const first = childResultToEvidence({ canonical, extension: granted.extension }, makeSpawnDeps());
    const second = childResultToEvidence({ canonical, extension: granted.extension }, makeSpawnDeps());

    expect(first).toEqual(second);
  });
});

// ============================================================================
// Model threading (flow 089, Phase 2): guard order budget -> policy -> model.
// ============================================================================

// A trusted-local profile that permits network (none of the base fixtures do),
// used to exercise the positive network-provider path.
const networkAllowedProfile: PolicyProfile = {
  ...monitoredProfile,
  defaults: { read: "allow", write: "ask", shell: "ask", network: "allow", delegate: "ask" },
};

describe("spawnChild — model resolution threading (flow 089)", () => {
  test("AC5 backward-compat: no parentModel => no modelSelection, extension stays schema-valid", () => {
    const granted = expectGranted(spawnChild(makeSpawnInput(), makeSpawnDeps()));
    expect(granted.extension.modelSelection).toBeUndefined();
    const validation = validateAgainstSchema(
      "harness-child-contract-extension.schema.json",
      granted.extension,
      { schemaDir: SCHEMA_DIR },
    );
    expect(validation.valid).toBe(true);
  });

  test("inherit default: parentModel + omitted modelRequest => source:inherited equals parent", () => {
    const input = makeSpawnInput({
      parentModel: { providerId: "ollama", modelId: "qwen2.5-coder" },
      allowedProviders: new Set(["ollama"]),
    });
    const granted = expectGranted(spawnChild(input, makeSpawnDeps()));
    expect(granted.extension.modelSelection).toEqual({
      providerId: "ollama",
      modelId: "qwen2.5-coder",
      source: "inherited",
    });
    const validation = validateAgainstSchema(
      "harness-child-contract-extension.schema.json",
      granted.extension,
      { schemaDir: SCHEMA_DIR },
    );
    expect(validation.valid).toBe(true);
  });

  test("explicit request is reflected on the extension with source:explicit", () => {
    const input = makeSpawnInput({
      parentModel: { providerId: "ollama", modelId: "qwen2.5-coder" },
      allowedProviders: new Set(["ollama"]),
      childRequest: {
        ...makeSpawnInput().childRequest,
        modelRequest: { kind: "explicit", providerId: "ollama", modelId: "llama3" },
      },
    });
    const granted = expectGranted(spawnChild(input, makeSpawnDeps()));
    expect(granted.extension.modelSelection).toEqual({
      providerId: "ollama",
      modelId: "llama3",
      source: "explicit",
    });
  });

  test("a network provider is granted when the child policy permits network", () => {
    const input = makeSpawnInput({
      // Parent must also permit network, else the child's network:allow is a
      // policy escalation and inheritPolicy denies before the model gate runs.
      parentPolicy: networkAllowedProfile,
      parentModel: { providerId: "anthropic", modelId: "claude-opus-4-8" },
      allowedProviders: new Set(["anthropic", "ollama"]),
      childRequest: { ...makeSpawnInput().childRequest, policyRequest: networkAllowedProfile },
    });
    const granted = expectGranted(spawnChild(input, makeSpawnDeps()));
    expect(granted.extension.modelSelection?.providerId).toBe("anthropic");
    expect(granted.extension.modelSelection?.source).toBe("inherited");
  });

  test("AC3 model denial (network provider under read-only policy) refuses the whole spawn — no extension", () => {
    const input = makeSpawnInput({
      parentModel: { providerId: "anthropic", modelId: "claude-opus-4-8" },
      allowedProviders: new Set(["anthropic", "ollama"]),
      // childRequest.policyRequest defaults to readOnlyProfile (network deny).
    });
    const result = spawnChild(input, makeSpawnDeps());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected model resolution to deny the spawn");
    expect(result.reason).toContain("model resolution denied");
    expect((result as unknown as { extension?: unknown }).extension).toBeUndefined();
  });

  test("AC3 model denial (provider not in allowlist) refuses the whole spawn", () => {
    const input = makeSpawnInput({
      parentModel: { providerId: "ollama", modelId: "qwen2.5-coder" },
      allowedProviders: new Set(["ollama"]),
      childRequest: {
        ...makeSpawnInput().childRequest,
        modelRequest: { kind: "explicit", providerId: "deepseek", modelId: "deepseek-chat" },
      },
    });
    const result = spawnChild(input, makeSpawnDeps());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected allowlist denial");
    expect(result.reason).toContain("model resolution denied");
  });

  test("guard order: a budget denial preempts model resolution", () => {
    const input = makeSpawnInput({
      parentRemainingBudget: { maxRuntimeMs: 1_000, maxToolCalls: 1 },
      parentModel: { providerId: "ollama", modelId: "qwen2.5-coder" },
      allowedProviders: new Set(["ollama"]),
      childRequest: {
        ...makeSpawnInput().childRequest,
        budgetRequest: { reservationId: "res-over", maxRuntimeMs: 999_999, maxToolCalls: 999 },
      },
    });
    const result = spawnChild(input, makeSpawnDeps());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected budget denial");
    expect(result.reason).toContain("budget inheritance denied");
  });
});

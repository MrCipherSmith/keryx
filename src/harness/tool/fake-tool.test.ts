// RED tests for F-02 (flow 008, W6 / T8).
//
// Pins one registered, read-only fake tool over the W5 tool port
// (`src/harness/tool/types.ts`, `registry.ts`, `tool-port.ts`) whose `invoke`
// returns a hash-bound `ToolResult`, per `docs/requirements/keryx-project-agent-harness/specification.md`
// ("Tool Definition" — read-only classification, provenance, replay flag; "the
// model must not receive direct filesystem or shell access outside registered
// tools") and the frozen AC3: "one registered read-only fake tool over the W5
// tool port whose invoke returns a ToolResult with a hash-bound outputHash
// stable across runs (same input->same hash); execution only after
// validateToolCall (unregistered/invalid rejected); no network/fs/mutation."
//
// F-02 implements `src/harness/tool/fake-tool.ts` (`FAKE_READONLY_TOOL`,
// `recordedOutputHash`, `FakeToolExecutor`) to make this suite GREEN; until
// then the missing-module import is the expected RED failure.
//
// Deterministic: no Date.now(), no network, no randomness.
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";
// PINNED API (see dispatch): F-02 exports these from "./fake-tool".
// - `FAKE_READONLY_TOOL`: a read-only `ToolDefinition` (risk "read",
//   `replay: {deterministic:true, recordedResultSupported:true}`, a real
//   `inputSchema` requiring a string `key`).
// - `recordedOutputHash(input)`: a deterministic sha256 hex digest over the
//   canonical recorded output for a given input (no clock/random).
// - `FakeToolExecutor`: implements `ToolExecutorPort`; constructor takes a
//   `ToolRegistry` and `{schemaDir}`; `invoke` gates via `validateToolCall`
//   THEN returns a hash-bound `ToolResult` (`outputHash ===
//   recordedOutputHash(inv.call.input)`); read-only, no side effects.
import { FAKE_READONLY_TOOL, FakeToolExecutor, recordedOutputHash } from "./fake-tool";
import { ToolRegistry } from "./registry";
import type { ToolCall, ToolInvocation, ToolProvenance } from "./types";

// Frozen schemas dir, computed relative to this file
// (src/harness/tool/ -> repo root).
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

const fixtureProvenance: ToolProvenance = {
  projectRoot: "/repo",
  worktree: "/repo/.worktrees/feature",
  sessionId: "session-1",
  turn: 1,
  toolCallId: "call-1",
};

/**
 * Build a valid `ToolCall` envelope for `FAKE_READONLY_TOOL`, satisfying both
 * `harness-tool-call.schema.json` and the tool's own inline `inputSchema`
 * (`{type:object, required:["key"], properties:{key:{type:"string"}}}`).
 */
function buildValidCall(toolCallId: string, key: string): ToolCall {
  return {
    schemaVersion: 1,
    toolCallId,
    toolName: FAKE_READONLY_TOOL.toolId,
    input: { key },
    runId: "run-1",
    sessionId: "session-1",
    risk: "read",
  };
}

function buildInvocation(call: ToolCall): ToolInvocation {
  return { call, provenance: fixtureProvenance };
}

// --- 1. Definition valid -------------------------------------------------------

describe("FAKE_READONLY_TOOL — read-only ToolDefinition (specification.md 'Tool Definition')", () => {
  test("validates against tool-definition.schema.json (classification, if declared, is an in-memory-only extension per tool-definition.schema.json's additionalProperties:false — see tool-port.test.ts precedent — and is stripped before schema validation)", () => {
    const { classification: _classification, ...wireShaped } = FAKE_READONLY_TOOL;
    const result = validateAgainstSchema("tool-definition.schema.json", wireShaped, {
      schemaDir: SCHEMA_DIR,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("risk is 'read'; classification is fully read-only (write/network/subprocess/credential all false); replay is deterministic + recordedResultSupported", () => {
    expect(FAKE_READONLY_TOOL.risk).toBe("read");
    expect(FAKE_READONLY_TOOL.classification).toEqual({
      read: true,
      write: false,
      network: false,
      subprocess: false,
      credential: false,
    });
    expect(FAKE_READONLY_TOOL.replay).toEqual({ deterministic: true, recordedResultSupported: true });
  });

  test("declares a real inputSchema requiring a string 'key' (used by the happy-path + gate tests below)", () => {
    const call = buildValidCall("call-schema-check", "alpha");
    const registry = new ToolRegistry();
    registry.register(FAKE_READONLY_TOOL);
    const result = validateAgainstSchema("harness-tool-call.schema.json", call, { schemaDir: SCHEMA_DIR });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// --- 2. Register + invoke happy path -------------------------------------------

describe("FakeToolExecutor — register + invoke happy path", () => {
  test("invoke(inv) resolves to a ToolResult that validates against tool-result.schema.json and is bound to recordedOutputHash(call.input)", async () => {
    const registry = new ToolRegistry();
    registry.register(FAKE_READONLY_TOOL);
    const executor = new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR });

    const call = buildValidCall("call-happy-1", "alpha");
    const result = await executor.invoke(buildInvocation(call));

    const schemaCheck = validateAgainstSchema("tool-result.schema.json", result, { schemaDir: SCHEMA_DIR });
    expect(schemaCheck.valid).toBe(true);
    expect(schemaCheck.errors).toEqual([]);

    expect(result.toolCallId).toBe(call.toolCallId);
    expect(result.status).toBe("succeeded");
    expect(result.outputHash).toBe(recordedOutputHash(call.input));
  });
});

// --- 3. Hash-bound & stable -----------------------------------------------------

describe("recordedOutputHash / FakeToolExecutor.invoke — deterministic, stable hash binding", () => {
  test("recordedOutputHash is a stable sha256 hex digest: same input (fresh object) -> same hash, different input -> different hash", () => {
    const hashA1 = recordedOutputHash({ key: "alpha" });
    const hashA2 = recordedOutputHash({ key: "alpha" });
    const hashB = recordedOutputHash({ key: "beta" });

    expect(hashA1).toMatch(/^[a-f0-9]{64}$/);
    expect(hashA1).toBe(hashA2);
    expect(hashA1).not.toBe(hashB);
  });

  test("invoke() outputHash is stable across two invocations with the same input, on the same executor instance", async () => {
    const registry = new ToolRegistry();
    registry.register(FAKE_READONLY_TOOL);
    const executor = new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR });

    const first = await executor.invoke(buildInvocation(buildValidCall("call-stable-1", "alpha")));
    const second = await executor.invoke(buildInvocation(buildValidCall("call-stable-2", "alpha")));

    expect(first.outputHash).toBe(second.outputHash);
    expect(first.outputHash).toBe(recordedOutputHash({ key: "alpha" }));
  });

  test("invoke() outputHash is stable across two independent FakeToolExecutor/ToolRegistry instances, for the same input", async () => {
    const registryA = new ToolRegistry();
    registryA.register(FAKE_READONLY_TOOL);
    const executorA = new FakeToolExecutor(registryA, { schemaDir: SCHEMA_DIR });

    const registryB = new ToolRegistry();
    registryB.register(FAKE_READONLY_TOOL);
    const executorB = new FakeToolExecutor(registryB, { schemaDir: SCHEMA_DIR });

    const resultA = await executorA.invoke(buildInvocation(buildValidCall("call-cross-a", "gamma")));
    const resultB = await executorB.invoke(buildInvocation(buildValidCall("call-cross-b", "gamma")));

    expect(resultA.outputHash).toBe(resultB.outputHash);
  });

  test("invoke() outputHash differs for different, otherwise-valid input", async () => {
    const registry = new ToolRegistry();
    registry.register(FAKE_READONLY_TOOL);
    const executor = new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR });

    const resultAlpha = await executor.invoke(buildInvocation(buildValidCall("call-diff-1", "alpha")));
    const resultDelta = await executor.invoke(buildInvocation(buildValidCall("call-diff-2", "delta")));

    expect(resultAlpha.outputHash).not.toBe(resultDelta.outputHash);
  });
});

// --- 4. Read-only / no side effects ---------------------------------------------

describe("FakeToolExecutor — read-only, no network side effects", () => {
  test("invoke() never calls globalThis.fetch", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    // biome-ignore lint: intentional structural network-call detector for this test only.
    globalThis.fetch = (() => {
      called = true;
      throw new Error("FakeToolExecutor must not perform network I/O (fetch was invoked)");
    }) as unknown as typeof fetch;

    try {
      const registry = new ToolRegistry();
      registry.register(FAKE_READONLY_TOOL);
      const executor = new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR });
      const result = await executor.invoke(buildInvocation(buildValidCall("call-no-fetch", "alpha")));
      expect(result.status).toBe("succeeded");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(called).toBe(false);
  });
});

// --- 5. Gate: unregistered / invalid rejected -----------------------------------
//
// Design decision pinned by this suite (see dispatch item 5 — "assert
// whichever the pinned API does, note precisely"): `FakeToolExecutor.invoke`
// gates via `validateToolCall` (unregistered toolName, envelope-invalid call,
// or input violating the tool's `inputSchema`) and REJECTS the returned
// promise (throws) rather than resolving to a "policy-denied" `ToolResult`.
// This matches the dispatch's "rejected (no ToolResult / throws / typed
// failure)" phrasing read as one outcome, not three alternatives: a gate
// failure never reaches "a ToolResult" at all. If F-02's impl instead resolves
// with a non-succeeded `ToolResult` (e.g. `status: "policy-denied"`), that is
// a delta to flag back in the subagent-result — these three tests would need
// `.rejects` swapped for a resolved-status assertion.
describe("FakeToolExecutor — gate: unregistered/invalid calls cannot produce a success ToolResult", () => {
  test("invoking a call whose toolName is not registered rejects", async () => {
    const registry = new ToolRegistry();
    // FAKE_READONLY_TOOL intentionally NOT registered.
    const executor = new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR });

    const call = buildValidCall("call-unregistered", "alpha");
    await expect(executor.invoke(buildInvocation(call))).rejects.toBeDefined();
  });

  test("invoking a call whose input violates the tool's inputSchema (missing required 'key') rejects", async () => {
    const registry = new ToolRegistry();
    registry.register(FAKE_READONLY_TOOL);
    const executor = new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR });

    const invalidInputCall: ToolCall = {
      schemaVersion: 1,
      toolCallId: "call-bad-input",
      toolName: FAKE_READONLY_TOOL.toolId,
      input: {},
      runId: "run-1",
      sessionId: "session-1",
      risk: "read",
    };

    await expect(executor.invoke(buildInvocation(invalidInputCall))).rejects.toBeDefined();
  });

  test("invoking a call whose envelope is invalid (bad risk enum value) rejects", async () => {
    const registry = new ToolRegistry();
    registry.register(FAKE_READONLY_TOOL);
    const executor = new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR });

    const envelopeInvalidCall = {
      schemaVersion: 1,
      toolCallId: "call-bad-envelope",
      toolName: FAKE_READONLY_TOOL.toolId,
      input: { key: "alpha" },
      runId: "run-1",
      sessionId: "session-1",
      risk: "not-a-real-risk",
    } as unknown as ToolCall;

    await expect(executor.invoke(buildInvocation(envelopeInvalidCall))).rejects.toBeDefined();
  });

  test("a gate-rejected call never calls globalThis.fetch either", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    // biome-ignore lint: intentional structural network-call detector for this test only.
    globalThis.fetch = (() => {
      called = true;
      throw new Error("FakeToolExecutor must not perform network I/O (fetch was invoked)");
    }) as unknown as typeof fetch;

    try {
      const registry = new ToolRegistry();
      // FAKE_READONLY_TOOL intentionally NOT registered.
      const executor = new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR });
      const call = buildValidCall("call-unregistered-no-fetch", "alpha");
      await expect(executor.invoke(buildInvocation(call))).rejects.toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(called).toBe(false);
  });
});

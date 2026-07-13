// RED tests for the assembled offline run loop (flow 009, W7 / S5, task-R0-03).
//
// Pins the frozen scenarios from
// `docs/requirements/keryx-project-agent-harness/acceptance.feature`:
//   - @SC_R04_READ_ONLY_TOOL          "Execute one registered read-only tool"
//   - @SC_R04_MALFORMED_TOOL_INPUT    "Reject malformed tool input"
//   - @SC_R04_TOOL_TIMEOUT            "Bound a read-only tool timeout"
//   - @SC_R04_TOOL_OUTPUT_OVERFLOW    "Bound tool output overflow"
//   - @SC_R12_BUDGET_EXHAUSTION       "Stop at a hard budget boundary"
//   - @SC_R12_LOOP_DETECTION          "Stop a repeated ineffective loop"
//
// `runOffline` assembles: startRun (S1) -> context manifest (S1) ->
// provider.stream(request) (W5/W6) -> on tool_call_end: decide() (S3) ->
// allow: toolExecutor.invoke (W5/W6, result redacted+hashed per S4) -> session
// append (S2) + evidence record (S4) -> budget/loop checks -> on model_end:
// evaluateCompletion (S4) -> HarnessRunOutput. Deterministic and offline: no
// Date.now, no Math.random, no network, no real timers — every timeout /
// overflow / budget / loop scenario is modelled by an injected deterministic
// stub, never a real clock wait.
//
// S5 impl (next dispatch) implements `src/harness/run/run.ts` (`runOffline`,
// `RunDeps`, `RunResult`, `HarnessRunOutput`) to make this suite GREEN; until
// then the missing-module import is the expected RED failure.
//
// Provider wiring note: rather than reverse-engineer the exact in-memory
// `NormalizedRequest` `runOffline` builds internally (unpinned), each test
// wraps the real, committed `FakeProvider` in a thin local adapter that
// ignores the request `runOffline` passes in and instead calls the underlying
// `FakeProvider` with a locally built request whose `requestHashOf` has been
// stamped onto the fixture transcript (same technique as
// `fake-provider.test.ts`'s `withMatchingHash`). This keeps the suite decoupled
// from S5's internal request-construction shape while still exercising the
// real `FakeProvider` replay behaviour end-to-end.
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";
import type { HarnessConfig } from "../config";
import { FakeProvider, type FakeProviderTranscript, requestHashOf } from "../provider/fake-provider";
import type { NormalizedRequest, ProviderPort } from "../provider/types";
import type { PolicyProfile } from "../policy/types";
import { FAKE_READONLY_TOOL, FakeToolExecutor } from "../tool/fake-tool";
import { ToolRegistry } from "../tool/registry";
import type { ToolDefinition, ToolExecutorPort, ToolInvocation, ToolResult } from "../tool/types";
import type { HarnessRunInput } from "../types";

// PINNED API (see dispatch) — S5 impl exports these from "./run"; imports
// fail until then (expected RED: "Cannot find module './run'").
import { runOffline } from "./run";
import type { RunDeps, RunResult } from "./run";

// Frozen schemas dir, computed relative to this file
// (src/harness/run/ -> repo root).
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
// Mirrors `src/harness/policy/engine.test.ts` / `completion/gate.test.ts`
// `makeDeps()`.
// ---------------------------------------------------------------------------
function makeDeps(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return {
    clock: () => "2026-01-01T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
  };
}

// A read-only-review profile (defaults.read = "allow"), shaped exactly per
// `policy-profile.schema.json` — mirrors `engine.test.ts`'s `readOnlyProfile`.
const readOnlyProfile: PolicyProfile = {
  schemaVersion: 1,
  profileId: "read-only-review",
  profileVersion: "1.0.0",
  fingerprint: sha256("read-only-review:1.0.0"),
  trustMode: "read-only",
  defaults: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" },
  requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
};

function buildConfig(): HarnessConfig {
  return {
    schemaVersion: 1,
    enabled: true,
    defaultRole: "build",
    defaultProvider: "fake-provider",
    defaultModel: "fixture-model",
    policyProfile: "read-only-review",
    limits: { maxRunSeconds: 300, maxConcurrentChildren: 1, maxToolOutputBytes: 65_536, maxRetries: 1 },
  };
}

function buildInput(overrides?: Partial<HarnessRunInput>): HarnessRunInput {
  return {
    schemaVersion: 1,
    request: "run the fixture scenario",
    projectRoot: "/repo",
    role: "build",
    policy: "read-only-review",
    budget: { maxSeconds: 60, maxToolCalls: 5, maxRetries: 1 },
    provider: "fake-provider",
    model: "fixture-model",
    credentialRef: "cred-ref-1",
    ...overrides,
  };
}

function buildRegistry(...defs: ToolDefinition[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const def of defs) registry.register(def);
  return registry;
}

interface RawToolCallSpec {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

// Builds a fixture transcript with one `tool_call` raw event per spec, in
// order, followed by a final assistant `text_delta` + `finish` — giving a
// legitimate final message the completion gate can see, per AC5 ("run
// completes") for the happy-path scenario.
function makeTranscript(
  transcriptId: string,
  calls: RawToolCallSpec[],
  finalText = "Task complete.",
): FakeProviderTranscript {
  const events: FakeProviderTranscript["events"] = [
    ...calls.map((call, index) => ({
      sequence: index,
      kind: "tool_call" as const,
      payload: { toolName: call.toolName, toolCallId: call.toolCallId, input: call.input },
    })),
    { sequence: calls.length, kind: "text_delta" as const, payload: { text: finalText } },
    { sequence: calls.length + 1, kind: "finish" as const, payload: {} },
  ];
  return {
    schemaVersion: 1,
    transcriptId,
    providerId: "fake-provider",
    providerRevision: "fake-1.0.0",
    requestHash: "0".repeat(64),
    events,
  };
}

function buildFixtureRequest(requestId: string): NormalizedRequest {
  return {
    providerId: "fake-provider",
    modelId: "fixture-model",
    systemInstruction: "fixture system instruction",
    messages: [{ role: "user", content: "fixture prompt" }],
    budget: { maxOutputTokens: 1000, runReservation: 1000 },
    stream: true,
    requestId,
    parentRunId: "run-fixture",
  };
}

// Wraps the real `FakeProvider` so `runOffline`'s internal request shape
// (unpinned) never has to match the fixture's `requestHash` — see file header.
function fixtureProvider(
  transcript: FakeProviderTranscript,
  requestId: string,
): { provider: ProviderPort; streamCalls: { count: number } } {
  const request = buildFixtureRequest(requestId);
  const stamped: FakeProviderTranscript = { ...transcript, requestHash: requestHashOf(request) };
  const fake = new FakeProvider([stamped]);
  const streamCalls = { count: 0 };
  const provider: ProviderPort = {
    describe: () => fake.describe(),
    stream: (_request, opts) => {
      streamCalls.count++;
      return fake.stream(request, opts);
    },
  };
  return { provider, streamCalls };
}

interface ExecutorSpyResult {
  ok: boolean;
  value?: ToolResult;
  error?: unknown;
}

// Wraps a real `ToolExecutorPort` (or a deterministic stub) to observe how
// many times, and with what outcome, `runOffline` invokes it — without
// depending on any internal `RunResult` shape beyond the pinned fields.
function spyExecutor(executor: ToolExecutorPort): {
  wrapped: ToolExecutorPort;
  calls: ToolInvocation[];
  results: ExecutorSpyResult[];
} {
  const calls: ToolInvocation[] = [];
  const results: ExecutorSpyResult[] = [];
  const wrapped: ToolExecutorPort = {
    invoke: async (invocation: ToolInvocation) => {
      calls.push(invocation);
      try {
        const value = await executor.invoke(invocation);
        results.push({ ok: true, value });
        return value;
      } catch (error) {
        results.push({ ok: false, error });
        throw error;
      }
    },
  };
  return { wrapped, calls, results };
}

// Deterministically models a bounded, typed executor failure (timeout /
// output overflow) with NO real timer or unbounded output — the executor
// simply reports the bounded outcome immediately, per the dispatch's "model
// deterministically" instruction.
function makeBoundedExecutor(errorCode: string): ToolExecutorPort {
  return {
    invoke: async (invocation: ToolInvocation): Promise<ToolResult> => ({
      schemaVersion: 1,
      toolResultId: `result-${invocation.call.toolCallId}`,
      executionId: `exec-${invocation.call.toolCallId}`,
      toolCallId: invocation.call.toolCallId,
      causal: {
        runId: invocation.call.runId,
        sessionId: invocation.call.sessionId,
        correlationId: invocation.call.toolCallId,
      },
      status: "failed",
      outputHash: sha256(`${errorCode}:${invocation.call.toolCallId}`),
      errorCode,
      redaction: "not-needed",
      createdAt: "1970-01-01T00:00:00.000Z",
    }),
  };
}

function buildRunDeps(overrides: {
  provider: ProviderPort;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutorPort;
  policyProfile?: PolicyProfile;
  interactive?: boolean;
}): RunDeps {
  const { clock, idSeq } = makeDeps();
  return {
    provider: overrides.provider,
    toolRegistry: overrides.toolRegistry,
    toolExecutor: overrides.toolExecutor,
    policyProfile: overrides.policyProfile ?? readOnlyProfile,
    clock,
    idSeq,
    interactive: overrides.interactive ?? true,
  };
}

// ---------------------------------------------------------------------------
// 1. Read-only tool run (@SC_R04_READ_ONLY_TOOL).
// ---------------------------------------------------------------------------
describe("runOffline — executes one registered read-only tool", () => {
  test("input validates before execution; output is redacted/hash-bound; session + evidence linked; run completes", async () => {
    const registry = buildRegistry(FAKE_READONLY_TOOL);
    const transcript = makeTranscript("t-read-only", [
      { toolCallId: "call-1", toolName: FAKE_READONLY_TOOL.toolId, input: { key: "value" } },
    ]);
    const { provider } = fixtureProvider(transcript, "req-read-only");
    const spy = spyExecutor(new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR }));
    const deps = buildRunDeps({ provider, toolRegistry: registry, toolExecutor: spy.wrapped });

    const result: RunResult = await runOffline(buildInput(), buildConfig(), deps);

    expect(spy.calls.length).toBe(1);
    const first = spy.results[0];
    expect(first?.ok).toBe(true);
    expect(first?.value?.status).toBe("succeeded");

    expect(
      result.decisions.some((d: { toolCallId: string; decision: string }) => d.toolCallId === "call-1" && d.decision === "allow"),
    ).toBe(true);
    expect(result.sessionEntries.some((e: { entry: { type: string } }) => e.entry.type === "tool_result")).toBe(true);
    expect(result.sessionEntries.some((e: { entry: { type: string } }) => e.entry.type === "policy_decision")).toBe(
      true,
    );
    expect(result.events.some((e: { kind: string }) => e.kind === "tool_call_end")).toBe(true);

    const validation = validateAgainstSchema("harness-run-output.schema.json", result.output, {
      schemaDir: SCHEMA_DIR,
    });
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(result.output.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// 2. Malformed tool input (@SC_R04_MALFORMED_TOOL_INPUT).
// ---------------------------------------------------------------------------
describe("runOffline — rejects malformed/schema-invalid tool input", () => {
  test("a complete tool call whose input fails the tool's inputSchema is never executed and records a typed rejection", async () => {
    const registry = buildRegistry(FAKE_READONLY_TOOL);
    // `input: {}` is valid JSON (so the provider stream completes normally)
    // but fails FAKE_READONLY_TOOL's inputSchema (`required: ["key"]`).
    const transcript = makeTranscript("t-malformed-input", [
      { toolCallId: "call-bad", toolName: FAKE_READONLY_TOOL.toolId, input: {} },
    ]);
    const { provider } = fixtureProvider(transcript, "req-malformed-input");
    const spy = spyExecutor(new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR }));
    const deps = buildRunDeps({ provider, toolRegistry: registry, toolExecutor: spy.wrapped });

    const result: RunResult = await runOffline(buildInput(), buildConfig(), deps);

    // The gate inside FakeToolExecutor.invoke rejects invalid input before any
    // ToolResult is produced — "no execution receipt or side effect".
    expect(spy.calls.length).toBe(1);
    const first = spy.results[0];
    expect(first?.ok).toBe(false);
    expect(
      result.sessionEntries.some(
        (e: { entry: { type: string; artifactRef?: unknown } }) =>
          e.entry.type === "tool_result" && "artifactRef" in e.entry,
      ),
    ).toBe(false);
    expect(result.output.status).not.toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// 3. Bounded tool timeout / output overflow
//    (@SC_R04_TOOL_TIMEOUT / @SC_R04_TOOL_OUTPUT_OVERFLOW).
// ---------------------------------------------------------------------------
describe("runOffline — bounds a tool timeout or output overflow", () => {
  test("timeout: a deterministic over-limit executor yields a bounded typed result, no hang, no false success", async () => {
    const registry = buildRegistry(FAKE_READONLY_TOOL);
    const transcript = makeTranscript("t-timeout", [
      { toolCallId: "call-timeout", toolName: FAKE_READONLY_TOOL.toolId, input: { key: "slow" } },
    ]);
    const { provider } = fixtureProvider(transcript, "req-timeout");
    const spy = spyExecutor(makeBoundedExecutor("tool_timeout"));
    const deps = buildRunDeps({ provider, toolRegistry: registry, toolExecutor: spy.wrapped });

    const result: RunResult = await runOffline(buildInput(), buildConfig(), deps);

    expect(spy.calls.length).toBe(1);
    const first = spy.results[0];
    expect(first?.ok).toBe(true);
    expect(first?.value?.status).not.toBe("succeeded");
    expect(first?.value?.errorCode).toBe("tool_timeout");
    expect(result.output.status).not.toBe("completed");
  });

  test("output overflow: a deterministic over-limit executor yields a bounded typed result, no unbounded retry", async () => {
    const registry = buildRegistry(FAKE_READONLY_TOOL);
    const transcript = makeTranscript("t-overflow", [
      { toolCallId: "call-overflow", toolName: FAKE_READONLY_TOOL.toolId, input: { key: "huge" } },
    ]);
    const { provider } = fixtureProvider(transcript, "req-overflow");
    const spy = spyExecutor(makeBoundedExecutor("tool_output_overflow"));
    const deps = buildRunDeps({ provider, toolRegistry: registry, toolExecutor: spy.wrapped });

    const result: RunResult = await runOffline(buildInput(), buildConfig(), deps);

    // Bounded: exactly one attempt, no unbounded context-retry loop.
    expect(spy.calls.length).toBe(1);
    const first = spy.results[0];
    expect(first?.ok).toBe(true);
    expect(first?.value?.status).not.toBe("succeeded");
    expect(first?.value?.errorCode).toBe("tool_output_overflow");
    expect(result.output.status).not.toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// 4. Budget exhaustion (@SC_R12_BUDGET_EXHAUSTION).
// ---------------------------------------------------------------------------
describe("runOffline — stops at a hard budget boundary", () => {
  test("an exhausted tool-call budget persists budget_exceeded; no further provider or tool action starts", async () => {
    const registry = buildRegistry(FAKE_READONLY_TOOL);
    const transcript = makeTranscript("t-budget", [
      { toolCallId: "call-1", toolName: FAKE_READONLY_TOOL.toolId, input: { key: "a" } },
      { toolCallId: "call-2", toolName: FAKE_READONLY_TOOL.toolId, input: { key: "b" } },
    ]);
    const { provider } = fixtureProvider(transcript, "req-budget");
    const spy = spyExecutor(new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR }));
    const deps = buildRunDeps({ provider, toolRegistry: registry, toolExecutor: spy.wrapped });
    const input = buildInput({ budget: { maxSeconds: 60, maxToolCalls: 1, maxRetries: 1 } });

    const result: RunResult = await runOffline(input, buildConfig(), deps);

    // Only the first (budget-permitted) tool call executes; the second never
    // starts once the reservation is exhausted.
    expect(spy.calls.length).toBe(1);
    expect(["blocked", "failed"]).toContain(result.output.status);
    expect(result.output.unresolvedRisks ?? []).toContain("budget_exceeded");
  });
});

// ---------------------------------------------------------------------------
// 5. Loop detection (@SC_R12_LOOP_DETECTION).
// ---------------------------------------------------------------------------
describe("runOffline — stops a repeated ineffective loop", () => {
  test("the same normalized action repeated past threshold persists loop_detected with a bounded next action", async () => {
    const registry = buildRegistry(FAKE_READONLY_TOOL);
    const repeatCalls: RawToolCallSpec[] = Array.from({ length: 6 }, (_, index) => ({
      toolCallId: `call-loop-${index}`,
      toolName: FAKE_READONLY_TOOL.toolId,
      input: { key: "repeat" },
    }));
    const transcript = makeTranscript("t-loop", repeatCalls);
    const { provider } = fixtureProvider(transcript, "req-loop");
    const spy = spyExecutor(new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR }));
    const deps = buildRunDeps({ provider, toolRegistry: registry, toolExecutor: spy.wrapped });
    // A generous tool-call budget so budget exhaustion cannot be the reason
    // the run stops short — isolating loop detection as the cause.
    const input = buildInput({ budget: { maxSeconds: 60, maxToolCalls: 20, maxRetries: 1 } });

    const result: RunResult = await runOffline(input, buildConfig(), deps);

    expect(spy.calls.length).toBeGreaterThan(0);
    expect(spy.calls.length).toBeLessThan(repeatCalls.length);
    expect(result.output.unresolvedRisks ?? []).toContain("loop_detected");
    expect(result.output.status).not.toBe("completed");
  });
});

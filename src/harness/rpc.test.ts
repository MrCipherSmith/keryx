// RED tests for CLI + JSONL/RPC transport parity (flow 009, W7 / S5,
// task-R0-03).
//
// Pins the frozen scenarios from
// `docs/requirements/keryx-project-agent-harness/acceptance.feature`:
//   - @SC_R13_CLI_RPC_PARITY               "Preserve semantics across CLI and
//     JSONL RPC"
//   - @SC_R13_TRANSPORT_CANNOT_CHANGE_POLICY "Prevent a transport from
//     changing policy"
//
// Both `runViaCli` and `runViaRpc` are thin transports over the same
// `runOffline` assembly (S5); this suite proves they never diverge in
// semantics and that neither transport can upgrade an in-process `deny`.
// `encodeRpc`/`decodeRpc` round-trip a `RpcEnvelope` that validates against
// the frozen `rpc-jsonl-envelope.schema.json`.
//
// S5 impl (next dispatch) implements `src/harness/rpc.ts` (`RpcEnvelope`,
// `encodeRpc`, `decodeRpc`, `runViaRpc`) and `src/harness/run/cli.ts`
// (`runViaCli`) to make this suite GREEN; until then the missing-module
// imports are the expected RED failure.
//
// Deterministic + offline: no Date.now, no Math.random, no network, no real
// timers. Constraint: per the dispatch, only `src/harness/run/`,
// `src/harness/replay/`, and this file (`src/harness/rpc.test.ts`) may be
// added — CLI/RPC parity tests live here rather than in a separate
// `run/cli.test.ts`.
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../contracts/validator";
import type { HarnessConfig } from "./config";
import type { PolicyProfile } from "./policy/types";
import { FakeProvider, type FakeProviderTranscript, requestHashOf } from "./provider/fake-provider";
import type { NormalizedRequest, ProviderPort } from "./provider/types";
import { FAKE_READONLY_TOOL, FakeToolExecutor } from "./tool/fake-tool";
import { ToolRegistry } from "./tool/registry";
import type { ToolDefinition, ToolExecutorPort, ToolInvocation } from "./tool/types";
import type { HarnessRunInput } from "./types";

// PINNED API (see dispatch) — S5 impl exports these; imports fail until then
// (expected RED: "Cannot find module './rpc'" / "Cannot find module
// './run/cli'").
import { runViaCli } from "./run/cli";
import type { RunDeps } from "./run/run";
import { decodeRpc, encodeRpc, runViaRpc } from "./rpc";
import type { RpcEnvelope } from "./rpc";

// Frozen schemas dir, computed relative to this file
// (src/harness/ -> repo root).
const SCHEMA_DIR = path.join(
  import.meta.dir,
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

// A read-only-review profile (defaults.read = "allow", write = "deny" ->
// hard deny per engine.ts's HARD_DENY_RISKS), shaped exactly per
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

// A write-risk tool that must NEVER execute under `readOnlyProfile` (hard
// deny) — used only to prove the deny decision, never actually invoked.
const FAKE_WRITE_TOOL: ToolDefinition = {
  schemaVersion: 1,
  toolId: "fake.write",
  version: "0.1.0",
  description: "Deterministic write-risk fake tool; never invoked — proves hard-deny across transports.",
  inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
  outputSchema: { type: "object" },
  risk: "write",
  capabilities: ["write"],
  limits: { timeoutMs: 1_000, maxOutputBytes: 65_536, concurrencyKey: "fake.write" },
  replay: { deterministic: true, recordedResultSupported: false },
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

// Wraps the real `FakeProvider` so neither transport's internal request shape
// (unpinned) has to match the fixture's `requestHash` — see
// `run/run.test.ts`'s equivalent helper for the full rationale.
function fixtureProvider(transcript: FakeProviderTranscript, requestId: string): ProviderPort {
  const request = buildFixtureRequest(requestId);
  const stamped: FakeProviderTranscript = { ...transcript, requestHash: requestHashOf(request) };
  const fake = new FakeProvider([stamped]);
  return {
    describe: () => fake.describe(),
    stream: (_request, opts) => fake.stream(request, opts),
  };
}

function spyExecutor(executor: ToolExecutorPort): { wrapped: ToolExecutorPort; calls: ToolInvocation[] } {
  const calls: ToolInvocation[] = [];
  return {
    calls,
    wrapped: {
      invoke: async (invocation: ToolInvocation) => {
        calls.push(invocation);
        return executor.invoke(invocation);
      },
    },
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
// 1. `RpcEnvelope` round-trip + schema validity.
// ---------------------------------------------------------------------------
describe("encodeRpc / decodeRpc — JSONL envelope round-trip", () => {
  test("encodes to a single JSONL line, decodes back byte-identical, and validates against rpc-jsonl-envelope.schema.json", () => {
    const envelope: RpcEnvelope = {
      schemaVersion: 1,
      messageId: "msg-1",
      correlationId: "corr-1",
      kind: "response",
      payload: { hello: "world" },
    };

    const line = encodeRpc(envelope);
    expect(line.includes("\n")).toBe(false);

    const decoded = decodeRpc(line);
    expect(decoded).toEqual(envelope);

    const validation = validateAgainstSchema("rpc-jsonl-envelope.schema.json", envelope, { schemaDir: SCHEMA_DIR });
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. CLI vs JSONL/RPC parity (@SC_R13_CLI_RPC_PARITY).
// ---------------------------------------------------------------------------
describe("runViaCli vs runViaRpc — semantic parity", () => {
  test("the same request through CLI and JSONL/RPC yields semantically equivalent events, decisions, and gate output", async () => {
    const transcript = makeTranscript("t-parity", [
      { toolCallId: "call-1", toolName: FAKE_READONLY_TOOL.toolId, input: { key: "value" } },
    ]);
    const input = buildInput();
    const config = buildConfig();

    const cliRegistry = buildRegistry(FAKE_READONLY_TOOL);
    const cliDeps = buildRunDeps({
      provider: fixtureProvider(transcript, "req-parity"),
      toolRegistry: cliRegistry,
      toolExecutor: new FakeToolExecutor(cliRegistry, { schemaDir: SCHEMA_DIR }),
    });

    const rpcRegistry = buildRegistry(FAKE_READONLY_TOOL);
    const rpcDeps = buildRunDeps({
      provider: fixtureProvider(transcript, "req-parity"),
      toolRegistry: rpcRegistry,
      toolExecutor: new FakeToolExecutor(rpcRegistry, { schemaDir: SCHEMA_DIR }),
    });

    const cliResult = await runViaCli(input, config, cliDeps);
    const rpcResult = await runViaRpc(input, config, rpcDeps);

    expect(rpcResult.output).toEqual(cliResult.output);
    expect(rpcResult.decisions).toEqual(cliResult.decisions);
    expect(rpcResult.events).toEqual(cliResult.events);
  });
});

// ---------------------------------------------------------------------------
// 3. Transport cannot change policy (@SC_R13_TRANSPORT_CANNOT_CHANGE_POLICY).
// ---------------------------------------------------------------------------
describe("transport cannot upgrade a policy decision", () => {
  test("an in-process deny stays deny through JSONL/RPC; the write-risk tool is never invoked by either transport", async () => {
    const transcript = makeTranscript("t-deny", [
      { toolCallId: "call-write", toolName: FAKE_WRITE_TOOL.toolId, input: { path: "/etc/passwd" } },
    ]);
    const input = buildInput();
    const config = buildConfig();

    // Never actually executes — proves the hard deny, not the executor.
    const neverInvoke: ToolExecutorPort = {
      invoke: async () => {
        throw new Error("fake.write must never be invoked: policy must hard-deny it");
      },
    };

    const cliRegistry = buildRegistry(FAKE_WRITE_TOOL);
    const cliSpy = spyExecutor(neverInvoke);
    const cliDeps = buildRunDeps({
      provider: fixtureProvider(transcript, "req-deny"),
      toolRegistry: cliRegistry,
      toolExecutor: cliSpy.wrapped,
    });
    const cliResult = await runViaCli(input, config, cliDeps);

    const rpcRegistry = buildRegistry(FAKE_WRITE_TOOL);
    const rpcSpy = spyExecutor(neverInvoke);
    const rpcDeps = buildRunDeps({
      provider: fixtureProvider(transcript, "req-deny"),
      toolRegistry: rpcRegistry,
      toolExecutor: rpcSpy.wrapped,
    });
    const rpcResult = await runViaRpc(input, config, rpcDeps);

    type DecisionLike = { toolCallId: string; decision: string };
    expect(
      cliResult.decisions.some((d: DecisionLike) => d.toolCallId === "call-write" && d.decision === "deny"),
    ).toBe(true);
    expect(
      rpcResult.decisions.some((d: DecisionLike) => d.toolCallId === "call-write" && d.decision === "deny"),
    ).toBe(true);
    expect(
      rpcResult.decisions.some(
        (d: DecisionLike) => d.toolCallId === "call-write" && (d.decision === "allow" || d.decision === "ask"),
      ),
    ).toBe(false);
    expect(cliSpy.calls.length).toBe(0);
    expect(rpcSpy.calls.length).toBe(0);
  });
});

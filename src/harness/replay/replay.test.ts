// RED tests for effect-free offline replay (flow 009, W7 / S5, task-R0-03).
//
// Pins the frozen scenarios from
// `docs/requirements/keryx-project-agent-harness/acceptance.feature`:
//   - @SC_R12_REPLAY_MISMATCH        "Report an offline replay mismatch"
//   - @SC_R17_OFFLINE_REPLAY_MATCHES "Replay recorded state without effects"
//   - @SC_R17_NO_LIVE_EFFECT_ON_REPLAY "Reject a live effect during replay"
//   - @SC_R17_REPLAY_MISMATCH_REPORTED "Persist replay mismatch details"
//   - @SC_R14_OFFLINE_REPLAY         "Replay entirely offline"
//
// `replayOffline` is a pure, synchronous recomputation over a recorded
// `RunResult` and its `ReplayFixture` — it carries no `ProviderPort` /
// `ToolExecutorPort` dependency at all, so there is structurally nothing for
// it to invoke live. This suite additionally proves that at the *process*
// level: `fetch` is monkey-patched to throw if called, and the real
// `FakeProvider.stream` / `FakeToolExecutor.invoke` are spied to throw if
// called — replay must never reach either.
//
// S5 impl (next dispatch) implements `src/harness/replay/replay.ts`
// (`ReplayFixture`, `buildReplayFixture`, `ReplayOutcome`, `ReplayMismatch`,
// `replayOffline`) to make this suite GREEN; until then the missing-module
// import is the expected RED failure.
//
// Deterministic + offline: no Date.now, no Math.random, no real network or
// timers anywhere in this file outside the explicit monkey-patched `fetch`
// stub (which itself only ever throws — it is never expected to be called).
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";
import type { HarnessConfig } from "../config";
import type { PolicyProfile } from "../policy/types";
import { FakeProvider, type FakeProviderTranscript, requestHashOf } from "../provider/fake-provider";
import type { NormalizedRequest, ProviderPort } from "../provider/types";
import { runOffline } from "../run/run";
import type { RunDeps, RunResult } from "../run/run";
import { FAKE_READONLY_TOOL, FakeToolExecutor } from "../tool/fake-tool";
import { ToolRegistry } from "../tool/registry";
import type { ToolDefinition } from "../tool/types";
import type { HarnessRunInput } from "../types";

// PINNED API (see dispatch) — S5 impl exports these from "./replay"; imports
// fail until then (expected RED: "Cannot find module './replay'").
import { buildReplayFixture, replayOffline } from "./replay";
import type { ReplayFixture, ReplayOutcome } from "./replay";

// Frozen schemas dir, computed relative to this file
// (src/harness/replay/ -> repo root).
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

function fixtureProvider(transcript: FakeProviderTranscript, requestId: string): ProviderPort {
  const request = buildFixtureRequest(requestId);
  const stamped: FakeProviderTranscript = { ...transcript, requestHash: requestHashOf(request) };
  const fake = new FakeProvider([stamped]);
  return {
    describe: () => fake.describe(),
    stream: (_request, opts) => fake.stream(request, opts),
  };
}

// Builds one recorded, successful `RunResult` (a single allowed read-only
// tool call) to serve as the "recorded fake-provider run and hash-bound tool
// fixtures" every scenario below replays against.
async function buildSampleRun(): Promise<RunResult> {
  const registry = buildRegistry(FAKE_READONLY_TOOL);
  const transcript = makeTranscript("t-replay-sample", [
    { toolCallId: "call-1", toolName: FAKE_READONLY_TOOL.toolId, input: { key: "value" } },
  ]);
  const provider = fixtureProvider(transcript, "req-replay-sample");
  const executor = new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR });
  const { clock, idSeq } = makeDeps();
  const deps: RunDeps = {
    provider,
    toolRegistry: registry,
    toolExecutor: executor,
    policyProfile: readOnlyProfile,
    clock,
    idSeq,
    interactive: true,
  };
  return runOffline(buildInput(), buildConfig(), deps);
}

// ---------------------------------------------------------------------------
// 1. `buildReplayFixture` — deterministic, schema-valid fixture.
// ---------------------------------------------------------------------------
describe("buildReplayFixture — deterministic replay-fixture.schema.json-valid fixture", () => {
  test("validates against replay-fixture.schema.json, is not isolated-re-execute, and is byte-identical across builds of the same run", async () => {
    const run = await buildSampleRun();

    const fixtureA = buildReplayFixture(run, { idSeq: makeDeps().idSeq });
    const fixtureB = buildReplayFixture(run, { idSeq: makeDeps().idSeq });

    const validation = validateAgainstSchema("replay-fixture.schema.json", fixtureA, { schemaDir: SCHEMA_DIR });
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);

    expect(fixtureA.noSideEffects).toBe(true);
    // Release 0 never selects isolated re-execution (@SC_R17_ISOLATED_REEXECUTE_DEFERRED).
    expect(fixtureA.mode).not.toBe("isolated-re-execute");

    expect(fixtureB).toEqual(fixtureA);
  });
});

// ---------------------------------------------------------------------------
// 2. `replayOffline` — effect-free replay on a matching fixture
//    (@SC_R17_OFFLINE_REPLAY_MATCHES / @SC_R17_NO_LIVE_EFFECT_ON_REPLAY /
//    @SC_R14_OFFLINE_REPLAY).
// ---------------------------------------------------------------------------
describe("replayOffline — effect-free replay", () => {
  test("a matching fixture replays ok:true with no live provider, tool executor, or network call", async () => {
    const run = await buildSampleRun();
    const fixture = buildReplayFixture(run, { idSeq: makeDeps().idSeq });

    const originalFetch = globalThis.fetch;
    const fetchCalls: unknown[] = [];
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls.push(args);
      throw new Error("replayOffline must never call fetch");
    }) as unknown as typeof fetch;

    const providerSpy = spyOn(FakeProvider.prototype, "stream").mockImplementation((() => {
      throw new Error("replayOffline must never invoke a live provider");
    }) as unknown as FakeProvider["stream"]);
    const executorSpy = spyOn(FakeToolExecutor.prototype, "invoke").mockImplementation((async () => {
      throw new Error("replayOffline must never invoke a live tool executor");
    }) as unknown as FakeToolExecutor["invoke"]);

    let outcome: ReplayOutcome;
    try {
      outcome = replayOffline(fixture, run, { clock: () => "2026-01-01T00:00:00.000Z", idSeq: makeDeps().idSeq });
    } finally {
      globalThis.fetch = originalFetch;
      providerSpy.mockRestore();
      executorSpy.mockRestore();
    }

    expect(outcome.ok).toBe(true);
    expect(fetchCalls.length).toBe(0);
    expect(providerSpy).not.toHaveBeenCalled();
    expect(executorSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. `replayOffline` — typed mismatch on a changed hash
//    (@SC_R12_REPLAY_MISMATCH / @SC_R17_REPLAY_MISMATCH_REPORTED).
// ---------------------------------------------------------------------------
describe("replayOffline — typed replay mismatch", () => {
  test("a changed expectedStateHash reports ok:false with a mismatch validating against replay-mismatch.schema.json", async () => {
    const run = await buildSampleRun();
    const fixture = buildReplayFixture(run, { idSeq: makeDeps().idSeq });
    const tampered: ReplayFixture = { ...fixture, expectedStateHash: sha256("tampered-expected-state") };

    const outcome = replayOffline(tampered, run, {
      clock: () => "2026-01-01T00:00:00.000Z",
      idSeq: makeDeps().idSeq,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    const validation = validateAgainstSchema("replay-mismatch.schema.json", outcome.mismatch, {
      schemaDir: SCHEMA_DIR,
    });
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);

    expect(outcome.mismatch.fixtureId).toBe(tampered.fixtureId);
    expect(outcome.mismatch.expectedHash).not.toBe(outcome.mismatch.actualHash);
  });

  test("a changed transcriptHash also reports a typed mismatch, never a live fallback", async () => {
    const run = await buildSampleRun();
    const fixture = buildReplayFixture(run, { idSeq: makeDeps().idSeq });
    const tampered: ReplayFixture = { ...fixture, transcriptHash: sha256("tampered-transcript") };

    const outcome = replayOffline(tampered, run, {
      clock: () => "2026-01-01T00:00:00.000Z",
      idSeq: makeDeps().idSeq,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.mismatch.expectedHash).not.toBe(outcome.mismatch.actualHash);
  });
});

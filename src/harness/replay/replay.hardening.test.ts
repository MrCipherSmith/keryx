// Hardening/regression-lock suite for W7 effect-free offline replay (flow
// 017 W15 H-01, dispatch 017-T7, AC4 "replay"). Test-only: exercises the
// EXISTING `src/harness/replay/replay.ts` surface (`buildReplayFixture`,
// `replayOffline`) assembled over the EXISTING W5/W6/W7 offline run loop
// (`runOffline`, `FakeProvider`, `FakeToolExecutor`, `ToolRegistry`). No
// production code is edited or added here.
//
// `replay.test.ts` already proves a single replay is effect-free and that a
// mismatch is typed. This suite goes further per the frozen AC4 language
// ("replaying a recorded session is EFFECT-FREE: no new events appended, no
// tool/mutation invoked, deterministic (replay twice -> identical)"):
//   1. Replaying the SAME fixture/run TWICE in a row is effect-free on BOTH
//      calls (not just the first) -- no live provider/executor/fetch on
//      either replay -- and produces IDENTICAL outcomes (determinism).
//   2. The recorded `RunResult`'s `events`/`sessionEntries` are never
//      appended to or mutated by any number of replays (byte-identical
//      before/after N replays) -- replay carries no session/store handle at
//      all, so this is a structural, non-vacuous regression lock.
//   3. Even a MISMATCHING fixture never triggers a live effect: replay
//      always returns a typed mismatch, never a live fallback.
//
// Deterministic + offline: no Date.now/Math.random/real timers/network
// anywhere in this file outside the explicit monkey-patched `fetch` guard
// (which only ever throws -- it must never be called).
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
import { buildReplayFixture, replayOffline } from "./replay";
import type { ReplayFixture, ReplayOutcome } from "./replay";

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
    request: "run the hardening fixture scenario",
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
    systemInstruction: "hardening fixture system instruction",
    messages: [{ role: "user", content: "hardening fixture prompt" }],
    budget: { maxOutputTokens: 1000, runReservation: 1000 },
    stream: true,
    requestId,
    parentRunId: "run-hardening-fixture",
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

// One recorded, successful `RunResult` (a single allowed read-only tool
// call) replayed repeatedly by every hardening scenario below.
async function buildSampleRun(): Promise<RunResult> {
  const registry = buildRegistry(FAKE_READONLY_TOOL);
  const transcript = makeTranscript("t-replay-hardening-sample", [
    { toolCallId: "call-hardening-1", toolName: FAKE_READONLY_TOOL.toolId, input: { key: "hardening-value" } },
  ]);
  const provider = fixtureProvider(transcript, "req-replay-hardening-sample");
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
// 1. Replaying twice in a row is effect-free on BOTH calls and deterministic.
// ---------------------------------------------------------------------------
describe("replayOffline — replaying a matching fixture twice is effect-free on every call and deterministic", () => {
  test("two consecutive replays of the same fixture/run both report ok:true, invoke no live provider/executor/fetch, and are identical", async () => {
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

    let firstOutcome: ReplayOutcome;
    let secondOutcome: ReplayOutcome;
    try {
      firstOutcome = replayOffline(fixture, run, { clock: () => "2026-01-01T00:00:00.000Z", idSeq: makeDeps().idSeq });
      secondOutcome = replayOffline(fixture, run, { clock: () => "2026-01-01T00:00:00.000Z", idSeq: makeDeps().idSeq });
    } finally {
      globalThis.fetch = originalFetch;
      providerSpy.mockRestore();
      executorSpy.mockRestore();
    }

    expect(firstOutcome.ok).toBe(true);
    expect(secondOutcome.ok).toBe(true);
    // Deterministic: replaying twice with fresh-but-identical deps produces
    // an identical outcome.
    expect(secondOutcome).toEqual(firstOutcome);

    // Effect-free on BOTH calls, not only the first.
    expect(fetchCalls.length).toBe(0);
    expect(providerSpy).not.toHaveBeenCalled();
    expect(executorSpy).not.toHaveBeenCalled();
  });

  test("N repeated replays of the same fixture/run all report ok:true and never invoke a live effect", async () => {
    const run = await buildSampleRun();
    const fixture = buildReplayFixture(run, { idSeq: makeDeps().idSeq });

    const providerSpy = spyOn(FakeProvider.prototype, "stream").mockImplementation((() => {
      throw new Error("replayOffline must never invoke a live provider");
    }) as unknown as FakeProvider["stream"]);
    const executorSpy = spyOn(FakeToolExecutor.prototype, "invoke").mockImplementation((async () => {
      throw new Error("replayOffline must never invoke a live tool executor");
    }) as unknown as FakeToolExecutor["invoke"]);

    const REPEAT_COUNT = 5;
    const outcomes: ReplayOutcome[] = [];
    try {
      for (let i = 0; i < REPEAT_COUNT; i += 1) {
        outcomes.push(replayOffline(fixture, run, { clock: () => "2026-01-01T00:00:00.000Z", idSeq: makeDeps().idSeq }));
      }
    } finally {
      providerSpy.mockRestore();
      executorSpy.mockRestore();
    }

    expect(outcomes).toHaveLength(REPEAT_COUNT);
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(true);
    }
    expect(providerSpy).not.toHaveBeenCalled();
    expect(executorSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Replay never appends to or mutates the recorded run's events/entries.
// ---------------------------------------------------------------------------
describe("replayOffline — never appends to or mutates the recorded run (no new events, no growth)", () => {
  test("run.events and run.sessionEntries are byte-identical before and after multiple replays (replay carries no store/append handle at all)", async () => {
    const run = await buildSampleRun();
    const fixture = buildReplayFixture(run, { idSeq: makeDeps().idSeq });

    const eventsJsonBefore = JSON.stringify(run.events);
    const sessionEntriesJsonBefore = JSON.stringify(run.sessionEntries);
    const eventsCountBefore = run.events.length;
    const sessionEntriesCountBefore = run.sessionEntries.length;

    for (let i = 0; i < 3; i += 1) {
      const outcome = replayOffline(fixture, run, { clock: () => "2026-01-01T00:00:00.000Z", idSeq: makeDeps().idSeq });
      expect(outcome.ok).toBe(true);
    }

    // Bounded: no new events/entries were appended by any of the 3 replays.
    expect(run.events.length).toBe(eventsCountBefore);
    expect(run.sessionEntries.length).toBe(sessionEntriesCountBefore);
    expect(JSON.stringify(run.events)).toBe(eventsJsonBefore);
    expect(JSON.stringify(run.sessionEntries)).toBe(sessionEntriesJsonBefore);
  });

  test("building the same fixture repeatedly never grows or mutates the source run", async () => {
    const run = await buildSampleRun();
    const runJsonBefore = JSON.stringify(run);

    const fixtures: ReplayFixture[] = [];
    for (let i = 0; i < 3; i += 1) {
      fixtures.push(buildReplayFixture(run, { idSeq: makeDeps().idSeq }));
    }

    // Every independently-built fixture (fresh idSeq each time) is
    // byte-identical -- bounded, not accumulating state across calls.
    const [firstFixture] = fixtures;
    if (firstFixture === undefined) throw new Error("expected at least one built fixture");
    for (const fixture of fixtures) {
      expect(fixture).toEqual(firstFixture);
    }
    expect(JSON.stringify(run)).toBe(runJsonBefore);
  });
});

// ---------------------------------------------------------------------------
// 3. Even a mismatching fixture never triggers a live effect (no fallback).
// ---------------------------------------------------------------------------
describe("replayOffline — a mismatching fixture still never invokes a live effect (no live fallback on mismatch)", () => {
  test("a tampered fixture reports ok:false and invokes no live provider/executor/fetch", async () => {
    const run = await buildSampleRun();
    const fixture = buildReplayFixture(run, { idSeq: makeDeps().idSeq });
    const tampered: ReplayFixture = { ...fixture, expectedStateHash: sha256("hardening-tampered-expected-state") };

    const originalFetch = globalThis.fetch;
    const fetchCalls: unknown[] = [];
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls.push(args);
      throw new Error("replayOffline must never call fetch, even on a mismatch");
    }) as unknown as typeof fetch;

    const providerSpy = spyOn(FakeProvider.prototype, "stream").mockImplementation((() => {
      throw new Error("replayOffline must never invoke a live provider, even on a mismatch");
    }) as unknown as FakeProvider["stream"]);
    const executorSpy = spyOn(FakeToolExecutor.prototype, "invoke").mockImplementation((async () => {
      throw new Error("replayOffline must never invoke a live tool executor, even on a mismatch");
    }) as unknown as FakeToolExecutor["invoke"]);

    let outcome: ReplayOutcome;
    try {
      outcome = replayOffline(tampered, run, { clock: () => "2026-01-01T00:00:00.000Z", idSeq: makeDeps().idSeq });
    } finally {
      globalThis.fetch = originalFetch;
      providerSpy.mockRestore();
      executorSpy.mockRestore();
    }

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const validation = validateAgainstSchema("replay-mismatch.schema.json", outcome.mismatch, { schemaDir: SCHEMA_DIR });
    expect(validation.valid).toBe(true);
    expect(fetchCalls.length).toBe(0);
    expect(providerSpy).not.toHaveBeenCalled();
    expect(executorSpy).not.toHaveBeenCalled();
  });
});

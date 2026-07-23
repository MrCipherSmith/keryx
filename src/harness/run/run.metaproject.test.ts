// Flow 122 (S1 + MP-6): the OPTIONAL, default-OFF metaproject seam on the
// assembled offline run loop.
//
// AC1 (S1): `RunDeps` exposes an OPTIONAL `metaprojectPort?` that `runOffline`
// accepts and forwards; when it is undefined the run is byte-identical to a run
// built without the field (the deterministic floor is preserved).
// AC2 (MP-6): a policy decision call-site consults the existing pure
// `escalateForBlastRadius` primitive ONLY when the run supplies BOTH a
// `metaprojectPort` AND a positive `blastRadiusThreshold` — allow→ask when the
// affected count exceeds the threshold; decisions unchanged otherwise. No
// `Date.now`/`Math.random` (a fake, injected port drives the affected set).

import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { HarnessConfig } from "../config";
import { FakeProvider, type FakeProviderTranscript, requestHashOf } from "../provider/fake-provider";
import type { NormalizedRequest, ProviderPort } from "../provider/types";
import type { PolicyProfile } from "../policy/types";
import { FAKE_READONLY_TOOL, FakeToolExecutor } from "../tool/fake-tool";
import { ToolRegistry } from "../tool/registry";
import type { MetaprojectPort } from "../tool/metaproject-port";
import type { ToolDefinition, ToolExecutorPort } from "../tool/types";
import type { HarnessRunInput } from "../types";
import { runOffline } from "./run";
import type { RunDeps, RunResult } from "./run";

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
  return { clock: () => "2026-01-01T00:00:00.000Z", idSeq: () => `id-${counter++}` };
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

function makeTranscript(transcriptId: string, calls: RawToolCallSpec[], finalText = "Task complete."): FakeProviderTranscript {
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

/** Minimal port whose graphAffected returns `count` synthetic dependents. */
function fakePortWithBlastRadius(count: number, seen: string[] = []): MetaprojectPort {
  return {
    searchCode: async ({ pattern }) => ({ pattern, output: "", isError: false }),
    graphAffected: async ({ target }) => {
      seen.push(target);
      return {
        target,
        affected: Array.from({ length: count }, (_, i) => ({ id: `dep-${i}.ts`, path: `dep-${i}.ts`, hop: 1 })),
      };
    },
    graphQuery: async ({ query }) => (query === "orphans" ? { query, orphans: [] } : { query, cycles: [] }),
    memorySearch: async ({ query }) => ({ query, hits: [] }),
    readWiki: async ({ path }) => ({ path, content: "", isError: false }),
    describeContext: async () => ({ root: "/repo", graphNodes: 0, graphEdges: 0, hasWikiIndex: false }),
  };
}

function buildRunDeps(overrides: Partial<RunDeps> & { provider: ProviderPort; toolRegistry: ToolRegistry; toolExecutor: ToolExecutorPort }): RunDeps {
  const { clock, idSeq } = makeDeps();
  return {
    policyProfile: readOnlyProfile,
    clock,
    idSeq,
    interactive: true,
    ...overrides,
  };
}

// --- AC1: no port => byte-identical to a run without the field ---------------

describe("runOffline — S1 metaproject seam (AC1)", () => {
  const registry = buildRegistry(FAKE_READONLY_TOOL);
  const transcript = makeTranscript("t-s1", [
    { toolCallId: "call-1", toolName: FAKE_READONLY_TOOL.toolId, input: { key: "value", path: "src/a.ts" } },
  ]);

  function run(deps: Partial<RunDeps>): Promise<RunResult> {
    return runOffline(
      buildInput(),
      buildConfig(),
      buildRunDeps({
        provider: fixtureProvider(transcript, "req-s1"),
        toolRegistry: registry,
        toolExecutor: new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR }),
        ...deps,
      }),
    );
  }

  test("no port => the deterministic floor: only plain 'allow', no escalation, and stable across runs", async () => {
    const baseline = await run({});
    const again = await run({});
    // Determinism: the same inputs (with no metaproject fields) recompute an
    // identical terminal state.
    expect(again.expectedStateHash).toBe(baseline.expectedStateHash);
    // No escalation: the sole decision is a plain allow with no blast-radius rule.
    expect(baseline.decisions.every((d) => d.decision === "allow")).toBe(true);
    expect(baseline.decisions.some((d) => d.matchedRules.some((r) => r.includes("blast-radius")))).toBe(false);
  });

  test("a metaprojectPort present WITHOUT a threshold is inert — byte-identical to the no-port floor", async () => {
    const baseline = await run({});
    // A port whose blast radius would trip a threshold, but no threshold is set:
    // the run must be byte-identical to the no-port floor (the seam is default-OFF).
    const withPortOnly = await run({ metaprojectPort: fakePortWithBlastRadius(500) });
    expect(withPortOnly.expectedStateHash).toBe(baseline.expectedStateHash);
    expect(withPortOnly.decisions.map((d) => d.decision)).toEqual(baseline.decisions.map((d) => d.decision));
  });
});

// --- AC2: escalation only when BOTH port + positive threshold are supplied ----

describe("runOffline — MP-6 blast-radius escalation wiring (AC2)", () => {
  function runWith(deps: Partial<RunDeps>): Promise<RunResult> {
    const registry = buildRegistry(FAKE_READONLY_TOOL);
    const transcript = makeTranscript("t-mp6", [
      { toolCallId: "call-1", toolName: FAKE_READONLY_TOOL.toolId, input: { key: "value", path: "src/a.ts" } },
    ]);
    return runOffline(
      buildInput(),
      buildConfig(),
      buildRunDeps({
        provider: fixtureProvider(transcript, "req-mp6"),
        toolRegistry: registry,
        toolExecutor: new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR }),
        ...deps,
      }),
    );
  }

  test("(a) allow escalates to ask when the affected count exceeds the threshold", async () => {
    const result = await runWith({ metaprojectPort: fakePortWithBlastRadius(50), blastRadiusThreshold: 20 });
    const decision = result.decisions.find((d) => d.toolCallId === "call-1");
    expect(decision?.decision).toBe("ask");
    expect(decision?.matchedRules.some((r) => r.includes("metaproject:blast-radius>=20"))).toBe(true);
    // Escalated to ask => the executor is never reached (only in-process allow executes).
    expect(result.sessionEntries.some((e) => e.entry.type === "tool_result")).toBe(false);
  });

  test("(b) decisions unchanged when a port is supplied but no threshold is configured", async () => {
    const result = await runWith({ metaprojectPort: fakePortWithBlastRadius(50) });
    expect(result.decisions.find((d) => d.toolCallId === "call-1")?.decision).toBe("allow");
  });

  test("(b) decisions unchanged when a threshold is configured but no port is supplied", async () => {
    const result = await runWith({ blastRadiusThreshold: 1 });
    expect(result.decisions.find((d) => d.toolCallId === "call-1")?.decision).toBe("allow");
  });

  test("(b) allow stays allow when the affected count is below the threshold", async () => {
    const result = await runWith({ metaprojectPort: fakePortWithBlastRadius(5), blastRadiusThreshold: 20 });
    expect(result.decisions.find((d) => d.toolCallId === "call-1")?.decision).toBe("allow");
  });
});

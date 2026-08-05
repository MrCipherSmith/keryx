// Completion requirements threaded into the gate (flow 134, S3 / AC5).
//
// `runOffline` used to hand `evaluateCompletion` two hardcoded empty arrays,
// so two of the gate's three conditions could never bind: whatever a caller
// required, the gate required nothing. These tests pin the seam from the
// outside — same fixture run, three requirement sets, three verdicts:
//
//   1. no requirements          -> completed        (the pre-S3 behaviour)
//   2. an unmeetable evidence ref -> not completed, gate names it missing
//   3. the evidence ref the run actually records -> completed again
//   4. a required gate reporting `fail` -> not completed
//
// Case 3 exists so case 2 cannot be satisfied by a gate that simply refuses
// every requirement, and case 1 so the default stays permissive for an ad-hoc
// run with no flow behind it.
//
// Offline and deterministic by the same construction as `run.test.ts`: the
// real `FakeProvider` replays a fixture transcript, the clock is fixed and the
// id sequence is a fresh monotonic counter per run — which is what makes the
// evidence id in case 3 knowable in advance.
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { HarnessConfig } from "../config";
import { FakeProvider, type FakeProviderTranscript, requestHashOf } from "../provider/fake-provider";
import type { NormalizedRequest, ProviderPort } from "../provider/types";
import type { PolicyProfile } from "../policy/types";
import { FAKE_READONLY_TOOL, FakeToolExecutor } from "../tool/fake-tool";
import { ToolRegistry } from "../tool/registry";
import type { HarnessRunInput } from "../types";
import { runOffline } from "./run";
import type { CompletionRequirements, RunDeps, RunResult } from "./run";

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

const readOnlyProfile: PolicyProfile = {
  schemaVersion: 1,
  profileId: "read-only-review",
  profileVersion: "1.0.0",
  fingerprint: sha256("read-only-review:1.0.0"),
  trustMode: "read-only",
  defaults: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" },
  requiredControls: {
    isolation: "not-required",
    redactionFailure: "deny",
    networkBrokerFailure: "deny",
  },
};

function buildConfig(): HarnessConfig {
  return {
    schemaVersion: 1,
    enabled: true,
    defaultRole: "build",
    defaultProvider: "fake-provider",
    defaultModel: "fixture-model",
    policyProfile: "read-only-review",
    limits: {
      maxRunSeconds: 300,
      maxConcurrentChildren: 1,
      maxToolOutputBytes: 65_536,
      maxRetries: 1,
    },
  };
}

function buildInput(): HarnessRunInput {
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

/** One read-only tool call, then a final assistant message the gate can see. */
function makeTranscript(): FakeProviderTranscript {
  return {
    schemaVersion: 1,
    transcriptId: "t-completion-requirements",
    providerId: "fake-provider",
    providerRevision: "fake-1.0.0",
    requestHash: "0".repeat(64),
    events: [
      {
        sequence: 0,
        kind: "tool_call",
        payload: {
          toolName: FAKE_READONLY_TOOL.toolId,
          toolCallId: "call-1",
          input: { key: "value" },
        },
      },
      { sequence: 1, kind: "text_delta", payload: { text: "Task complete." } },
      { sequence: 2, kind: "finish", payload: {} },
    ],
  };
}

function fixtureProvider(): ProviderPort {
  const request = buildFixtureRequest("req-completion-requirements");
  const stamped: FakeProviderTranscript = {
    ...makeTranscript(),
    requestHash: requestHashOf(request),
  };
  const fake = new FakeProvider([stamped]);
  return {
    describe: () => fake.describe(),
    stream: (_request, opts) => fake.stream(request, opts),
  };
}

/**
 * One fixture run. Deps are rebuilt per call with a fresh id counter, so two
 * runs differing only in `completionRequirements` mint the same evidence ids.
 */
async function runWith(requirements?: CompletionRequirements): Promise<RunResult> {
  const registry = new ToolRegistry();
  registry.register(FAKE_READONLY_TOOL);
  let counter = 0;
  const deps: RunDeps = {
    provider: fixtureProvider(),
    toolRegistry: registry,
    toolExecutor: new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR }),
    policyProfile: readOnlyProfile,
    clock: () => "2026-01-01T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
    interactive: true,
    ...(requirements === undefined ? {} : { completionRequirements: requirements }),
  };
  return runOffline(buildInput(), buildConfig(), deps);
}

function evidenceCheck(result: RunResult) {
  return result.output.gate.checks.find((check) => check.checkId === "evidence:required-present");
}

describe("runOffline — caller-supplied completion requirements (flow 134, S3)", () => {
  test("no requirements: the run completes and the gate stands on no required evidence", async () => {
    const result = await runWith();

    expect(result.output.status).toBe("completed");
    expect(result.output.gate.status).toBe("pass");
    expect(evidenceCheck(result)?.status).toBe("pass");
  });

  test("a required evidence ref the run never records fails the gate and is named", async () => {
    const result = await runWith({ requiredEvidenceRefs: ["evidence:tests-1"] });

    expect(result.output.gate.status).not.toBe("pass");
    expect(result.output.status).not.toBe("completed");

    const check = evidenceCheck(result);
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("evidence:tests-1");
    // The unmet requirement is still carried on the verdict, so a reader sees
    // what was asked for and not only what was produced.
    expect(result.output.gate.evidenceRefs).toContain("evidence:tests-1");
  });

  test("a required evidence ref the run does record passes the gate", async () => {
    // Which id the tool result gets is an implementation detail, so read it
    // from an unconstrained run rather than hardcoding it — the deterministic
    // id sequence makes the second run mint the same one.
    const observed = await runWith();
    const recordedRef = observed.output.gate.evidenceRefs[0];
    expect(typeof recordedRef).toBe("string");

    const result = await runWith({ requiredEvidenceRefs: [recordedRef as string] });

    expect(evidenceCheck(result)?.status).toBe("pass");
    expect(result.output.gate.status).toBe("pass");
    expect(result.output.status).toBe("completed");
  });

  test("a required gate reporting fail blocks completion even with every blocker disposed", async () => {
    const result = await runWith({
      requiredGates: [{ name: "tests", status: "fail" }],
    });

    expect(result.output.gate.checks.find((c) => c.checkId === "gate:tests")?.status).toBe("fail");
    expect(result.output.gate.status).not.toBe("pass");
    expect(result.output.status).not.toBe("completed");
  });

  test("a required gate reporting pass leaves the run completing", async () => {
    const result = await runWith({
      requiredGates: [{ name: "tests", status: "pass" }],
    });

    expect(result.output.gate.checks.find((c) => c.checkId === "gate:tests")?.status).toBe("pass");
    expect(result.output.gate.status).toBe("pass");
    expect(result.output.status).toBe("completed");
  });
});

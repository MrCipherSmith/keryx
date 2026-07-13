// RED tests for the standalone Release 0 completion gate (flow 009, W7 / T11,
// sub-slice S4, task-R0-02).
//
// Pins the frozen completion-gate contract per
// `docs/requirements/keryx-project-agent-harness/acceptance.feature`:
//   - @SC_R10_EVIDENCE_FREE_COMPLETION_REJECTED "Reject evidence-free completion"
//   - @SC_R10_VERIFIED_COMPLETION                "Produce evidence-linked
//     verified completion"
//   - @SC_R10_UNDISPOSED_BLOCKER_REJECTED        "Reject completion with an
//     undisposed blocker"
//   - @SC_R16_EXACT_ESTIMATED_UNKNOWN_METRICS     "Preserve metric reliability"
//   - @SC_R16_UNRELIABLE_METRIC_NOT_TREATED_AS_EXACT "Reject fabricated exact
//     metrics"
// and `specification.md` §Completion Gates (required tasks terminal or
// dispositioned; blocker/major findings decided; final summary contains
// evidence references, not unsupported claims; gate result is a typed object
// persisted before run finalization).
//
// S4 impl (next dispatch) implements `src/harness/completion/gate.ts`
// (`evaluateCompletion`) and `src/harness/completion/metrics.ts`
// (`assessMetricsReliability`) to make this suite GREEN; until then the
// missing-module import is the expected RED failure.
//
// Deterministic: `deps.clock`/`deps.idSeq` are fixed per call, no
// `Date.now()`, `Math.random()`, or network. Every emitted
// `CompletionGateResult` is validated against the frozen
// `completion-gate-result.schema.json` / `harness-run-output.schema.json` via
// `validateAgainstSchema` (reused unchanged from `src/contracts/validator`).
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";

// PINNED API (see dispatch) — S4 impl exports these; imports fail until then
// (expected RED: "Cannot find module './gate'" / "Cannot find module
// './metrics'").
import { evaluateCompletion } from "./gate";
import type { CompletionGateResult, CompletionInput } from "./gate";
import { assessMetricsReliability } from "./metrics";
import type { MetricsRecord } from "./metrics";

// Local shape for `assessMetricsReliability`'s `flags` entries — annotated
// explicitly (rather than left to inference through the not-yet-existing
// module) so `tsc --noEmit` reports only the expected missing-module errors,
// not a downstream implicit-`any` on the callback parameter below.
interface MetricReliabilityFlag {
  metric: string;
  reason: string;
}

// Frozen schemas dir, computed relative to this file
// (src/harness/completion/ -> repo root).
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

// ---------------------------------------------------------------------------
// Deterministic deps: fixed clock, fixed id sequence. `makeDeps()` returns a
// *fresh* sequence starting from the same seed every call so two independent
// `evaluateCompletion` invocations over identical input are byte-identical
// (no shared mutable counter leaking state between tests). Mirrors
// `src/harness/policy/engine.test.ts` `makeDeps()`.
// ---------------------------------------------------------------------------
function makeDeps(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return {
    clock: () => "2026-01-01T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
  };
}

// ---------------------------------------------------------------------------
// API delta (see subagent-result "exact API S4 impl must export"):
//
// The dispatch's pinned sketch for `CompletionGateResult.checks` is
// `{ name: string; status: string; detail?: string }[]`. That shape cannot
// itself validate against the FROZEN `completion-gate-result.schema.json`,
// whose `checks` items REQUIRE `checkId`, `status`, `blocking`, and
// `evidenceRefs` (with an optional `detail`) — there is no `name` property and
// `additionalProperties` is `false`.
//
// The pinned sketch for `CompletionGateResult` also omits
// `unresolvedBlockerIds`, but the frozen schema defines it (optional) and its
// `allOf` conditional REQUIRES it to be empty whenever `status === "pass"`.
//
// Tests read the value `evaluateCompletion` returns through this locally
// widened "wire" view instead of widening the pinned `CompletionGateResult`
// type itself, so the pinned API contract stays exactly as dispatched. S4
// impl must emit the corrected `checks` item shape (and `unresolvedBlockerIds`
// when relevant) on the returned object for schema validity.
// ---------------------------------------------------------------------------
interface WireCompletionCheck {
  checkId: string;
  status: "pass" | "fail" | "skipped" | "unknown";
  blocking: boolean;
  evidenceRefs: string[];
  detail?: string;
}
type WireCompletionGateResult = Omit<CompletionGateResult, "checks"> & {
  checks: WireCompletionCheck[];
  unresolvedBlockerIds?: string[];
};

function asWireGate(gate: CompletionGateResult): WireCompletionGateResult {
  return gate as unknown as WireCompletionGateResult;
}

function assertValidGate(gate: CompletionGateResult): void {
  const result = validateAgainstSchema("completion-gate-result.schema.json", gate, {
    schemaDir: SCHEMA_DIR,
  });
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
}

// A fully-satisfied base input reused (and mutated per-scenario) across the
// verified-completion tests below.
function verifiedInput(runId: string): CompletionInput {
  return {
    runId,
    requiredGates: [
      { name: "tests", status: "pass" },
      { name: "health", status: "pass" },
      { name: "review", status: "pass" },
    ],
    requiredEvidenceRefs: ["evidence-tests-1", "evidence-health-1", "evidence-review-1"],
    presentEvidenceIds: ["evidence-tests-1", "evidence-health-1", "evidence-review-1"],
    undisposedBlockerIds: [],
    finalMessageEmitted: true,
  };
}

// --- 1. SC_R10_EVIDENCE_FREE_COMPLETION_REJECTED ----------------------------

describe("SC_R10_EVIDENCE_FREE_COMPLETION_REJECTED — reject evidence-free completion", () => {
  test("a final message alone with a missing required evidence ref does not produce gate status pass", () => {
    const input: CompletionInput = {
      runId: "run-evidence-free-1",
      requiredGates: [
        { name: "tests", status: "pass" },
        { name: "health", status: "pass" },
      ],
      requiredEvidenceRefs: ["evidence-tests-1", "evidence-health-1"],
      // evidence-health-1 was never recorded as present.
      presentEvidenceIds: ["evidence-tests-1"],
      undisposedBlockerIds: [],
      finalMessageEmitted: true,
    };

    const gate = evaluateCompletion(input, makeDeps());

    expect(gate.status).not.toBe("pass");
    expect(["fail", "blocked", "unknown"]).toContain(gate.status);
  });

  test("a required gate reporting fail also rejects completion even with a final message and all evidence present", () => {
    const input: CompletionInput = {
      runId: "run-evidence-free-2",
      requiredGates: [
        { name: "tests", status: "pass" },
        { name: "health", status: "fail" },
      ],
      requiredEvidenceRefs: ["evidence-1"],
      presentEvidenceIds: ["evidence-1"],
      undisposedBlockerIds: [],
      finalMessageEmitted: true,
    };

    const gate = evaluateCompletion(input, makeDeps());

    expect(gate.status).not.toBe("pass");
  });

  test("a skipped required gate also rejects completion (skipped is not pass)", () => {
    const input: CompletionInput = {
      runId: "run-evidence-free-3",
      requiredGates: [
        { name: "tests", status: "pass" },
        { name: "security", status: "skipped" },
      ],
      requiredEvidenceRefs: ["evidence-1"],
      presentEvidenceIds: ["evidence-1"],
      undisposedBlockerIds: [],
      finalMessageEmitted: true,
    };

    const gate = evaluateCompletion(input, makeDeps());

    expect(gate.status).not.toBe("pass");
  });

  test("no successful completion run-output can be assembled from a rejected gate result — harness-run-output.schema.json forbids status:'completed' unless gate.status is 'pass'", () => {
    const input: CompletionInput = {
      runId: "run-evidence-free-4",
      requiredGates: [{ name: "tests", status: "pass" }],
      requiredEvidenceRefs: ["evidence-tests-1", "evidence-missing-1"],
      presentEvidenceIds: ["evidence-tests-1"],
      undisposedBlockerIds: [],
      finalMessageEmitted: true,
    };

    const gate = evaluateCompletion(input, makeDeps());
    expect(gate.status).not.toBe("pass");

    // Attempt to claim a successful completion output anyway.
    const attemptedRunOutput = {
      schemaVersion: 1,
      runId: input.runId,
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:05:00.000Z",
      gate,
      artifacts: ["artifact-1"],
      metrics: { toolCalls: 1, modelRequests: 1, retries: 0 },
      unresolvedBlockerIds: [],
    };

    const result = validateAgainstSchema("harness-run-output.schema.json", attemptedRunOutput, {
      schemaDir: SCHEMA_DIR,
    });
    expect(result.valid).toBe(false);
  });
});

// --- 2. SC_R10_VERIFIED_COMPLETION -------------------------------------------

describe("SC_R10_VERIFIED_COMPLETION — produce evidence-linked verified completion", () => {
  test("all required gates pass + all required evidence present + no blocker -> gate status pass and schema-valid", () => {
    const input = verifiedInput("run-verified-1");
    const gate = evaluateCompletion(input, makeDeps());

    expect(gate.status).toBe("pass");
    expect(gate.runId).toBe("run-verified-1");
    expect(gate.evidenceRefs.length).toBeGreaterThan(0);
    for (const ref of input.requiredEvidenceRefs) {
      expect(gate.evidenceRefs).toContain(ref);
    }

    assertValidGate(gate);

    const wire = asWireGate(gate);
    expect(wire.checks.length).toBeGreaterThan(0);
    for (const check of wire.checks) {
      expect(check.status).toBe("pass");
    }
    if (wire.unresolvedBlockerIds !== undefined) {
      expect(wire.unresolvedBlockerIds).toHaveLength(0);
    }
  });

  test("produces an evidence-linked completed run-output that is schema-valid", () => {
    const input = verifiedInput("run-verified-2");
    const gate = evaluateCompletion(input, makeDeps());
    expect(gate.status).toBe("pass");

    const runOutput = {
      schemaVersion: 1,
      runId: input.runId,
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:05:00.000Z",
      gate,
      artifacts: gate.evidenceRefs,
      metrics: { toolCalls: 2, modelRequests: 2, retries: 0 },
      unresolvedBlockerIds: [],
    };

    const result = validateAgainstSchema("harness-run-output.schema.json", runOutput, {
      schemaDir: SCHEMA_DIR,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("deterministic: two evaluations of identical input with fresh identical deps produce byte-identical gate results", () => {
    const input = verifiedInput("run-verified-3");
    const first = evaluateCompletion(input, makeDeps());
    const second = evaluateCompletion(input, makeDeps());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

// --- 3. SC_R10_UNDISPOSED_BLOCKER_REJECTED -----------------------------------

describe("SC_R10_UNDISPOSED_BLOCKER_REJECTED — reject completion with an undisposed blocker", () => {
  test("an undisposed blocker id fails the gate even though the model emitted a final message and all gates/evidence otherwise pass", () => {
    const input: CompletionInput = {
      runId: "run-blocker-1",
      requiredGates: [{ name: "tests", status: "pass" }],
      requiredEvidenceRefs: ["evidence-1"],
      presentEvidenceIds: ["evidence-1"],
      undisposedBlockerIds: ["blocker-1"],
      finalMessageEmitted: true,
    };

    const gate = evaluateCompletion(input, makeDeps());

    expect(gate.status).not.toBe("pass");
    const wire = asWireGate(gate);
    if (wire.unresolvedBlockerIds !== undefined) {
      expect(wire.unresolvedBlockerIds).toContain("blocker-1");
    }
  });

  test("multiple undisposed blockers still reject completion (not just the first one found)", () => {
    const input: CompletionInput = {
      runId: "run-blocker-2",
      requiredGates: [{ name: "tests", status: "pass" }],
      requiredEvidenceRefs: ["evidence-1"],
      presentEvidenceIds: ["evidence-1"],
      undisposedBlockerIds: ["blocker-1", "blocker-2"],
      finalMessageEmitted: true,
    };

    const gate = evaluateCompletion(input, makeDeps());
    expect(gate.status).not.toBe("pass");
  });
});

// --- 4. Metric reliability (SC_R16_*) ----------------------------------------
//
// `assessMetricsReliability` is a small, deliberately standalone pure helper
// (see dispatch: "If this needs a small metrics helper, name it precisely for
// S4 impl") living alongside the completion gate because it backs the
// "metrics never fabricated" clause of the frozen AC4. It is NOT wired into
// `evaluateCompletion`'s pass/fail decision here (that decision is pinned to
// exactly: required gates pass + required evidence present + no undisposed
// blocker) — S4 impl decides whether/how to surface a reliability violation
// as an additional (non-required-gate) check.

describe("SC_R16_EXACT_ESTIMATED_UNKNOWN_METRICS — preserve metric reliability", () => {
  test("an exact reported value alongside an omitted value recorded as estimated/unknown with its source is reliable (not fabricated)", () => {
    const metrics: MetricsRecord = {
      toolCalls: { value: 4, reliability: "exact" },
      wallSeconds: { value: null, reliability: "estimated", source: "provider-omitted-usage" },
    };

    const result = assessMetricsReliability(metrics);

    expect(result.reliable).toBe(true);
    expect(result.flags).toEqual([]);
  });

  test("deterministic/pure: repeated calls over identical input produce identical results", () => {
    const metrics: MetricsRecord = { retries: { value: 0, reliability: "exact" } };
    const first = assessMetricsReliability(metrics);
    const second = assessMetricsReliability(metrics);
    expect(second).toEqual(first);
  });
});

describe("SC_R16_UNRELIABLE_METRIC_NOT_TREATED_AS_EXACT — reject fabricated exact metrics", () => {
  test("a metric claiming exact reliability with no reported value is flagged as fabricated", () => {
    const metrics: MetricsRecord = {
      inputTokens: { value: null, reliability: "exact" },
    };

    const result = assessMetricsReliability(metrics);

    expect(result.reliable).toBe(false);
    expect(result.flags.some((flag: MetricReliabilityFlag) => flag.metric === "inputTokens")).toBe(true);
  });

  test("an estimated/unknown value with no recorded source is also flagged (source must be recorded)", () => {
    const metrics: MetricsRecord = {
      outputTokens: { value: 10, reliability: "estimated" },
    };

    const result = assessMetricsReliability(metrics);

    expect(result.reliable).toBe(false);
    expect(result.flags.some((flag: MetricReliabilityFlag) => flag.metric === "outputTokens")).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateAgainstSchemaObject } from "../contracts/validator";
import { validateProbeTaskSet, validateProbePlan, validateProbeCheckpoint, validateProbeComparison } from "./probe-schema";

const dir = new URL("../../docs/requirements/keryx-learn-probe/examples/", import.meta.url);
const bundle = JSON.parse(readFileSync(new URL("artifact-bundle.json", dir), "utf8"));
const taskSet = JSON.parse(readFileSync(new URL("task-set.json", dir), "utf8"));
const cases = [
  ["task-set", taskSet, validateProbeTaskSet], ["plan", bundle.plan, validateProbePlan],
  ["checkpoint", bundle.checkpoint, validateProbeCheckpoint], ["comparison", bundle.comparison, validateProbeComparison],
] as const;
for (const [name, fixture, validate] of cases) {
  describe(name, () => {
    test("frozen example passes", () => { expect(validate(fixture)).toEqual({ ok: true, errors: [] }); });
    for (const value of [null, [], 1, "bad", {}]) {
      test(`reject root ${JSON.stringify(value)}`, () => { expect(validate(value).ok).toBe(false); });
    }
    test("reject unknown keys", () => { expect(validate({ ...fixture, unknown: 1 }).ok).toBe(false); });
    for (const key of Object.keys(fixture)) {
      test(`reject missing required example key ${key}`, () => {
        const value = structuredClone(fixture);
        delete value[key];
        expect(validate(value).ok).toBe(false);
      });
    }
  });
}
test("task IDs must be unique", () => {
  expect(validateProbeTaskSet({ ...taskSet, tasks: [taskSet.tasks[0], taskSet.tasks[0]] }).ok).toBe(false);
});
for (const unsafe of ["", "/tmp/x", "C:/x", "a\\b", "../x", "a/../x", "a\u0000b"]) {
  test(`unsafe path ${JSON.stringify(unsafe)}`, () => {
    const value = structuredClone(taskSet);
    value.tasks[0].goldArtifacts = [unsafe];
    expect(validateProbeTaskSet(value).ok).toBe(false);
    const comparison = structuredClone(bundle.comparison);
    comparison.runs[0].transcript = unsafe;
    expect(validateProbeComparison(comparison).ok).toBe(false);
  });
}
test("dry-run null budget permitted; persisted plan requires positive budget", () => {
  const plan = structuredClone(bundle.plan);
  plan.request.maxUsd = null;
  expect(validateProbePlan(plan).ok).toBe(true);
  expect(validateProbePlan(plan, { persisted: true }).ok).toBe(false);
});
for (const budget of [0, -1, NaN, Infinity]) {
  test(`invalid plan budget ${budget}`, () => {
    const plan = structuredClone(bundle.plan);
    plan.request.maxUsd = budget;
    expect(validateProbePlan(plan).ok).toBe(false);
  });
}
test("checkpoint links and unique arm/seed", () => {
  const value = structuredClone(bundle.checkpoint);
  value.seeds.push(value.seeds[0]);
  expect(validateProbeCheckpoint(value).ok).toBe(false);
  value.seeds.pop();
  value.seeds[0].planDigest = "b".repeat(64);
  expect(validateProbeCheckpoint(value).ok).toBe(false);
});
test("success requires answered in checkpoint and comparison", () => {
  const cp = structuredClone(bundle.checkpoint);
  cp.seeds[0].answered = false;
  expect(validateProbeCheckpoint(cp).ok).toBe(false);
  const cmp = structuredClone(bundle.comparison);
  cmp.runs[0].answered = false;
  expect(validateProbeComparison(cmp).ok).toBe(false);
});
for (const reason of ["no-task", "underpowered", "gold-leak", "environment-drift", "budget-exceeded", "run-failed"]) {
  test(`unmeasurable ${reason}`, () => {
    const cmp = { ...bundle.comparison, verdict: "unmeasurable", reason, arms: { base: null, probe: null }, delta: null, runs: [] };
    expect(validateProbeComparison(cmp).ok).toBe(true);
    expect(validateProbeComparison({ ...cmp, delta: bundle.comparison.delta }).ok).toBe(false);
  });
}
test("measured comparison requires complete pairs and consistent aggregates", () => {
  const cmp = structuredClone(bundle.comparison);
  cmp.runs.pop();
  expect(validateProbeComparison(cmp).ok).toBe(false);
  const wrong = structuredClone(bundle.comparison);
  wrong.arms.base.rate = 0.5;
  expect(validateProbeComparison(wrong).ok).toBe(false);
});

// Frozen schemas are an independent oracle for shape boundaries; runtime adds semantic checks.
for (const [name, fixture, validate] of cases) {
  const schema = JSON.parse(readFileSync(new URL(`../schemas/probe-${name}.schema.json`, dir), "utf8"));
  const options = { schemaDir: fileURLToPath(new URL("../schemas/", dir)) };
  test(`${name} runtime shape snapshot matches frozen schema`, () => {
    expect(validateAgainstSchemaObject(schema, fixture, options).valid).toBe(true);
    expect(validate(fixture).ok).toBe(true);
  });
  for (const version of [0, 2, "1", null]) {
    test(`${name} rejects schemaVersion ${version}`, () => {
      const value = { ...fixture, schemaVersion: version };
      expect(validateAgainstSchemaObject(schema, value, options).valid).toBe(false);
      expect(validate(value).ok).toBe(false);
    });
  }
}
function taskBoundary(label: string, patch: Record<string, unknown>, accepted: boolean) {
  test(label, () => {
    const value = structuredClone(taskSet);
    Object.assign(value.tasks[0], patch);
    expect(validateProbeTaskSet(value).ok).toBe(accepted);
  });
}
for (const length of [31, 32]) taskBoundary(`prompt length ${length}`, { prompt: "x".repeat(length) }, length === 32);
for (const id of ["a", "a".repeat(128), "a".repeat(129), "Bad", "a b", "../a"])
  taskBoundary(`task ID ${id}`, { id }, id === "a" || id.length === 128);
for (const goldArtifacts of [[], ["a", "a"], ["a"]])
  taskBoundary(`gold list ${JSON.stringify(goldArtifacts)}`, { goldArtifacts }, goldArtifacts.length === 1);
test("empty task-set rejected", () => {
  expect(validateProbeTaskSet({ ...taskSet, tasks: [] }).ok).toBe(false);
});
for (const field of ["trigger", "action"]) {
  for (const length of [7, 8, 400, 401]) {
    test(`snapshot ${field} length ${length}`, () => {
      const value = structuredClone(bundle.plan);
      value.snapshot[field] = "x".repeat(length);
      expect(validateProbePlan(value).ok).toBe(length >= 8 && length <= 400);
    });
  }
}
for (const [field, length] of [["probeId", 12], ["identityDigest", 64], ["patternDigest", 64]] as const) {
  for (const text of ["a".repeat(length - 1), "a".repeat(length + 1), "A".repeat(length)]) {
    test(`plan ${field} rejects ${text}`, () => {
      expect(validateProbePlan({ ...bundle.plan, [field]: text }).ok).toBe(false);
    });
  }
}
for (const length of [39, 40, 41, 63, 64, 65]) {
  test(`commit length ${length}`, () => {
    const value = structuredClone(bundle.plan);
    value.environment.commit = "a".repeat(length);
    expect(validateProbePlan(value).ok).toBe(length === 40 || length === 64);
  });
}
for (const date of ["2026-10-20T20:00:00Z", "not-a-date"]) {
  test(`plan date ${date}`, () => {
    expect(validateProbePlan({ ...bundle.plan, createdAt: date }).ok).toBe(date !== "not-a-date");
  });
}
test("fractional runs, seeds and counts rejected", () => {
  const plan = structuredClone(bundle.plan);
  plan.request.runs = 1.5;
  expect(validateProbePlan(plan).ok).toBe(false);
  const cp = structuredClone(bundle.checkpoint);
  cp.seeds[0].seed = 0.5;
  expect(validateProbeCheckpoint(cp).ok).toBe(false);
  const cmp = structuredClone(bundle.comparison);
  cmp.arms.base.successes = 0.5;
  expect(validateProbeComparison(cmp).ok).toBe(false);
});
for (const ci of [[0], [0, 0, 0], [0, null]]) {
  test(`CI needs exactly two numbers ${JSON.stringify(ci)}`, () => {
    const value = structuredClone(bundle.comparison);
    value.delta.ci = ci;
    expect(validateProbeComparison(value).ok).toBe(false);
  });
}
for (const field of ["tokens", "toolCalls"]) {
  test(`null optional telemetry ${field} is not unknown`, () => {
    const value = structuredClone(bundle.comparison);
    value.runs[0][field] = null;
    expect(validateProbeComparison(value).ok).toBe(false);
  });
}
for (const receipt of [
  { evidence: "applied" }, { evidence: "not-needed" }, { evidence: "skipped", reason: "environment-drift" },
]) {
  test(`finalization exact positive ${receipt.evidence}`, () => {
    expect(validateProbeCheckpoint({ ...bundle.checkpoint, finalization: receipt }).ok).toBe(true);
  });
}
for (const receipt of [
  null, { evidence: "skipped" }, { evidence: "skipped", reason: "run-failed" },
  { evidence: "applied", reason: "environment-drift" }, { evidence: "not-needed", reason: "environment-drift" },
  { evidence: "applied", extra: true },
]) {
  test(`finalization exact negative ${JSON.stringify(receipt)}`, () => {
    expect(validateProbeCheckpoint({ ...bundle.checkpoint, finalization: receipt }).ok).toBe(false);
  });
}
for (const phase of ["running", "comparison-written"]) {
  test(`receipt forbidden before finalized ${phase}`, () => {
    expect(validateProbeCheckpoint({ ...bundle.checkpoint, phase }).ok).toBe(false);
  });
}
test("finalized cannot retain top-level reservation", () => {
  expect(validateProbeCheckpoint({ ...bundle.checkpoint, reservedUsd: 0.1 }).ok).toBe(false);
});

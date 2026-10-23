import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPattern } from "../../learning/store";
import { buildProbePlan, hashProbeBytes, runProbeSession } from "../../learning/probe";
import type { LearnedPattern } from "../../learning/types";
import type { ProbeTask } from "../../learning/probe-schema";
import { executeProbe, probeInstructions, type ProbeRunnerPort } from "./runner";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });
const now = "2026-10-20T00:00:00.000Z";
const pattern: LearnedPattern = { schemaVersion: 1, id: "testing.runner", scope: "project", domain: "testing",
  trigger: "when testing a module", action: "cover the failure paths", status: "candidate",
  project: { identity: "a".repeat(64), identityKind: "remote-hash" }, confidence: 0.4,
  evidence: [{ kind: "reinforcement", sourceType: "test", sourceRef: "tests/original", observedAt: now }],
  redaction: { scanned: true, findings: [] }, provenance: { extractor: "test" },
  ttl: { expiresAt: "2027-01-01T00:00:00.000Z" }, createdAt: now, updatedAt: now };
const task: ProbeTask = { id: "task-one", kind: "deterministic", prompt: "Find the exported function that computes a Wilson interval.",
  expect: { file: "src/metrics/benchmark.ts", symbol: "wilsonInterval" }, goldArtifacts: ["answers.json"] };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "probe-runner-")); roots.push(root); await createPattern(root, pattern);
  const plan = buildProbePlan({ pattern, taskId: task.id, runs: 1, maxUsd: 1, estimateUsd: 0.2, createdAt: now,
    environment: { provider: "fixture", model: "fixture", commit: "a".repeat(40), baseRef: "main",
      taskSetDigest: hashProbeBytes("tasks"), baselineDigest: hashProbeBytes("baseline") } });
  let calls = 0; let cleanups = 0; let reconciles = 0;
  const port: ProbeRunnerPort = {
    reconcile: async () => { reconciles++; },
    prepare: async () => ({ goldClean: true, environmentMatches: true, roots: { base: "base-root", probe: "probe-root" } }),
    cleanup: async () => { cleanups++; },
    turn: async (input) => { calls++; const cp = JSON.parse(await readFile(path.join(root, input.checkpointPath), "utf8"));
      expect(cp.reservedUsd).toBeGreaterThan(0); expect(cp.seeds.at(-1).state).toBe("running");
      return { answer: "FILE: src/metrics/benchmark.ts SYMBOL: wilsonInterval", chargedUsd: 0.1, events: [{ type: "fixture" }] }; },
  };
  return { root, plan, port, counts: () => ({ calls, cleanups, reconciles }) };
}
test("same baseline; only probe receives immutable pattern block", () => {
  expect(probeInstructions("baseline", pattern, "base")).toBe("baseline");
  expect(probeInstructions("baseline", pattern, "probe")).toBe(`baseline\n<learned-pattern id="${pattern.id}">\nWhen ${pattern.trigger}, ${pattern.action}.\n</learned-pattern>`);
});
test("reserve before turn, score durable results, cleanup, no replay after comparison", async () => {
  const f = await fixture();
  const result = await runProbeSession(f.root, f.plan, (s) => executeProbe(s, task, f.port, { baseline: "baseline", reservationUsd: 0.2 }));
  expect(result.ok).toBe(true); expect(f.counts()).toEqual({ calls: 2, cleanups: 1, reconciles: 1 });
  if (result.ok) expect(result.value.comparison.verdict).toBe("indistinguishable");
});
for (const reason of ["gold-leak", "environment-drift"] as const) test(`${reason} before seeds`, async () => {
  const f = await fixture(); f.port.prepare = async () => ({ goldClean: reason !== "gold-leak", environmentMatches: reason !== "environment-drift", roots: { base: "a", probe: "b" } });
  const result = await runProbeSession(f.root, f.plan, (s) => executeProbe(s, task, f.port, { baseline: "baseline", reservationUsd: 0.2 }));
  expect(result.ok).toBe(true); if (result.ok) { expect(result.value.comparison.reason).toBe(reason); expect(result.value.comparison.runs).toEqual([]); }
  expect(f.counts().calls).toBe(0); expect(f.counts().cleanups).toBe(1);
});
test("unknown paid call is conservatively charged; never replayed", async () => {
  const f = await fixture(); await runProbeSession(f.root, f.plan, async (s) => { await s.reserve("base", 0, 0.2); });
  const result = await runProbeSession(f.root, f.plan, (s) => executeProbe(s, task, f.port, { baseline: "baseline", reservationUsd: 0.2 }));
  if (!result.ok) throw new Error(result.message);
  expect(result.value.comparison.reason).toBe("run-failed"); expect(f.counts().calls).toBe(0);
});
test("provider failure charges reservation and retains actual failed transcript", async () => {
  const f = await fixture(); f.port.turn = async () => { throw new Error("transport lost"); };
  const result = await runProbeSession(f.root, f.plan, (s) => executeProbe(s, task, f.port, { baseline: "baseline", reservationUsd: 0.2 }));
  if (!result.ok) throw new Error(result.message);
  expect(result.value.comparison.reason).toBe("run-failed"); expect(result.value.comparison.runs).toHaveLength(1);
  const text = await readFile(path.join(f.root, result.value.comparison.runs[0]!.transcript), "utf8");
  expect(text).toContain("probe-result"); expect(f.counts().cleanups).toBe(1);
});
test("actual overrun stops remaining seeds and wins over failure", async () => {
  const f = await fixture(); f.port.turn = async () => ({ answer: "", chargedUsd: 1.1, events: [] });
  const result = await runProbeSession(f.root, f.plan, (s) => executeProbe(s, task, f.port, { baseline: "baseline", reservationUsd: 0.2 }));
  if (!result.ok) throw new Error(result.message);
  expect(result.value.comparison.reason).toBe("budget-exceeded"); expect(result.value.comparison.runs).toHaveLength(1);
});
test("cleanup failure cannot become measured success", async () => {
  const f = await fixture(); f.port.cleanup = async () => { throw new Error("worktree busy"); };
  const result = await runProbeSession(f.root, f.plan, (s) => executeProbe(s, task, f.port, { baseline: "baseline", reservationUsd: 0.2 }));
  if (!result.ok) throw new Error(result.message);
  expect(result.value.comparison.reason).toBe("run-failed");
});
test("insufficient remaining budget never shrinks the conservative call reservation", async () => {
  const f = await fixture();
  const result = await runProbeSession(f.root, f.plan, (s) => executeProbe(s, task, f.port,
    { baseline: "baseline", reservationUsd: 1.1 }));
  if (!result.ok) throw new Error(result.message);
  expect(result.value.comparison.reason).toBe("budget-exceeded");
  expect(f.counts().calls).toBe(0);
  expect(result.value.comparison.runs).toEqual([]);
});

for (const answer of [
  "FILE: src/metrics/benchmark.ts SYMBOL: wilsoninterval",
  "FILE: src/Metrics/benchmark.ts SYMBOL: wilsonInterval",
]) test(`case-only incorrect answer fails: ${answer}`, async () => {
  const f = await fixture(); f.port.turn = async () => ({ answer, events: [] });
  const result = await runProbeSession(f.root, f.plan, s => executeProbe(s, task, f.port, { baseline: "baseline", reservationUsd: 0.2 }));
  if (!result.ok) throw new Error(result.message);
  expect(result.value.comparison.runs.every(run => run.answered && !run.success)).toBe(true);
});
test("leading dot slash remains supported", async () => {
  const f = await fixture(); f.port.turn = async () => ({ answer: "FILE: ./src/metrics/benchmark.ts SYMBOL: wilsonInterval", events: [] });
  const result = await runProbeSession(f.root, f.plan, s => executeProbe(s, task, f.port, { baseline: "baseline", reservationUsd: 0.2 }));
  if (!result.ok) throw new Error(result.message);
  expect(result.value.comparison.runs.every(run => run.success)).toBe(true);
});
// Synthetic detector fixture, not a real credential.
const fakeSecret = `ghp_${"aB9cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2"}`;
test("durable transcript redacts nested output, answers, keys and system messages", async () => {
  const f = await fixture();
  f.port.turn = async () => ({ answer: fakeSecret, events: [
    { type: "tool-result", name: "read_file", result: { output: `token=${fakeSecret}` } },
    { type: "system", message: fakeSecret }, { [fakeSecret]: "sensitive key" },
  ] });
  const result = await runProbeSession(f.root, f.plan, s => executeProbe(s, task, f.port, { baseline: "baseline", reservationUsd: 0.2 }));
  if (!result.ok) throw new Error(result.message);
  const text = await readFile(path.join(f.root, result.value.comparison.runs[0]!.transcript), "utf8");
  expect(text).not.toContain(fakeSecret);
  expect(text.trim().split("\n").map(line => JSON.parse(line))).toHaveLength(5);
});
test("durable error text is redacted and failed requests remain charged", async () => {
  const f = await fixture(); f.port.turn = async () => { throw new Error(fakeSecret); };
  const result = await runProbeSession(f.root, f.plan, async s => ({
    ...await executeProbe(s, task, f.port, { baseline: "baseline", reservationUsd: 0.2 }),
    checkpoint: s.checkpoint,
  }));
  if (!result.ok) throw new Error(result.message);
  expect(result.value.comparison.reason).toBe("run-failed");
  const run = result.value.comparison.runs[0]!;
  const text = await readFile(path.join(f.root, run.transcript), "utf8");
  expect(text).not.toContain(fakeSecret); expect(result.value.checkpoint.seeds[0]!.chargedUsd).toBe(0.2);
  expect(f.counts().cleanups).toBe(1);
});
import { readFileSync, readdirSync } from "node:fs";
import { resolvePointer } from "../../contracts/resolver";
test("probe refs resolve when schemas are registered only by canonical $id", () => {
  const directory = path.join(import.meta.dir, "../../../docs/requirements/keryx-learn-probe/schemas");
  const schemas = readdirSync(directory).filter(name => name.endsWith(".schema.json"))
    .map(name => JSON.parse(readFileSync(path.join(directory, name), "utf8")) as Record<string, unknown>);
  const registry = new Map(schemas.map(schema => [String(schema.$id), schema]));
  expect(registry.size).toBe(4);
  const visit = (node: unknown, owner: string) => {
    if (!node || typeof node !== "object") return;
    const object = node as Record<string, unknown>;
    const base = typeof object.$id === "string" ? new URL(object.$id, owner).href : owner;
    if (typeof object.$ref === "string") {
      const ref = new URL(object.$ref, base); const fragment = ref.hash.slice(1); ref.hash = "";
      const target = registry.get(ref.href);
      expect(target).toBeDefined();
      if (!target) throw new Error(`Unregistered schema identity: ${ref.href}`);
      expect(fragment ? resolvePointer(target, decodeURIComponent(fragment)) : target).toBeDefined();
    }
    for (const child of Object.values(object)) visit(child, base);
  };
  for (const schema of schemas) visit(schema, String(schema.$id));
});

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeContained } from "../lib/contained-write";
import { createPattern, readPattern, updatePattern } from "./store";
import { applyEvidence } from "./confidence";
import { buildProbePlan, hashProbeBytes, runProbeSession, retainProbeRuns } from "./probe";
import { scoreProbe } from "./probe-score";
import type { LearnedPattern } from "./types";
import type { ProbePlan } from "./probe-schema";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const now = "2026-10-20T00:00:00.000Z";
const pattern: LearnedPattern = { schemaVersion: 1, id: "testing.probe", scope: "project", domain: "testing",
  trigger: "when testing a module", action: "cover the failure paths", status: "candidate",
  project: { identity: "a".repeat(64), identityKind: "remote-hash" }, confidence: 0.4,
  evidence: [{ kind: "reinforcement", sourceType: "test", sourceRef: "tests/original", observedAt: now }], redaction: { scanned: true, findings: [] }, provenance: { extractor: "test" },
  ttl: { expiresAt: "2027-01-01T00:00:00.000Z" }, createdAt: now, updatedAt: now };
function plan(): ProbePlan { return buildProbePlan({ pattern, taskId: "task-one", runs: 3, maxUsd: 2,
  createdAt: now, estimateUsd: 0.1, environment: { provider: "fixture", model: "fixture-model", commit: "a".repeat(40),
  baseRef: "main", taskSetDigest: hashProbeBytes("exact task bytes\n"), baselineDigest: hashProbeBytes("baseline") } }); }
async function fixture() { const root = await mkdtemp(path.join(tmpdir(), "keryx-probe-")); roots.push(root);
  await createPattern(root, pattern); return { root, intent: plan() }; }
const noTask = scoreProbe({ taskKind: null, seeds: 3, goldClean: true, environmentMatches: true,
  budgetExceeded: false, arms: { base: { seeds: 0, successes: 0, answered: 0, failed: 0 }, probe: { seeds: 0, successes: 0, answered: 0, failed: 0 } } });
const improved = scoreProbe({ taskKind: "deterministic", seeds: 3, goldClean: true, environmentMatches: true,
  budgetExceeded: false, arms: { base: { seeds: 3, successes: 0, answered: 3, failed: 0 }, probe: { seeds: 3, successes: 3, answered: 3, failed: 0 } } });
async function measured(root: string, intent: ProbePlan, crashAt?: string) {
  return runProbeSession(root, intent, async (s) => {
    if (!s.comparison) {
      for (const arm of ["base", "probe"] as const) for (let seed = 0; seed < 3; seed++) {
        if (s.checkpoint.seeds.some((v) => v.arm === arm && v.seed === seed)) continue;
        await s.reserve(arm, seed, 0.1);
        await writeContained(root, s.transcriptPath(arm, seed), JSON.stringify({ type: "probe-result", answered: true, success: arm === "probe" }) + "\n");
        await s.complete(arm, seed, { answered: true, success: arm === "probe", chargedUsd: 0.05 });
      }
      await s.publish(improved);
    }
    return s.finalize();
  }, { afterWrite: async (boundary) => { if (boundary === crashAt) throw new Error(`crash:${boundary}`); } });
}
test("identity uses exact eight NUL-separated inputs and trigger/action JSON", () => {
  const p = plan();
  expect(p.patternDigest).toBe(createHash("sha256").update(JSON.stringify([pattern.trigger, pattern.action])).digest("hex"));
  expect(p.identityDigest).toBe(createHash("sha256").update([p.patternId, p.patternDigest, p.taskId, p.environment.model,
    p.environment.provider, p.environment.commit, p.environment.taskSetDigest, "3"].join("\0")).digest("hex"));
  expect(p.probeId).toBe(p.identityDigest.slice(0, 12));
  expect(hashProbeBytes("x\n")).not.toBe(hashProbeBytes("x"));
  expect(() => buildProbePlan({ pattern, taskId: "bad\0task", runs: 3, maxUsd: 1, environment: p.environment, createdAt: now, estimateUsd: null })).toThrow();
});
test("no-task finalizes without record changes; rerun refuses", async () => {
  const { root, intent } = await fixture();
  const before = await readPattern(root, pattern.id, "project");
  expect((await runProbeSession(root, intent, async (s) => { await s.publish(noTask); return s.finalize(); })).ok).toBe(true);
  expect(await runProbeSession(root, intent, async () => undefined)).toMatchObject({ ok: false, reason: "probe-already-completed" });
  expect(await readPattern(root, pattern.id, "project")).toEqual(before);
});
for (const boundary of ["plan", "checkpoint", "comparison", "finalizing", "record", "marker"]) {
  test(`crash after ${boundary}: recover once; immutable comparison`, async () => {
    const { root, intent } = await fixture();
    expect((await measured(root, intent, boundary)).ok).toBe(false);
    const file = path.join(root, `.metaproject/data/learning/probes/${intent.patternId}/${intent.probeId}/comparison.json`);
    const published = await readFile(file, "utf8").catch(() => null);
    const second = await measured(root, intent);
    if (boundary === "marker") expect(second).toMatchObject({ ok: false, reason: "probe-already-completed" });
    else expect(second.ok).toBe(true);
    if (published) expect(await readFile(file, "utf8")).toBe(published);
    const current = await readPattern(root, pattern.id, "project");
    expect(current?.evidence.filter((e) => e.sourceType === "probe")).toHaveLength(1);
    expect(current?.confidence).toBe(applyEvidence(0.4, "reinforcement", 1));
  });
}
test("concurrent invocations preserve unrelated record changes", async () => {
  const { root, intent } = await fixture();
  await updatePattern(root, pattern.id, "project", (p) => ({ ...p, confidence: 0.5,
    evidence: [{ kind: "reinforcement", sourceType: "test", sourceRef: "tests/unrelated", observedAt: now }] }));
  expect((await Promise.all([measured(root, intent), measured(root, intent)])).filter((r) => r.ok)).toHaveLength(1);
  const current = await readPattern(root, pattern.id, "project");
  expect(current?.evidence).toHaveLength(2); expect(current?.confidence).toBe(applyEvidence(0.5, "reinforcement", 1));
});
test("receipt dedup precedes post-commit drift", async () => {
  const { root, intent } = await fixture(); await measured(root, intent, "record");
  await updatePattern(root, pattern.id, "project", (p) => {
    const next = { ...p, status: "rejected" as const, trigger: "different trigger text" };
    delete next.ttl; return next;
  });
  expect(await measured(root, intent)).toMatchObject({ ok: true, value: { evidence: "applied" } });
  expect((await readPattern(root, pattern.id, "project"))?.evidence.filter((e) => e.sourceType === "probe")).toHaveLength(1);
});
test("post-publication drift skips; pre-publication drift overrides score", async () => {
  const { root, intent } = await fixture(); await measured(root, intent, "comparison");
  await updatePattern(root, pattern.id, "project", (p) => ({ ...p, trigger: "changed after publication" }));
  expect(await measured(root, intent)).toMatchObject({ ok: true, value: { evidence: "skipped", reason: "environment-drift" } });
  expect((await readPattern(root, pattern.id, "project"))?.confidence).toBe(0.4);
  const other = await fixture();
  expect((await runProbeSession(other.root, other.intent, async (s) => {
    await updatePattern(other.root, pattern.id, "project", (p) => ({ ...p, action: "changed before publication" }));
    await s.publish(noTask); expect(s.comparison).toMatchObject({ verdict: "unmeasurable", reason: "environment-drift", delta: null });
    return s.finalize();
  })).ok).toBe(true);
});
test("request/baseline mismatch refuses unchanged; running reservation charged not replayed", async () => {
  const { root, intent } = await fixture();
  await runProbeSession(root, intent, async (s) => { await s.reserve("base", 0, 0.25); });
  const file = path.join(root, `.metaproject/data/learning/probes/${intent.patternId}/${intent.probeId}/checkpoint.json`);
  const before = await readFile(file, "utf8");
  for (const altered of [{ ...intent, request: { ...intent.request, maxUsd: 3 } },
    { ...intent, environment: { ...intent.environment, baselineDigest: "b".repeat(64) } }]) {
    expect(await runProbeSession(root, altered, async () => undefined)).toMatchObject({ ok: false, reason: "probe-environment-mismatch" });
    expect(await readFile(file, "utf8")).toBe(before);
  }
  expect((await runProbeSession(root, intent, async (s) => {
    expect(s.checkpoint.spendUsd).toBe(0.25); expect(s.checkpoint.reservedUsd).toBe(0);
    expect(s.checkpoint.seeds[0]).toMatchObject({ state: "failed", chargedUsd: 0.25, reservedUsd: 0 });
    await expect(s.reserve("base", 0, 0.25)).rejects.toThrow();
  })).ok).toBe(true);
});

test("malformed checkpoint refuses unchanged", async () => {
  const { root, intent } = await fixture();
  await runProbeSession(root, intent, async () => undefined);
  const rel = `.metaproject/data/learning/probes/${intent.patternId}/${intent.probeId}/checkpoint.json`;
  await writeContained(root, rel, "{broken");
  expect(await runProbeSession(root, intent, async () => undefined)).toMatchObject({ ok: false, reason: "probe-environment-mismatch" });
  expect(await readFile(path.join(root, rel), "utf8")).toBe("{broken");
});
test("comparison recovery validates runs against checkpoint before writes", async () => {
  const { root, intent } = await fixture(); await measured(root, intent, "comparison");
  const dir = `.metaproject/data/learning/probes/${intent.patternId}/${intent.probeId}`;
  const cp = await readFile(path.join(root, dir, "checkpoint.json"), "utf8");
  const c = JSON.parse(await readFile(path.join(root, dir, "comparison.json"), "utf8"));
  c.runs[0].transcript = "unrelated.ndjson";
  await writeContained(root, `${dir}/comparison.json`, JSON.stringify(c));
  expect(await measured(root, intent)).toMatchObject({ ok: false, reason: "probe-environment-mismatch" });
  expect(await readFile(path.join(root, dir, "checkpoint.json"), "utf8")).toBe(cp);
});
test("escaping probe root symlink refuses before lock creation", async () => {
  const { root, intent } = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), "keryx-probe-outside-")); roots.push(outside);
  await symlink(outside, path.join(root, ".metaproject/data/learning/probes"));
  expect((await runProbeSession(root, intent, async () => undefined)).ok).toBe(false);
  expect(await readFile(path.join(outside, intent.patternId, intent.probeId, "plan.json"), "utf8").catch(() => null)).toBeNull();
});
test("retention removes only finalized runs, preserving immutable audit JSON", async () => {
  const { root, intent } = await fixture(); await measured(root, intent);
  const dir = `.metaproject/data/learning/probes/${intent.patternId}/${intent.probeId}`;
  const before = await readFile(path.join(root, dir, "comparison.json"), "utf8");
  expect(await retainProbeRuns(root, intent.patternId, 0)).toEqual([intent.probeId]);
  expect(await readFile(path.join(root, dir, "comparison.json"), "utf8")).toBe(before);
  expect(await readFile(path.join(root, dir, "runs/base/0.ndjson"), "utf8").catch(() => null)).toBeNull();
  expect(await runProbeSession(root, intent, async () => undefined)).toMatchObject({ ok: false, reason: "probe-already-completed" });
  expect(await retainProbeRuns(root, intent.patternId, 0)).toEqual([]);
});
test("retention skips pending and locked finalized probes", async () => {
  const { root, intent } = await fixture(); await measured(root, intent, "comparison");
  expect(await retainProbeRuns(root, intent.patternId, 0)).toEqual([]);
  await measured(root, intent);
  const { withFileLock } = await import("../lib/fs");
  await withFileLock(path.join(root, `.metaproject/data/learning/probes/${intent.patternId}/${intent.probeId}/probe.lock`), async () => {
    expect(await retainProbeRuns(root, intent.patternId, 0)).toEqual([]);
  });
});

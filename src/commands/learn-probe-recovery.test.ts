import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildProbePlan, hashProbeBytes, runProbeSession } from "../learning/probe";
import { updatePattern, writePattern } from "../learning/store";
import type { LearnedPattern } from "../learning/types";
import { PROBE_BASELINE, runLearnProbe } from "./learn-probe";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
 const root = await mkdtemp(path.join(tmpdir(), "probe-cli-recovery-")); roots.push(root);
 const pattern: LearnedPattern = { schemaVersion: 1, id: "testing.probe-12345678", scope: "project", domain: "testing",
 project: { identity: "a".repeat(64), identityKind: "remote-hash" }, trigger: "find a function", action: "read definition",
 status: "candidate", confidence: 0.4, confidenceLevel: "low", supersededBy: null, evidence: [{ kind: "reinforcement", sourceType: "observation", sourceRef: "fixture.jsonl", observedAt: "2026-10-20T00:00:00.000Z", weight: 1 }], reviewerProfile: null, ttl: { expiresAt: "2027-01-01T00:00:00.000Z" },
 redaction: { scanned: true, findings: [] }, graduation: null, provenance: { extractor: "repeated-correction", extractorKind: "deterministic" },
 createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z" };
 await writePattern(root, pattern);
 const bytes = JSON.stringify({ schemaVersion: 1, tasks: [{ id: "other", kind: "deterministic", prompt: "Find the function implementation in this repository.", expect: { file: "a.ts", symbol: "f" }, goldArtifacts: ["gold.json"] }] });
 await writeFile(path.join(root, "tasks.json"), bytes);
 const commit = "a".repeat(40);
 const plan = buildProbePlan({ pattern, taskId: "missing", runs: 1, maxUsd: 1, estimateUsd: null, createdAt: pattern.createdAt,
 environment: { provider: "fake", model: "fake", commit, baseRef: "HEAD", taskSetDigest: hashProbeBytes(bytes),
 baselineDigest: hashProbeBytes(JSON.stringify([PROBE_BASELINE, ["get_cwd", "list_dir", "read_file"], "probe-score-v1"])) } });
 const output: string[] = [];
 const deps = { root, commit, provider: "fake", model: "fake", isTerminal: true, readLine: async () => pattern.id,
 stdout: (v: string) => output.push(v), stderr: (_v: string) => {} };
 const args = [pattern.id, "--task", "missing", "--task-set", "tasks.json", "--runs", "1", "--max-usd", "1", "--json"];
 return { root, pattern, plan, output, deps, args };
}
test("published comparison recovers original identity after status/action drift", async () => {
 const f = await fixture();
 const interrupted = await runProbeSession(f.root, f.plan, async s => { await s.publish({ verdict: "unmeasurable", reason: "no-task", arms: { base: null, probe: null }, delta: null }); },
 { afterWrite: async boundary => { if (boundary === "comparison") throw new Error("crash"); } });
 expect(interrupted.ok).toBe(false);
 await updatePattern(f.root, f.pattern.id, "project", p => { const { ttl, ...rest } = p; void ttl; return { ...rest, status: "rejected", action: "changed action" }; });
 expect(await runLearnProbe(f.args, f.deps)).toBe(3);
 expect(JSON.parse(f.output.at(-1)!).comparison.probeId).toBe(f.plan.probeId);
 expect(await readdir(path.join(f.root, ".metaproject/data/learning/probes", f.pattern.id))).toEqual([f.plan.probeId]);
 expect(await runLearnProbe(f.args, f.deps)).toBe(2);
 expect(JSON.parse(f.output.at(-1)!).refusal).toBe("probe-already-completed");
});
test("dry-run, no-TTY and confirmation mismatch do not create probe storage", async () => {
 const f = await fixture();
 expect(await runLearnProbe([...f.args, "--dry-run"], { ...f.deps, isTerminal: false })).toBe(0);
 expect(await runLearnProbe(f.args, { ...f.deps, isTerminal: false })).toBe(2);
 expect(await runLearnProbe(f.args, { ...f.deps, readLine: async () => "yes" })).toBe(2);
 expect(await readdir(path.join(f.root, ".metaproject/data/learning"))).not.toContain("probes");
});

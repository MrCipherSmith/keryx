import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadAgentCatalog } from "../../agents/catalog";
import type { ReviewAgentAdapter, ReviewAgentAdapterRequest, ReviewAgentRegisteredPlan } from "../../review/agents/types";
import { captureRunInputs, loadRunInputs, bindSnapshotAdapter } from "./input-snapshot";
const revision = "a".repeat(40);
const plan = { revision, planHash: "b".repeat(64), planVersion: 1, registeredAt: "now", waves: {}, assignments: { task: { taskId: "task", entity: "review-worker", role: "worker", scopeIds: ["src/a.ts"], coverage: [{ scopeId: "src/a.ts", aspect: "logic" }] } } } satisfies ReviewAgentRegisteredPlan;
const request = { runId: "run", dispatchId: "dispatch", taskId: "task", task: "Inspect source", attempt: 1, revision, entity: "review-worker", role: "worker", scopeIds: ["src/a.ts"], depth: 0, planHash: plan.planHash, planVersion: 1, signal: new AbortController().signal, limits: { elapsedMs: 1000, modelRoundsDefault: 1, modelRoundsMax: 1, toolCallsMax: 10, maxChildLaunches: 0 } } as ReviewAgentAdapterRequest;
async function fixture(work: (directory: string) => Promise<void>) {
 const directory = await mkdtemp(path.join(os.tmpdir(), "review-inputs-"));
 try { await mkdir(path.join(directory, "source", "src"), { recursive: true }); await writeFile(path.join(directory, "source", "src", "a.ts"), "original"); await work(directory); }
 finally { await rm(directory, { recursive: true, force: true }); }
}
async function captured(directory: string) {
 const result = await captureRunInputs(directory, revision, loadAgentCatalog(process.cwd()), async (skill) => `original skill ${skill}`);
 if (!result.ok) throw result.error;
 return result.value;
}
const fake = (execute: ReviewAgentAdapter["execute"]): ReviewAgentAdapter => ({ id: "test", capabilities: { readOnlyEnforced: true, resultPersistence: true, hierarchy: true, cancellation: true, usageAccounting: false }, execute, async cancel() {} });
test("pins catalog and skill bytes and reloads without consulting live inputs", async () => fixture(async (dir) => {
 const snapshot = await captured(dir); const loaded = await loadRunInputs(dir);
 expect(loaded.ok).toBe(true); if (!loaded.ok) throw loaded.error;
 expect(loaded.value).toEqual(snapshot); expect(Object.values(snapshot.skills).every((text) => text.startsWith("original skill"))).toBe(true);
}));
test("native and external receive the same durable plan-bound packet", async () => fixture(async (dir) => {
 const snapshot = await captured(dir); const seen: string[] = [];
 for (const id of ["native", "external"]) {
  const adapter = { ...fake(async (input) => { seen.push(input.task); return { content: "ok" }; }), id };
  const output = await bindSnapshotAdapter(adapter, dir, snapshot, async () => structuredClone(plan)).execute(request, {} as never);
  expect(output.metadata?.inputSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
 }
 expect(seen[0]).toEqual(seen[1]); expect(seen[0]).toContain(snapshot.digest); expect(seen[0]).toContain('"coverage"');
 expect(await readFile(path.join(dir, "inputs", "dispatch.json"), "utf8")).toContain(snapshot.digest);
}));
test("changed source fails before adapter invocation", async () => fixture(async (dir) => {
 const snapshot = await captured(dir); await writeFile(path.join(dir, "source", "src", "a.ts"), "changed"); let calls = 0;
 const adapter = fake(async () => { calls++; return { content: "ok" }; });
 await expect(bindSnapshotAdapter(adapter, dir, snapshot, async () => plan).execute(request, {} as never)).rejects.toThrow("source"); expect(calls).toBe(0);
}));
test("plan/scope mismatch and changed dispatch packets fail closed", async () => fixture(async (dir) => {
 const snapshot = await captured(dir); const bound = bindSnapshotAdapter(fake(async () => ({ content: "ok" })), dir, snapshot, async () => plan);
 await expect(bound.execute({ ...request, planHash: "wrong" }, {} as never)).rejects.toThrow("plan");
 await expect(bound.execute({ ...request, scopeIds: ["other"] }, {} as never)).rejects.toThrow("scope");
 await bound.execute(request, {} as never);
 await expect(bound.execute({ ...request, task: "different" }, {} as never)).rejects.toThrow("packet");
}));
test("missing and corrupt snapshots fail on reopen", async () => fixture(async (dir) => {
 expect((await loadRunInputs(dir)).ok).toBe(false); await captured(dir);
 await writeFile(path.join(dir, "input-snapshot.json"), '{"schemaVersion":1}'); expect((await loadRunInputs(dir)).ok).toBe(false);
}));
test("symlinks cannot import external source", async () => fixture(async (dir) => {
 await symlink(os.tmpdir(), path.join(dir, "source", "escape"));
 expect((await captureRunInputs(dir, revision, loadAgentCatalog(process.cwd()), async () => "skill")).ok).toBe(false);
}));

test("captured inputs do not track later catalog or skill edits", async () => fixture(async (dir) => {
 const loadedCatalog = loadAgentCatalog(process.cwd());
 const catalog = { ...loadedCatalog, agents: [...loadedCatalog.agents] }; let liveSkill = "pinned skill";
 const result = await captureRunInputs(dir, revision, catalog, async () => liveSkill);
 expect(result.ok).toBe(true); if (!result.ok) throw result.error;
 const original = structuredClone(result.value);
 catalog.agents.length = 0; liveSkill = "changed skill";
 const loaded = await loadRunInputs(dir);
 expect(loaded.ok).toBe(true); if (!loaded.ok) throw loaded.error;
 expect(loaded.value).toEqual(original);
 expect(loaded.value.catalog.agents.length).toBeGreaterThan(0);
 expect(Object.keys(loaded.value.skills).length).toBeGreaterThan(0);
 expect(Object.values(loaded.value.skills).every((text) => text === "pinned skill")).toBe(true);
}));

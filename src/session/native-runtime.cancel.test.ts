import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeSessionRuntime, NATIVE_KILL_GRACE_MS } from "./native-runtime";
import { scriptedProvider, okReply } from "../commands/agent.test-helpers";
import { callRound } from "../commands/agent.test-helpers";
import { resolveLocalProfile } from "../harness/policy/profiles";
import { superviseSpawnedProcess } from "../harness/tool/builtin/background-job-registry";

test("native runtime stop awaits its supervised process group and proves absence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-runtime-stop-"));
  const runtime = createNativeSessionRuntime({ cwd, provider: scriptedProvider([okReply]).provider, providerId: "scripted", modelId: "m" });
  try {
    const started = await runtime.jobs.start("sleep 30 & wait");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const stopped = await runtime.stop();
    expect(stopped.status).toBe("stopped");
    expect(runtime.jobs.list().every((job) => job.status !== "running")).toBe(true);
    expect(() => process.kill(-started.pid, 0)).toThrow();
  } finally { await runtime.stop(); await rm(cwd, { recursive: true, force: true }); }
});

test("native run-scope stop leaves another run's and an unowned job running", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-runtime-scope-"));
  const runtime = createNativeSessionRuntime({ cwd, provider: scriptedProvider([okReply]).provider, providerId: "scripted", modelId: "m" });
  try {
    const mine = await runtime.jobs.start("sleep 30", { owner: { kind: "run", identity: "run-a" } });
    const other = await runtime.jobs.start("sleep 30", { owner: { kind: "run", identity: "run-b" } });
    const unowned = await runtime.jobs.start("sleep 30");
    if (!mine.ok || !other.ok || !unowned.ok) throw new Error("jobs did not start");
    const stopped = await runtime.stop({ kind: "run", identity: "run-a" });
    expect(runtime.jobs.get(mine.jobId)?.status).not.toBe("running");
    expect(runtime.jobs.get(other.jobId)?.status).toBe("running");
    expect(runtime.jobs.get(unowned.jobId)?.status).toBe("running");
    expect(stopped.status).toBe("unknown");
    expect(stopped.remainingTaskIds).toEqual([unowned.jobId]);
    expect((await runtime.stop()).status).toBe("stopped");
    expect(() => process.kill(-other.pid, 0)).toThrow();
    expect(() => process.kill(-unowned.pid, 0)).toThrow();
  } finally { await runtime.stop(); await rm(cwd, { recursive: true, force: true }); }
});

test.each([["owned", { kind: "session" as const, identity: "native-session" }], ["unowned", undefined]])("native stop of a surviving %s job is bounded and stays unknown on every call", async (_label, owner) => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-runtime-unkillable-"));
  const spawnIdle = () => Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdout: "pipe", stderr: "pipe", detached: true });
  let child: ReturnType<typeof spawnIdle> | undefined;
  const spawner = () => { const proc = spawnIdle(); child = proc; return superviseSpawnedProcess(proc, { kill() { /* Injected failed OS stop: the process group stays alive for proof. */ } }); };
  const runtime = createNativeSessionRuntime({ cwd, provider: scriptedProvider([okReply]).provider, providerId: "scripted", modelId: "m", spawner });
  try {
    const started = await runtime.jobs.start("unkillable", owner === undefined ? {} : { owner });
    if (!started.ok) throw new Error("job did not start");
    for (const call of [1, 2]) {
      const begun = Date.now(); const stopped = await runtime.stop();
      expect({ call, status: stopped.status, remaining: stopped.remainingTaskIds }).toEqual({ call, status: "unknown", remaining: [started.jobId] });
      expect(Date.now() - begun).toBeLessThan(NATIVE_KILL_GRACE_MS + 2500);
    }
    expect(() => process.kill(-child!.pid, 0)).not.toThrow();
    process.kill(-child!.pid, "SIGKILL"); await child!.exited;
    expect((await runtime.stop()).status).toBe("stopped");
  } finally { if (child) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } await child.exited; } await runtime.stop(); await rm(cwd, { recursive: true, force: true }); }
}, 20000);

test("local native policy denial cannot be lifted by an approving transport callback", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-runtime-policy-"));
  const provider = scriptedProvider([callRound("write", "apply_patch", JSON.stringify({ patch: "diff --git a/forbidden.txt b/forbidden.txt\nnew file mode 100644\n--- /dev/null\n+++ b/forbidden.txt\n@@ -0,0 +1 @@\n+forbidden\n" })), okReply]);
  const runtime = createNativeSessionRuntime({ cwd, provider: provider.provider, providerId: "scripted", modelId: "m", policy: resolveLocalProfile("read-only-review"), approve: async () => true });
  const config = { configVersion: 1, baselineCandidateId: "scripted:m", reasoningEffort: "none", routing: { enabled: false, profileId: "local", candidateIds: ["scripted:m"], fallbackCandidateId: "scripted:m" }, policyDigest: "a".repeat(64), capabilityDigest: "a".repeat(64) } as const;
  try {
    const snapshot = await runtime.routing({ ...config, routing: { ...config.routing, candidateIds: ["scripted:m"] } }).select("write", { ...config, routing: { ...config.routing, candidateIds: ["scripted:m"] } });
    const results: string[] = [];
    await runtime.run({ write: () => {}, onToolResult: (_name, result) => results.push(result.output) }, [], "Create forbidden.txt", snapshot, {});
    expect(results.some((result) => result.includes("local-policy-denied"))).toBe(true);
    expect(await Bun.file(join(cwd, "forbidden.txt")).exists()).toBe(false);
  } finally { await runtime.stop(); await rm(cwd, { recursive: true, force: true }); }
});

test("native runtime distinguishes a provider failure from a clean text turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-runtime-failure-"));
  const provider = scriptedProvider([[{ kind: "provider_error", error: { kind: "authentication", message: "denied", retryable: false } }]]);
  const runtime = createNativeSessionRuntime({ cwd, provider: provider.provider, providerId: "scripted", modelId: "m" });
  const config = { configVersion: 1, baselineCandidateId: "scripted:m", reasoningEffort: "none" as const, routing: { enabled: false, profileId: "local", candidateIds: ["scripted:m"], fallbackCandidateId: "scripted:m" }, policyDigest: "a".repeat(64), capabilityDigest: "a".repeat(64) };
  try {
    const result = await runtime.run({ write: () => {} }, [], "hello", await runtime.routing(config).select("hello", config), {});
    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("provider-error");
  } finally { await runtime.stop(); await rm(cwd, { recursive: true, force: true }); }
});

test("an owned process spawn is announced as an intent before the process exists, then by its real pid", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-runtime-identity-"));
  const order: string[] = []; let failSpawn = false;
  const runtime = createNativeSessionRuntime({ cwd, provider: scriptedProvider([okReply]).provider, providerId: "scripted", modelId: "m",
    spawner: () => { order.push("spawn"); if (failSpawn) throw new Error("spawn refused"); const proc = Bun.spawn(["sleep", "30"], { stdout: "pipe", stderr: "pipe", detached: true }); return superviseSpawnedProcess(proc, { kill: (signal) => { try { process.kill(-proc.pid, signal); } catch { /* The group is already gone. */ } } }); } });
  const events: Array<{ phase: string; intentId: string; pid?: number }> = [];
  const stop = runtime.observeOwnedProcesses((event) => { order.push(event.phase); events.push(event); });
  try {
    const started = await runtime.jobs.start("Owned identity probe", { phase: "background" });
    expect(started.ok).toBe(true); if (!started.ok) return;
    expect(order.slice(0, 3)).toEqual(["intent", "spawn", "started"]);
    expect(events[1]).toEqual({ phase: "started", intentId: events[0]!.intentId, pid: runtime.jobs.get(started.jobId)!.pid });
    expect(() => process.kill(-events[1]!.pid!, 0)).not.toThrow();
    // A spawn that creates no process withdraws its intent; one the listener refuses never spawns at all.
    failSpawn = true; order.length = 0; events.length = 0;
    expect((await runtime.jobs.start("Refused spawn", { phase: "background" }).catch(() => ({ ok: false as const }))).ok).toBe(false);
    expect(order).toEqual(["intent", "spawn", "failed"]); expect(events[1]!.intentId).toBe(events[0]!.intentId);
    failSpawn = false; stop(); order.length = 0;
    runtime.observeOwnedProcesses(() => { throw new Error("identity store unavailable"); });
    await expect(runtime.jobs.start("Unrecorded spawn", { phase: "background" })).rejects.toThrow("identity store unavailable");
    expect(order).toEqual([]);
  } finally { stop(); expect((await runtime.stop()).status).toBe("stopped"); await rm(cwd, { recursive: true, force: true }); }
});

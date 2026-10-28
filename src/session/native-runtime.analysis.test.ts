import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeSessionRuntime } from "./native-runtime";
import { okReply, scriptedProvider } from "../commands/agent.test-helpers";
import { superviseSpawnedProcess } from "../harness/tool/builtin/background-job-registry";

test("local analysis diff is fixed, supervised, bounded and disables repository external diff programs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-analysis-owned-diff-"));
  const run = async (...args: string[]) => { const process = Bun.spawn(["git", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, stdout: "ignore", stderr: "pipe" }); expect(await process.exited).toBe(0); };
  const runtime = createNativeSessionRuntime({ cwd, provider: scriptedProvider([okReply]).provider, providerId: "scripted", modelId: "m",
    analysis: { enabledCommands: ["risk"], model: "jev-1.13", env: {}, fetchFn: fetch, maxCalls: 1, policyDigest: "a".repeat(64) } });
  try {
    await run("init", "-q"); await run("config", "user.email", "fixture@example.invalid"); await run("config", "user.name", "fixture");
    await writeFile(join(cwd, "sample.txt"), "before\n"); await run("add", "."); await run("commit", "-qm", "fixture");
    await run("config", "diff.external", "touch unsafe-external-program"); await writeFile(join(cwd, "sample.txt"), "after\n");
    const diff = await runtime.commandPolicy("a".repeat(64)).analysis!.readDiff(new AbortController().signal);
    expect(diff).toContain("-before"); expect(diff).toContain("+after");
    expect(await Bun.file(join(cwd, "unsafe-external-program")).exists()).toBe(false);
    const task = runtime.jobs.list()[0]!; expect(task.status).toBe("completed"); expect(task.exitCode).toBe(0);
    expect(runtime.jobs.readOutput(task.jobId)).toMatchObject({ ok: true });
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe("after\n");
  } finally { await runtime.stop(); await rm(cwd, { recursive: true, force: true }); }
});

test("Flow-free read port exists without any Jev service and exposes only the owned fixed GH read", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-owned-read-port-")); let spawned = 0;
  const runtime = createNativeSessionRuntime({ cwd, provider: scriptedProvider([okReply]).provider, providerId: "scripted", modelId: "m",
    spawner: async () => { spawned++; const proc = Bun.spawn(["bun", "-e", 'process.stdout.write("[]")'], { cwd, stdout: "pipe", stderr: "pipe", detached: true });
      return superviseSpawnedProcess(proc, { kill(signal) { try { process.kill(-proc.pid, signal); } catch { /* The process group already exited. */ } } }); } });
  try {
    expect(runtime.commandPolicy("a".repeat(64)).analysis).toBeUndefined();
    const port = runtime.analysisReadPort(); expect(Object.keys(port)).toEqual(["ciSpawn"]);
    await expect(port.ciSpawn(["gh", "auth", "token"], cwd)).rejects.toThrow("invalid-argv"); expect(spawned).toBe(0);
    expect(await port.ciSpawn(["gh", "run", "list", "--branch", "feature", "--json", "databaseId,conclusion,workflowName,headBranch,createdAt", "-L", "20"], cwd)).toEqual({ stdout: "[]", stderr: "", exitCode: 0 });
    expect(spawned).toBe(1); expect(runtime.jobs.list()[0]?.status).toBe("completed");
    const inspection = runtime.commandContributions().filter((item) => item.entry.handlerId.endsWith(".inspect")).map((item) => [item.entry.commandName, item.entry.availability]);
    expect(inspection).toEqual([["ci", "available"], ["conform", "available"]]);
  } finally { await runtime.stop(); await rm(cwd, { recursive: true, force: true }); }
});

test("analysis GH reads use owned processes with distinct stdout and stderr and reject argv before spawning", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-owned-gh-read-")); let spawned = 0;
  const runtime = createNativeSessionRuntime({ cwd, provider: scriptedProvider([okReply]).provider, providerId: "scripted", modelId: "m",
    analysis: { enabledCommands: ["ci"], model: "jev-1.13", env: {}, fetchFn: fetch, maxCalls: 1, policyDigest: "a".repeat(64) },
    spawner: async () => {
      spawned++;
      const proc = Bun.spawn(["bun", "-e", 'process.stdout.write("{\\"number\\":1}");process.stderr.write("fixture-stderr")'], { cwd, stdout: "pipe", stderr: "pipe", detached: true });
      return superviseSpawnedProcess(proc, { kill(signal) { try { process.kill(-proc.pid, signal); } catch { /* The process group already exited. */ } } });
    },
  });
  try {
    const port = runtime.commandPolicy("a".repeat(64)).analysis!;
    const actual = await port.ciSpawn!(["gh", "pr", "view", "--json", "number,title"], cwd, new AbortController().signal);
    expect(actual.stdout).toBe('{"number":1}'); expect(actual.stderr).toBe("fixture-stderr"); expect(actual.exitCode).toBe(0);
    await expect(port.ciSpawn!(["gh", "run", "rerun", "1"], cwd)).rejects.toThrow("invalid-argv"); expect(spawned).toBe(1);
    expect(runtime.jobs.list()[0]?.status).toBe("completed");
  } finally { await runtime.stop(); await rm(cwd, { recursive: true, force: true }); }
});

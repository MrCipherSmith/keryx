// Flow 306 (AC6): the CI read port, live and fixture halves. No test spawns a
// real `gh` process; the live adapter is exercised against an injected spawn
// function that records every argv it was asked to run.

import { describe, expect, test } from "bun:test";
import { createFixtureCiPort, createGhCiPort, type CiSpawn } from "./ci-port";

function spawnReturning(stdout: string, exitCode = 0): CiSpawn {
  const fn = async (argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    (fn as unknown as { calls: string[][] }).calls.push(argv);
    return { stdout, stderr: "", exitCode };
  };
  (fn as unknown as { calls: string[][] }).calls = [];
  return fn as unknown as CiSpawn;
}

describe("createGhCiPort (live adapter)", () => {
  test("runInfo shells to `gh run view --json jobs,...` and parses it", async () => {
    const spawn = spawnReturning(
      JSON.stringify({
        jobs: [
          { name: "typecheck-and-tests", conclusion: "failure", status: "completed" },
          { name: "opentui native (linux-x64)", conclusion: "success", status: "completed" },
        ],
        workflowName: "CI",
        headBranch: "feat/x",
        headSha: "deadbeef",
        conclusion: "failure",
      }),
    );
    const port = createGhCiPort(spawn, "acme/widget");
    const info = await port.runInfo("123");
    expect(info.workflowName).toBe("CI");
    expect(info.jobs).toHaveLength(2);
    expect(info.jobs[0]?.conclusion).toBe("failure");
    const calls = (spawn as unknown as { calls: string[][] }).calls;
    expect(calls[0]).toEqual(["gh", "run", "view", "123", "--repo", "acme/widget", "--json", "jobs,workflowName,headBranch,headSha,conclusion"]);
  });

  test("failedLog shells to `gh run view --log-failed`", async () => {
    const spawn = spawnReturning("typecheck-and-tests\tTest\tAssertionError: expected 1 to be 2\n");
    const port = createGhCiPort(spawn);
    const log = await port.failedLog("123");
    expect(log).toContain("AssertionError");
    const calls = (spawn as unknown as { calls: string[][] }).calls;
    expect(calls[0]).toEqual(["gh", "run", "view", "123", "--log-failed"]);
  });

  test("recentRuns shells to `gh run list --workflow`", async () => {
    const spawn = spawnReturning(
      JSON.stringify([{ databaseId: 1, conclusion: "success", createdAt: "2026-09-25T00:00:00Z", headBranch: "main" }]),
    );
    const port = createGhCiPort(spawn);
    const history = await port.recentRuns("CI", 5);
    expect(history).toEqual([{ runId: "1", conclusion: "success", createdAt: "2026-09-25T00:00:00Z", headBranch: "main" }]);
    const calls = (spawn as unknown as { calls: string[][] }).calls;
    expect(calls[0]).toEqual(["gh", "run", "list", "--workflow", "CI", "--json", "databaseId,conclusion,createdAt,headBranch", "-L", "5"]);
  });

  test("AC9: the live adapter never shells a rerun, cancel, delete, or POST/PUT/PATCH/DELETE call", async () => {
    const spawn = spawnReturning("{}");
    const port = createGhCiPort(spawn);
    await port.runInfo("1").catch(() => undefined);
    await port.failedLog("1").catch(() => undefined);
    await port.recentRuns("CI").catch(() => undefined);
    await port.priorAttempts("1").catch(() => undefined);
    await port.changedFiles("deadbeef").catch(() => undefined);
    await port.runsForHeadSha("deadbeef", "CI").catch(() => undefined);
    const calls = (spawn as unknown as { calls: string[][] }).calls;
    for (const argv of calls) {
      const joined = argv.join(" ");
      expect(joined).not.toMatch(/rerun|cancel|delete|--method\s+(POST|PUT|PATCH|DELETE)/i);
    }
  });

  test("flow 307 AC1(a): priorAttempts reads `attempt`, then fetches each earlier attempt's jobs", async () => {
    const calls: string[][] = [];
    const spawn: CiSpawn = async (argv) => {
      calls.push(argv);
      if (argv.includes("--attempt")) {
        return { stdout: JSON.stringify({ jobs: [{ name: "typecheck-and-tests", conclusion: "failure" }] }), stderr: "", exitCode: 0 };
      }
      return { stdout: JSON.stringify({ attempt: 2 }), stderr: "", exitCode: 0 };
    };
    const port = createGhCiPort(spawn, "acme/widget");
    const attempts = await port.priorAttempts("123");
    expect(attempts).toEqual([{ attempt: 1, jobs: [{ name: "typecheck-and-tests", conclusion: "failure" }] }]);
    expect(calls[0]).toEqual(["gh", "run", "view", "123", "--repo", "acme/widget", "--json", "attempt"]);
    expect(calls[1]).toEqual(["gh", "run", "view", "123", "--attempt", "1", "--repo", "acme/widget", "--json", "jobs"]);
  });

  test("flow 307 AC1(a): a run at its first attempt has no prior attempts, and fetches only `attempt`", async () => {
    const spawn = spawnReturning(JSON.stringify({ attempt: 1 }));
    const port = createGhCiPort(spawn);
    expect(await port.priorAttempts("123")).toEqual([]);
    expect((spawn as unknown as { calls: string[][] }).calls).toHaveLength(1);
  });

  test("flow 307 AC1(c): changedFiles reads the commit's file list", async () => {
    const spawn = spawnReturning("src/a.ts\nsrc/a.test.ts\n");
    const port = createGhCiPort(spawn, "acme/widget");
    expect(await port.changedFiles("deadbeef")).toEqual(["src/a.ts", "src/a.test.ts"]);
    const calls = (spawn as unknown as { calls: string[][] }).calls;
    expect(calls[0]).toEqual(["gh", "api", "repos/acme/widget/commits/deadbeef", "--jq", ".files[].filename"]);
  });

  test("flow 307 AC1(c): changedFiles answers empty, not throws, on a non-zero exit", async () => {
    const port = createGhCiPort(spawnReturning("", 1));
    expect(await port.changedFiles("deadbeef")).toEqual([]);
  });

  test("flow 307 AC8: runsForHeadSha shells `gh run list --commit`", async () => {
    const spawn = spawnReturning(JSON.stringify([{ databaseId: 2, conclusion: "success", createdAt: "2026-09-24T00:00:00Z", headBranch: "main" }]));
    const port = createGhCiPort(spawn, "acme/widget");
    const runs = await port.runsForHeadSha("deadbeef", "CI");
    expect(runs).toEqual([{ runId: "2", conclusion: "success", createdAt: "2026-09-24T00:00:00Z", headBranch: "main" }]);
    const calls = (spawn as unknown as { calls: string[][] }).calls;
    expect(calls[0]).toEqual(["gh", "run", "list", "--repo", "acme/widget", "--workflow", "CI", "--commit", "deadbeef", "--json", "databaseId,conclusion,createdAt,headBranch", "-L", "10"]);
  });

  test("a non-zero exit throws with the command and stderr named", async () => {
    const spawn = async (): Promise<{ stdout: string; stderr: string; exitCode: number }> => ({
      stdout: "",
      stderr: "not found",
      exitCode: 1,
    });
    const port = createGhCiPort(spawn as CiSpawn);
    await expect(port.runInfo("1")).rejects.toThrow(/gh run view 1/);
  });
});

describe("createFixtureCiPort (offline adapter)", () => {
  const runInfo = {
    runId: "9",
    workflowName: "CI",
    headBranch: "feat/x",
    headSha: "deadbeef",
    conclusion: "failure" as const,
    jobs: [{ name: "typecheck-and-tests", conclusion: "failure" as const }],
  };

  test("answers from the supplied files and records every call", async () => {
    const port = createFixtureCiPort({
      runs: { "9": runInfo },
      logs: { "9": "typecheck-and-tests\tTest\tboom\n" },
      history: { CI: [{ runId: "8", conclusion: "success", createdAt: null, headBranch: "main" }] },
    });
    expect(await port.runInfo("9")).toEqual(runInfo);
    expect(await port.failedLog("9")).toContain("boom");
    expect(await port.recentRuns("CI")).toHaveLength(1);
    expect(port.calls).toEqual([
      { op: "runInfo", runId: "9" },
      { op: "failedLog", runId: "9" },
      { op: "recentRuns", workflowName: "CI" },
    ]);
  });

  test("a run with no fixture throws rather than fabricating one", async () => {
    const port = createFixtureCiPort({});
    await expect(port.runInfo("missing")).rejects.toThrow(/no fixture run info/);
  });

  test("no fixture log or history answers empty, not undefined", async () => {
    const port = createFixtureCiPort({ runs: { "9": runInfo } });
    expect(await port.failedLog("9")).toBe("");
    expect(await port.recentRuns("CI")).toEqual([]);
  });

  test("AC9: the fixture port has no method that could rerun, cancel, or write a status check", () => {
    const port = createFixtureCiPort({});
    const methods = Object.keys(port).filter((k) => k !== "calls");
    expect(methods.sort()).toEqual(["changedFiles", "failedLog", "priorAttempts", "recentRuns", "runInfo", "runsForHeadSha"]);
  });

  test("flow 307: the fixture port answers the three new read signals from files, and records calls", async () => {
    const port = createFixtureCiPort({
      attempts: { "9": [{ attempt: 1, jobs: [{ name: "typecheck-and-tests", conclusion: "success" }] }] },
      changedFiles: { deadbeef: ["src/a.ts"] },
      runsByHeadSha: { "CI:deadbeef": [{ runId: "10", conclusion: "success", createdAt: null, headBranch: "main" }] },
    });
    expect(await port.priorAttempts("9")).toHaveLength(1);
    expect(await port.changedFiles("deadbeef")).toEqual(["src/a.ts"]);
    expect(await port.runsForHeadSha("deadbeef", "CI")).toHaveLength(1);
    expect(port.calls).toEqual([
      { op: "priorAttempts", runId: "9" },
      { op: "changedFiles", headSha: "deadbeef" },
      { op: "runsForHeadSha", headSha: "deadbeef", workflowName: "CI" },
    ]);
  });

  test("flow 307: missing fixture data answers empty, not undefined", async () => {
    const port = createFixtureCiPort({});
    expect(await port.priorAttempts("missing")).toEqual([]);
    expect(await port.changedFiles("missing")).toEqual([]);
    expect(await port.runsForHeadSha("missing", "CI")).toEqual([]);
  });
});

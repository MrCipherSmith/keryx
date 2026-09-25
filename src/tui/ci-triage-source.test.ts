// Flow 306: the `/ci` production data source, exercised entirely through an
// injected `gh` spawn and an injected `fetch` — no real `gh` call, no real
// network call.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadCiTriageList, runCiTriageForItem, type CiSourceSpawn, type CiSpawnResult } from "./ci-triage-source";
import type { CiTriageJobItem } from "./ci-triage-inspector";

async function withEnabledProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-ci-source-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { ci_triage: true } } }), "utf8");
  return dir;
}

function recordingSpawn(byArgv: (argv: string[]) => CiSpawnResult): { spawn: CiSourceSpawn; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: CiSourceSpawn = async (argv) => {
    calls.push(argv);
    return byArgv(argv);
  };
  return { spawn, calls };
}

describe("loadCiTriageList", () => {
  test("not opted in: a note, and gh is never called", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keryx-ci-source-"));
    try {
      const { spawn, calls } = recordingSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
      const result = await loadCiTriageList(dir, spawn);
      expect(result.items).toEqual([]);
      expect(result.note).toContain("not enabled");
      expect(calls).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no PR for the current branch: a note naming that", async () => {
    const dir = await withEnabledProject();
    try {
      const { spawn } = recordingSpawn((argv) =>
        argv[1] === "pr" ? { stdout: "", stderr: "no pull requests found", exitCode: 1 } : { stdout: "[]", stderr: "", exitCode: 0 },
      );
      const result = await loadCiTriageList(dir, spawn);
      expect(result.items).toEqual([]);
      expect(result.note).toContain("No pull request");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a PR with failed runs: every failed job across those runs is listed", async () => {
    const dir = await withEnabledProject();
    try {
      const { spawn, calls } = recordingSpawn((argv) => {
        if (argv[1] === "pr") return { stdout: JSON.stringify({ number: 7, headRefName: "feat/x" }), stderr: "", exitCode: 0 };
        if (argv[1] === "run" && argv[2] === "list") {
          return {
            stdout: JSON.stringify([
              { databaseId: 1, conclusion: "failure", workflowName: "CI", headBranch: "feat/x", createdAt: "2026-09-25T00:00:00Z" },
              { databaseId: 2, conclusion: "success", workflowName: "CI", headBranch: "feat/x", createdAt: "2026-09-25T00:05:00Z" },
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        if (argv[1] === "run" && argv[2] === "view") {
          return {
            stdout: JSON.stringify({
              jobs: [
                { name: "typecheck-and-tests", conclusion: "failure" },
                { name: "metrics-contract", conclusion: "success" },
              ],
              workflowName: "CI",
              headBranch: "feat/x",
              headSha: "deadbeef",
              conclusion: "failure",
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        throw new Error(`unexpected argv: ${argv.join(" ")}`);
      });
      const result = await loadCiTriageList(dir, spawn);
      expect(result.items).toEqual([
        { runId: "1", jobName: "typecheck-and-tests", workflowName: "CI", headBranch: "feat/x", conclusion: "failure", createdAt: "2026-09-25T00:00:00Z" },
      ]);
      expect(calls.some((argv) => argv.includes("rerun") || argv.includes("cancel"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no failed runs on the branch: a note, not an error", async () => {
    const dir = await withEnabledProject();
    try {
      const { spawn } = recordingSpawn((argv) => {
        if (argv[1] === "pr") return { stdout: JSON.stringify({ number: 7, headRefName: "feat/x" }), stderr: "", exitCode: 0 };
        return { stdout: "[]", stderr: "", exitCode: 0 };
      });
      const result = await loadCiTriageList(dir, spawn);
      expect(result.items).toEqual([]);
      expect(result.note).toContain("No failed CI runs");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runCiTriageForItem", () => {
  const item: CiTriageJobItem = {
    runId: "1",
    jobName: "typecheck-and-tests",
    workflowName: "CI",
    headBranch: "feat/x",
    conclusion: "failure",
  };

  test("not opted in: refused, no gh call and no fetch call", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keryx-ci-source-"));
    try {
      const { spawn, calls } = recordingSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
      let fetchCalled = false;
      const fetchFn = (async () => {
        fetchCalled = true;
        return new Response("{}");
      }) as unknown as typeof fetch;
      const result = await runCiTriageForItem(dir, item, spawn, fetchFn);
      expect(result.ok).toBe(false);
      expect(calls).toHaveLength(0);
      expect(fetchCalled).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("opted in, no credential: refused, no gh call and no fetch call", async () => {
    const dir = await withEnabledProject();
    const prevKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const { spawn, calls } = recordingSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
      let fetchCalled = false;
      const fetchFn = (async () => {
        fetchCalled = true;
        return new Response("{}");
      }) as unknown as typeof fetch;
      const result = await runCiTriageForItem(dir, item, spawn, fetchFn);
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toContain("OPENROUTER_API_KEY");
      expect(calls).toHaveLength(0);
      expect(fetchCalled).toBe(false);
    } finally {
      if (prevKey !== undefined) process.env.OPENROUTER_API_KEY = prevKey;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("opted in and credentialed: fetches the log, calls Jev once, returns the verdict", async () => {
    const dir = await withEnabledProject();
    const prevKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    try {
      const { spawn, calls } = recordingSpawn((argv) => {
        if (argv.includes("--log-failed")) {
          return { stdout: "typecheck-and-tests\tstep\tat (src/x.test.ts:9:1)\n", stderr: "", exitCode: 0 };
        }
        throw new Error(`unexpected argv: ${argv.join(" ")}`);
      });
      let fetchCalls = 0;
      const fetchFn = (async () => {
        fetchCalls += 1;
        return new Response(
          JSON.stringify({ answers: { flaky: { type: "noul", noul: 0.9 }, infra: { type: "noul", noul: 0.05 }, "real-regression": { type: "noul", noul: 0.05 } }, usage: {} }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;
      const result = await runCiTriageForItem(dir, item, spawn, fetchFn);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.verdict.top).toBe("flaky");
        expect(result.testName).toBe("src/x.test.ts:9");
      }
      expect(fetchCalls).toBe(1);
      expect(calls.some((argv) => argv.includes("rerun") || argv.includes("cancel"))).toBe(false);
    } finally {
      if (prevKey !== undefined) process.env.OPENROUTER_API_KEY = prevKey;
      else delete process.env.OPENROUTER_API_KEY;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

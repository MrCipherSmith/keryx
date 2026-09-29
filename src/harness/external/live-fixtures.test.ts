// Recorded real-vendor runs through the runtime (flow 366), plus the opt-in live
// tests that re-record them. Offline by default: the spawn port and the git
// worktree are fakes fed with the raw transcripts in `fixtures/external/live/`.
//
// The live tests run only with KERYX_LIVE_EXTERNAL=1. They spend subscription
// quota and need the vendor CLI logged in, `externalAgents.enabled` on, and
// KERYX_LIVE_EXTERNAL_CWD pointing at a clean scratch git repo whose project
// manifest allows external agents. They assert against real processes; they
// record nothing. The antigravity-cli replay lives in antigravity-cli.runtime.test.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import type { CreatedWorktree, WorktreeMergeResult, WorktreePort } from "../child/worktree";
import type { RuntimeBlock } from "./dispatch";
import { runExternalChild, type RunExternalChildDeps, type RunExternalChildInput } from "./runtime";
import type { ExternalSpawnOptions, ExternalSpawnPort, SpawnedProcess } from "./supervise";

const LIVE_ROOT = fileURLToPath(new URL("../../../fixtures/external/live/", import.meta.url));
const RECORDED = "2026-09-29";

function liveFile(agent: string, name: string): string {
  return readFileSync(path.join(LIVE_ROOT, agent, RECORDED, name), "utf8");
}

function streamLines(agent: string, name: string): string[] {
  return liveFile(agent, name)
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

async function* lines(items: readonly string[]): AsyncIterable<string> {
  for (const item of items) yield item;
}

function fakeSpawn(stdout: readonly string[], exitCode: number): { port: ExternalSpawnPort; argv: () => readonly string[] } {
  let seen: readonly string[] = [];
  const port: ExternalSpawnPort = {
    spawn(argv: readonly string[], _opts: ExternalSpawnOptions): SpawnedProcess {
      seen = argv;
      return {
        stdout: lines(stdout),
        stderr: lines([]),
        writeStdin: () => undefined,
        kill: () => undefined,
        exited: Promise.resolve(exitCode),
      };
    },
  };
  return { port, argv: () => seen };
}

const worktree: WorktreePort = {
  async create(id): Promise<CreatedWorktree> {
    return { worktreeId: id, path: `/wt/${id}` };
  },
  async remove(): Promise<void> {},
  async merge(id): Promise<WorktreeMergeResult> {
    return { worktreeId: id, ok: true };
  },
};

function input(agent: string): RunExternalChildInput {
  const runtime: RuntimeBlock = { kind: "external", agent, sandbox: "read-only" };
  return {
    runtime,
    allowedActions: ["read"],
    taskTitle: "Say ok",
    taskDescription: "reply with the single word ok; change nothing",
    acceptanceCriteria: [],
    worktreeId: `wt-${agent}`,
    maxPromptBytes: 65536,
    timeoutMs: 60_000,
    parentEnv: { PATH: "/usr/bin", HOME: "/home/op" },
    depth: 0,
  };
}

function deps(spawn: ExternalSpawnPort): RunExternalChildDeps {
  return { spawn, worktree, capability: () => ({ enabled: true }), maxExternalDepth: 2 };
}

describe("claude-cli: the recorded 2.1.280 run replays through the runtime", () => {
  test("a schema-valid structured answer ends Completed with cost and session reported", async () => {
    const sp = fakeSpawn(streamLines("claude-cli", "keryx-run-ok.stream.jsonl"), 0);
    const result = await runExternalChild(input("claude-cli"), deps(sp.port));
    expect(result.status).toBe("Completed");
    expect(JSON.parse(result.output).summary).toBe("ok");
    expect(result.costUnits).toBeGreaterThan(0);
    expect(result.skippedLines).toBe(0);
    expect(result.sessionRef).toBeDefined();
    expect(sp.argv()[0]).toBe("claude");
  });

  test("the recorded outcome of the real dispatch agrees with the replay", () => {
    const recorded = JSON.parse(liveFile("claude-cli", "keryx-run-ok.outcome.json"));
    expect(recorded.status).toBe("Completed");
    expect(recorded.isError).toBe(false);
    expect(JSON.parse(recorded.output).summary).toBe("ok");
  });
});

describe("codex-cli: the recorded 0.159.0 usage-limit failure", () => {
  test("replays as Denied and carries the retry time to the operator", async () => {
    const sp = fakeSpawn(streamLines("codex-cli", "usage-limit.stream.jsonl"), 1);
    const result = await runExternalChild(input("codex-cli"), deps(sp.port));
    expect(result.status).toBe("Denied");
    expect(result.output).toContain("usage or rate limit");
    expect(result.output).toContain("try again at Oct 3rd, 2026 5:10 PM");
    expect(result.skippedLines).toBe(0);
  });

  test("the recorded outcome of the real dispatch agrees with the replay", () => {
    const recorded = JSON.parse(liveFile("codex-cli", "usage-limit.outcome.json"));
    expect(recorded.status).toBe("Denied");
    expect(recorded.isError).toBe(true);
    expect(recorded.output).toContain("usage or rate limit");
  });
});

describe("every recorded live fixture carries its vendor version and no private data", () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(LIVE_ROOT);

  const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
    ["home path", /\/(?:home|Users)\/[A-Za-z0-9._-]+/],
    ["session scratch path", /\/tmp\/claude-\d+/],
    ["user runtime dir", /\/run\/user\/\d+/],
    ["email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/],
    ["api key", /\bsk-[A-Za-z0-9_-]{16,}/],
    ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
    ["bearer token", /Bearer\s+[A-Za-z0-9._-]{16,}/i],
    ["google key", /\bAIza[0-9A-Za-z_-]{20,}/],
    ["vendor credential store", /\.gemini\/antigravity-cli/],
  ];

  test("the fixture set is not empty", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    const rel = path.relative(LIVE_ROOT, file);
    test(`${rel} matches none of the known private-data patterns`, () => {
      const text = readFileSync(file, "utf8");
      for (const [label, pattern] of FORBIDDEN) {
        expect({ label, match: pattern.exec(text)?.[0] }).toEqual({ label, match: undefined });
      }
    });
  }

  for (const agent of ["claude-cli", "codex-cli", "antigravity-cli"]) {
    test(`${agent} has a versions file naming the vendor binary version`, () => {
      const versions = files.filter((f) => f.includes(`${path.sep}${agent}${path.sep}`) && f.endsWith(".versions.json"));
      expect(versions.length).toBeGreaterThan(0);
      for (const file of versions) {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        const binary = agent === "claude-cli" ? "claude" : agent === "codex-cli" ? "codex" : "agy";
        expect(typeof parsed[binary]).toBe("string");
        expect(typeof parsed.recordedAt).toBe("string");
      }
    });
  }
});

const LIVE = process.env.KERYX_LIVE_EXTERNAL === "1";

describe("live: a real vendor process through `keryx agents external run` (KERYX_LIVE_EXTERNAL=1)", () => {
  const cli = fileURLToPath(new URL("../../cli.ts", import.meta.url));
  const task = "reply with the single word ok; change nothing";

  async function liveRun(agent: string, prompt: string): Promise<Record<string, unknown>> {
    // The runtime puts uncommitted work into the vendor prompt, so a live run must not
    // default to the repository: point KERYX_LIVE_EXTERNAL_CWD at a clean scratch repo.
    const cwd = process.env.KERYX_LIVE_EXTERNAL_CWD;
    if (!cwd) throw new Error("set KERYX_LIVE_EXTERNAL_CWD to a clean scratch git repo (its manifest must allow external agents)");
    const proc = Bun.spawn(["bun", cli, "agents", "external", "run", agent, "--task", prompt, "--unattended", "--json"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    try {
      return JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      throw new Error(`${agent}: exit ${exitCode}, no JSON outcome. stdout: ${stdout.slice(0, 400)} stderr: ${stderr.slice(0, 400)}`);
    }
  }

  test.skipIf(!LIVE)("claude-cli answers", async () => {
    const outcome = await liveRun("claude-cli", task);
    expect(outcome.status).toBe("Completed");
    expect(JSON.parse(String(outcome.output)).summary.length).toBeGreaterThan(0);
  }, 300_000);

  test.skipIf(!LIVE)("codex-cli answers", async () => {
    const outcome = await liveRun("codex-cli", task);
    expect(outcome.status).toBe("Completed");
    expect(JSON.parse(String(outcome.output)).summary.length).toBeGreaterThan(0);
  }, 300_000);

  test.skipIf(!LIVE)("antigravity-cli answers a task that needs no tools", async () => {
    const outcome = await liveRun("antigravity-cli", `${task}. Do not run any commands and do not use any tools.`);
    expect(outcome.status).toBe("Completed");
    expect(JSON.parse(String(outcome.output)).summary.length).toBeGreaterThan(0);
  }, 300_000);
});

// Tests for the external child runtime (flow 176, T14).
//
// Offline end to end: the process seam and the git worktree are both fakes, so a
// complete run — gate, validate, resolve, assemble, supervise, classify, clean
// up — executes with no CLI installed and no subprocess created. The transcripts
// fed to the fake port are the REAL recorded ones in `fixtures/external/`.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import type { CreatedWorktree, WorktreeMergeResult, WorktreePort } from "../child/worktree";
import type { RuntimeBlock } from "./dispatch";
import { runExternalChild, type RunExternalChildDeps, type RunExternalChildInput } from "./runtime";
import type { ExternalSpawnOptions, ExternalSpawnPort, SpawnedProcess } from "./supervise";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/external/", import.meta.url));

function transcript(agent: string, name: string): string[] {
  return readFileSync(path.join(FIXTURES, agent, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

async function* lines(items: readonly string[]): AsyncIterable<string> {
  for (const item of items) yield item;
}

interface FakeSpawn {
  readonly port: ExternalSpawnPort;
  readonly calls: Array<{ argv: readonly string[]; opts: ExternalSpawnOptions }>;
}

function fakeSpawn(stdout: readonly string[], exitCode = 0, stderr: readonly string[] = []): FakeSpawn {
  const calls: Array<{ argv: readonly string[]; opts: ExternalSpawnOptions }> = [];
  const port: ExternalSpawnPort = {
    spawn(argv, opts): SpawnedProcess {
      calls.push({ argv, opts });
      return {
        stdout: lines(stdout),
        stderr: lines(stderr),
        writeStdin: () => undefined,
        kill: () => undefined,
        exited: Promise.resolve(exitCode),
      };
    },
  };
  return { port, calls };
}

interface FakeWorktree {
  readonly port: WorktreePort;
  readonly created: string[];
  readonly removed: string[];
}

function fakeWorktree(): FakeWorktree {
  const created: string[] = [];
  const removed: string[] = [];
  const port: WorktreePort = {
    async create(id): Promise<CreatedWorktree> {
      created.push(id);
      return { worktreeId: id, path: `/wt/${id}` };
    },
    async remove(id): Promise<void> {
      removed.push(id);
    },
    async merge(id): Promise<WorktreeMergeResult> {
      return { worktreeId: id, ok: true };
    },
  };
  return { port, created, removed };
}

const EXTERNAL: RuntimeBlock = { kind: "external", agent: "codex-cli", sandbox: "read-only" };

function baseInput(overrides: Partial<RunExternalChildInput> = {}): RunExternalChildInput {
  return {
    runtime: EXTERNAL,
    allowedActions: ["read", "run-command"],
    taskTitle: "Investigate the failing test",
    taskDescription: "Find why the resume suite is flaky.",
    acceptanceCriteria: ["names the interfering file"],
    worktreeId: "wt-1",
    maxPromptBytes: 65536,
    timeoutMs: 60_000,
    parentEnv: { PATH: "/usr/bin" },
    depth: 0,
    ...overrides,
  };
}

function baseDeps(overrides: Partial<RunExternalChildDeps> = {}): RunExternalChildDeps {
  return {
    spawn: fakeSpawn([]).port,
    worktree: fakeWorktree().port,
    capability: () => ({ enabled: true }),
    maxExternalDepth: 2,
    ...overrides,
  };
}

describe("gates run before anything is created", () => {
  test("a disabled capability is Denied with its own reason, and spawns nothing", async () => {
    const wt = fakeWorktree();
    const sp = fakeSpawn([]);
    const result = await runExternalChild(
      baseInput(),
      baseDeps({
        capability: () => ({ enabled: false, reason: "external agents are disabled under a remote transport" }),
        worktree: wt.port,
        spawn: sp.port,
      }),
    );
    expect(result.status).toBe("Denied");
    expect(result.output).toContain("remote transport");
    // A silent no-op would leave the operator believing an agent ran.
    expect(sp.calls).toHaveLength(0);
    expect(wt.created).toHaveLength(0);
  });

  test("a disabled capability with no stated reason still names one", async () => {
    const result = await runExternalChild(baseInput(), baseDeps({ capability: () => ({ enabled: false }) }));
    expect(result.status).toBe("Denied");
    expect(result.output.length).toBeGreaterThan(0);
  });

  test("the depth marker refuses nesting past the cap", async () => {
    const sp = fakeSpawn([]);
    const result = await runExternalChild(
      baseInput({ parentEnv: { KERYX_EXTERNAL_DEPTH: "2" } }),
      baseDeps({ maxExternalDepth: 2, spawn: sp.port }),
    );
    expect(result.status).toBe("Denied");
    expect(result.output).toContain("depth cap 2");
    expect(sp.calls).toHaveLength(0);
  });

  test("an invalid runtime block is Denied by the validator's own reason", async () => {
    const result = await runExternalChild(
      baseInput({ runtime: { kind: "external", agent: "opencode", sandbox: "read-only" } }),
      baseDeps(),
    );
    expect(result.status).toBe("Denied");
    expect(result.output).toContain("opencode");
  });

  test("read-only contradicted by allowed_actions is Denied", async () => {
    const result = await runExternalChild(baseInput({ allowedActions: ["read", "write"] }), baseDeps());
    expect(result.status).toBe("Denied");
    expect(result.output).toContain("write");
  });

  test("worktree-write is refused as not implemented, not as unsupported", async () => {
    const result = await runExternalChild(
      baseInput({ runtime: { ...EXTERNAL, sandbox: "worktree-write" }, allowedActions: ["read"] }),
      baseDeps(),
    );
    expect(result.status).toBe("Denied");
    expect(result.output).toContain("not implemented in this release");
  });

  test("a native dispatch handed to this runtime is refused, never run in-process", async () => {
    // Silently running it would report an external agent's status for work keryx
    // did itself.
    const result = await runExternalChild(baseInput({ runtime: { kind: "keryx" } }), baseDeps());
    expect(result.status).toBe("Error");
    expect(result.output).toContain("external");
  });
});

describe("detection", () => {
  test("a missing binary is Denied and names the executable", async () => {
    const sp = fakeSpawn([]);
    const result = await runExternalChild(
      baseInput(),
      baseDeps({ spawn: sp.port, detect: async () => ({ binaryFound: false }) }),
    );
    expect(result.status).toBe("Denied");
    expect(result.output).toContain("codex");
    expect(sp.calls).toHaveLength(0);
  });

  test("an out-of-range version warns and the run still proceeds", async () => {
    // Advisory by design: neither CLI publishes a stable event schema, so
    // hard-failing outside the recorded range breaks on the vendor's next release.
    const warnings: string[] = [];
    const result = await runExternalChild(
      baseInput(),
      baseDeps({
        spawn: fakeSpawn(transcript("codex-cli", "success.stdout.jsonl")).port,
        detect: async () => ({ binaryFound: true, detectOutput: "codex-cli 0.100.0" }),
        onWarning: (w) => warnings.push(w),
      }),
    );
    expect(result.status).toBe("Completed");
    expect(warnings.join(" ")).toContain("outside the range");
  });

  test("omitting the probe entirely is allowed — `not probed` is a real state", async () => {
    const result = await runExternalChild(
      baseInput(),
      baseDeps({ spawn: fakeSpawn(transcript("codex-cli", "success.stdout.jsonl")).port }),
    );
    expect(result.status).toBe("Completed");
  });
});

describe("prompt assembly refuses rather than truncating the task", () => {
  test("a ceiling too small for directive plus task is an Error and creates no worktree", async () => {
    const wt = fakeWorktree();
    const result = await runExternalChild(baseInput({ maxPromptBytes: 10 }), baseDeps({ worktree: wt.port }));
    expect(result.status).toBe("Error");
    expect(wt.created).toHaveLength(0);
  });

  test("a truncated working diff warns but still runs", async () => {
    const warnings: string[] = [];
    const result = await runExternalChild(
      baseInput({ workingDiff: `+${"x".repeat(5000)}\n`.repeat(20), maxPromptBytes: 4096 }),
      baseDeps({
        spawn: fakeSpawn(transcript("codex-cli", "success.stdout.jsonl")).port,
        onWarning: (w) => warnings.push(w),
      }),
    );
    expect(result.status).toBe("Completed");
    expect(warnings.join(" ")).toContain("truncated");
  });
});

describe("a successful run", () => {
  test("returns Completed with the agent's text, its resume handle and the argv", async () => {
    const sp = fakeSpawn(transcript("codex-cli", "success.stdout.jsonl"));
    const result = await runExternalChild(baseInput(), baseDeps({ spawn: sp.port }));

    expect(result.status).toBe("Completed");
    expect(result.isError).toBe(false);
    expect(result.output).toBe("ok");
    // codex GENERATES its own handle; without it the run cannot be resumed at all.
    expect(result.sessionRef).toBe("01a01b40-ddbd-75e3-9204-ed00ca6e3a86");
    expect(result.argv?.[0]).toBe("codex");
  });

  test("runs in the worktree, with the stripped environment and the depth marker", async () => {
    const sp = fakeSpawn(transcript("codex-cli", "success.stdout.jsonl"));
    await runExternalChild(
      baseInput({ parentEnv: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-secret", KERYX_SESSION_ID: "s1" }, depth: 1 }),
      baseDeps({ spawn: sp.port }),
    );
    const opts = sp.calls[0]?.opts;
    expect(opts?.cwd).toBe("/wt/wt-1");
    expect(opts?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(opts?.env).not.toHaveProperty("KERYX_SESSION_ID");
    expect(opts?.env.KERYX_EXTERNAL_DEPTH).toBe("1");
    // Never inherited: a CLI with an open stdin announces it is reading and waits.
    expect(opts?.stdin).not.toBe("inherit");
  });

  test("the argv carries the worktree path, not the parent's cwd", async () => {
    const sp = fakeSpawn(transcript("codex-cli", "success.stdout.jsonl"));
    await runExternalChild(baseInput(), baseDeps({ spawn: sp.port }));
    expect(sp.calls[0]?.argv).toContain("/wt/wt-1");
  });

  test("events reach onEvent live, not only at the end", async () => {
    const seen: string[] = [];
    await runExternalChild(
      baseInput(),
      baseDeps({
        spawn: fakeSpawn(transcript("codex-cli", "success.stdout.jsonl")).port,
        onEvent: (e) => seen.push(e.kind),
      }),
    );
    expect(seen).toContain("child_started");
    expect(seen).toContain("child_finished");
  });
});

describe("failure is named, never substituted", () => {
  test("no credentials maps to Denied", async () => {
    const result = await runExternalChild(
      baseInput(),
      baseDeps({ spawn: fakeSpawn(transcript("codex-cli", "not-logged-in.stdout.jsonl"), 1).port }),
    );
    expect(result.status).toBe("Denied");
    expect(result.isError).toBe(true);
  });

  test("a rejected command line maps to Error and quotes the CLI", async () => {
    const stderr = readFileSync(path.join(FIXTURES, "codex-cli", "bad-argv.stderr.txt"), "utf8").split("\n");
    const result = await runExternalChild(
      baseInput(),
      baseDeps({ spawn: fakeSpawn([], 2, stderr).port }),
    );
    expect(result.status).toBe("Error");
    expect(result.output).toContain("unexpected argument");
  });

  test("a successful run whose answer contains the word `error` is NOT a failure", async () => {
    // The classifier trap: the model's own prose is not evidence about the process.
    const result = await runExternalChild(
      baseInput(),
      baseDeps({ spawn: fakeSpawn(transcript("codex-cli", "error-word.stdout.jsonl")).port }),
    );
    expect(result.status).toBe("Completed");
    expect(result.output).toContain("error: nothing is actually wrong");
  });

  test("an empty transcript is an Error, not a silent success", async () => {
    // The silent no-op shape: exit 0, zero bytes, no terminal event.
    const result = await runExternalChild(baseInput(), baseDeps({ spawn: fakeSpawn([]).port }));
    expect(result.status).toBe("Error");
    expect(result.isError).toBe(true);
  });

  test("no fallback occurs — the failing agent's own status is returned", async () => {
    const sp = fakeSpawn(transcript("codex-cli", "not-logged-in.stdout.jsonl"), 1);
    const result = await runExternalChild(baseInput(), baseDeps({ spawn: sp.port }));
    expect(result.status).not.toBe("Completed");
    // Exactly one process was created: nothing was retried with another agent.
    expect(sp.calls).toHaveLength(1);
  });
});

describe("the worktree is removed on every path", () => {
  test("after a successful run", async () => {
    const wt = fakeWorktree();
    await runExternalChild(
      baseInput(),
      baseDeps({ worktree: wt.port, spawn: fakeSpawn(transcript("codex-cli", "success.stdout.jsonl")).port }),
    );
    expect(wt.removed).toEqual(["wt-1"]);
  });

  test("after a failed run", async () => {
    const wt = fakeWorktree();
    await runExternalChild(
      baseInput(),
      baseDeps({ worktree: wt.port, spawn: fakeSpawn(transcript("codex-cli", "not-logged-in.stdout.jsonl"), 1).port }),
    );
    expect(wt.removed).toEqual(["wt-1"]);
  });

  test("even when the spawn port throws", async () => {
    // A leaked worktree is a leaked escape hatch: containment rests on that
    // directory being disposable.
    const wt = fakeWorktree();
    const throwing: ExternalSpawnPort = {
      spawn() {
        throw new Error("port is broken");
      },
    };
    await expect(runExternalChild(baseInput(), baseDeps({ worktree: wt.port, spawn: throwing }))).rejects.toThrow(
      "port is broken",
    );
    expect(wt.removed).toEqual(["wt-1"]);
  });

  test("a failing remove does not mask the run's real result", async () => {
    const wt = fakeWorktree();
    const port: WorktreePort = { ...wt.port, remove: async () => Promise.reject(new Error("rm failed")) };
    const result = await runExternalChild(
      baseInput(),
      baseDeps({ worktree: port, spawn: fakeSpawn(transcript("codex-cli", "success.stdout.jsonl")).port }),
    );
    expect(result.status).toBe("Completed");
  });
});

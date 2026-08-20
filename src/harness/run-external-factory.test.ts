// Tests for the `runExternal` factory (flow 176, T15).
//
// OFFLINE AND STRUCTURALLY SO. Both impure seams — the process spawn and the git
// worktree — are fakes, so a complete dispatch runs with neither `codex` nor
// `claude` installed and no subprocess created. A suite that spawned a real
// vendor CLI would spend the operator's paid subscription on every `bun test`,
// which is precisely why both are injected rather than imported.
//
// The transcript fed to the fake port is the REAL recorded one from
// `fixtures/external/`, so the success path is proven against genuine vendor
// bytes rather than against what the author imagined the CLI emits.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { EXTERNAL_AGENTS_DEFAULTS, type ExternalAgentsConfig } from "../capability/external-agents";
import type { CreatedWorktree, WorktreeMergeResult, WorktreePort } from "./child/worktree";
import { ENV_EXTERNAL_DEPTH } from "./external/env";
import type { ExternalSpawnOptions, ExternalSpawnPort, SpawnedProcess } from "./external/supervise";
import {
  createRunExternal,
  type CreateRunExternalOptions,
  type RunExternalRequest,
} from "./run-external-factory";

const FIXTURES = fileURLToPath(new URL("../../fixtures/external/", import.meta.url));

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

function fakeSpawn(stdout: readonly string[] = [], exitCode = 0): FakeSpawn {
  const calls: Array<{ argv: readonly string[]; opts: ExternalSpawnOptions }> = [];
  return {
    calls,
    port: {
      spawn(argv, opts): SpawnedProcess {
        calls.push({ argv, opts });
        return {
          stdout: lines(stdout),
          stderr: lines([]),
          writeStdin: () => undefined,
          kill: () => undefined,
          exited: Promise.resolve(exitCode),
        };
      },
    },
  };
}

interface FakeWorktree {
  readonly port: WorktreePort;
  readonly created: string[];
  readonly removed: string[];
}

function fakeWorktree(): FakeWorktree {
  const created: string[] = [];
  const removed: string[] = [];
  return {
    created,
    removed,
    port: {
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
    },
  };
}

const ENABLED: ExternalAgentsConfig = {
  ...EXTERNAL_AGENTS_DEFAULTS,
  enabled: true,
  // `allow` in most tests so the approval path is exercised only where it is the
  // subject; `ask` is the shipped default and has its own tests below.
  spawnDecision: "allow",
};

function request(overrides: Partial<RunExternalRequest> = {}): RunExternalRequest {
  return {
    runtime: { kind: "external", agent: "codex-cli", sandbox: "read-only" },
    task: "Find why the resume suite is flaky.",
    mode: "read_only",
    workerId: "sub:11111111-2222-3333-4444-555555555555",
    label: "flake-hunt",
    ...overrides,
  };
}

function options(overrides: Partial<CreateRunExternalOptions> = {}): CreateRunExternalOptions {
  return {
    cwd: "/nonexistent-project-root",
    env: { PATH: "/usr/bin" },
    config: ENABLED,
    spawn: fakeSpawn().port,
    worktree: fakeWorktree().port,
    readWorkingDiff: async () => undefined,
    idSeq: () => "session-fixed",
    ...overrides,
  };
}

describe("the factory returns no hook at all when the capability is unavailable", () => {
  test("disabled config yields undefined and a named reason", async () => {
    const reasons: string[] = [];
    const hook = await createRunExternal(
      options({ config: EXTERNAL_AGENTS_DEFAULTS, onUnavailable: (reason) => reasons.push(reason) }),
    );
    expect(hook).toBeUndefined();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("externalAgents.enabled");
  });

  test("a remote transport yields undefined even with an enabled config", async () => {
    const reasons: string[] = [];
    const hook = await createRunExternal(
      options({ transport: "remote", onUnavailable: (reason) => reasons.push(reason) }),
    );
    expect(hook).toBeUndefined();
    expect(reasons[0]).toContain("remote transport");
  });

  test("CI yields undefined even with an enabled config", async () => {
    const reasons: string[] = [];
    const hook = await createRunExternal(
      options({ env: { PATH: "/usr/bin", CI: "true" }, onUnavailable: (reason) => reasons.push(reason) }),
    );
    expect(hook).toBeUndefined();
    expect(reasons[0]).toContain("CI");
  });

  test("no spawn and no worktree are ever touched on the unavailable path", async () => {
    const sp = fakeSpawn();
    const wt = fakeWorktree();
    const hook = await createRunExternal(
      options({ config: EXTERNAL_AGENTS_DEFAULTS, spawn: sp.port, worktree: wt.port }),
    );
    expect(hook).toBeUndefined();
    expect(sp.calls).toHaveLength(0);
    expect(wt.created).toHaveLength(0);
  });
});

describe("the closure refuses with a named reason, never silently", () => {
  test("a runtime block that is not external is Denied", async () => {
    const hook = await createRunExternal(options());
    expect(hook).toBeDefined();
    const result = await hook?.(request({ runtime: { kind: "keryx" } }));
    expect(result?.status).toBe("Denied");
    expect(result?.output).toContain("not an external runtime block");
  });

  test("a missing runtime block is Denied", async () => {
    const hook = await createRunExternal(options());
    const result = await hook?.(request({ runtime: undefined }));
    expect(result?.status).toBe("Denied");
    expect(result?.isError).toBe(true);
  });

  test("an agent disabled in the user config is Denied by name, before any spawn", async () => {
    const sp = fakeSpawn();
    const wt = fakeWorktree();
    const hook = await createRunExternal(
      options({
        spawn: sp.port,
        worktree: wt.port,
        config: { ...ENABLED, agents: { "codex-cli": { enabled: false, model: null } } },
      }),
    );
    const result = await hook?.(request());
    expect(result?.status).toBe("Denied");
    expect(result?.output).toContain("codex-cli");
    expect(sp.calls).toHaveLength(0);
    expect(wt.created).toHaveLength(0);
  });

  test("an unknown agent is Denied by the runtime's own validator", async () => {
    const hook = await createRunExternal(options());
    const result = await hook?.(
      request({ runtime: { kind: "external", agent: "not-an-agent", sandbox: "read-only" } }),
    );
    expect(result?.status).toBe("Denied");
    expect(result?.output).toContain("not-an-agent");
  });
});

describe("spawnDecision: ask is fail-closed", () => {
  test("with no approver wired, every model-initiated spawn is Denied and says why", async () => {
    const sp = fakeSpawn();
    const hook = await createRunExternal(options({ config: { ...ENABLED, spawnDecision: "ask" }, spawn: sp.port }));
    const result = await hook?.(request());
    expect(result?.status).toBe("Denied");
    expect(result?.output).toContain("spawnDecision");
    expect(sp.calls).toHaveLength(0);
  });

  test("a declining approver Denies, and the approver sees the agent and the task", async () => {
    const seen: unknown[] = [];
    const hook = await createRunExternal(
      options({
        config: { ...ENABLED, spawnDecision: "ask" },
        approve: async (req) => {
          seen.push(req);
          return false;
        },
      }),
    );
    const result = await hook?.(request());
    expect(result?.status).toBe("Denied");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ agentId: "codex-cli", label: "flake-hunt" });
  });

  test("an approver that throws has not approved anything", async () => {
    const hook = await createRunExternal(
      options({
        config: { ...ENABLED, spawnDecision: "ask" },
        approve: async () => {
          throw new Error("modal closed");
        },
      }),
    );
    const result = await hook?.(request());
    expect(result?.status).toBe("Denied");
  });

  test("spawnDecision: allow never consults an approver", async () => {
    let asked = 0;
    const hook = await createRunExternal(
      options({
        spawn: fakeSpawn(transcript("codex-cli", "success.stdout.jsonl")).port,
        approve: async () => {
          asked += 1;
          return true;
        },
      }),
    );
    await hook?.(request());
    expect(asked).toBe(0);
  });
});

describe("a complete run", () => {
  test("folds a recorded transcript onto spawn_subagent's result shape", async () => {
    const wt = fakeWorktree();
    const hook = await createRunExternal(
      options({ spawn: fakeSpawn(transcript("codex-cli", "success.stdout.jsonl")).port, worktree: wt.port }),
    );
    const result = await hook?.(request());
    // This fixture's plain-text answer ("ok") is not valid JSON, so the
    // underlying runtime's AC13 structured-result validation (flow 176 T20)
    // turns it into a named Error rather than a silent "Completed" — see
    // `runtime.test.ts`'s "structured result validation (AC13)" for the
    // Completed/invalid-JSON/invalid-schema matrix. What this test still pins:
    // a recorded transcript folds through the factory to a non-empty,
    // non-silent result.
    expect(result?.status).toBe("Error");
    expect(result?.isError).toBe(true);
    expect(result?.output.length).toBeGreaterThan(0);
    // The worktree is created and removed on the terminal path: containment
    // rests on that directory being disposable.
    expect(wt.created).toHaveLength(1);
    expect(wt.removed).toEqual(wt.created);
  });

  test("the worktree id is filesystem-safe even though worker ids carry a colon", async () => {
    const wt = fakeWorktree();
    const hook = await createRunExternal(
      options({ spawn: fakeSpawn(transcript("codex-cli", "success.stdout.jsonl")).port, worktree: wt.port }),
    );
    await hook?.(request());
    expect(wt.created[0]).not.toContain(":");
    expect(wt.created[0]).toMatch(/^ext-[A-Za-z0-9._-]+$/);
  });

  test("the full outcome — argv, cost, parse skips — reaches onOutcome, not the parent's output", async () => {
    const sp = fakeSpawn(transcript("codex-cli", "success.stdout.jsonl"));
    let argv: readonly string[] | undefined;
    const hook = await createRunExternal(
      options({ spawn: sp.port, onOutcome: (outcome) => (argv = outcome.argv) }),
    );
    const result = await hook?.(request());
    expect(argv).toBeDefined();
    expect(argv?.[0]).toBe("codex");
    expect(result?.output).not.toContain("codex exec");
  });

  test("the child environment is stripped and carries the depth marker one level deeper", async () => {
    const sp = fakeSpawn(transcript("codex-cli", "success.stdout.jsonl"));
    const hook = await createRunExternal(
      options({
        spawn: sp.port,
        env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-should-be-stripped", KERYX_SESSION: "parent" },
      }),
    );
    await hook?.(request());
    const env = sp.calls[0]?.opts.env ?? {};
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.KERYX_SESSION).toBeUndefined();
    expect(env[ENV_EXTERNAL_DEPTH]).toBe("1");
  });

  test("an inherited depth marker at the cap refuses to nest, and spawns nothing", async () => {
    const sp = fakeSpawn(transcript("codex-cli", "success.stdout.jsonl"));
    const hook = await createRunExternal(
      options({ spawn: sp.port, env: { PATH: "/usr/bin", [ENV_EXTERNAL_DEPTH]: "1" } }),
    );
    const result = await hook?.(request());
    expect(result?.status).toBe("Denied");
    expect(result?.output).toContain("depth cap");
    expect(sp.calls).toHaveLength(0);
  });

  test("the config's model is used when the dispatch pins none, and neither pins one by default", async () => {
    const withModel = fakeSpawn(transcript("codex-cli", "success.stdout.jsonl"));
    const hookWithModel = await createRunExternal(
      options({
        spawn: withModel.port,
        config: { ...ENABLED, agents: { "codex-cli": { enabled: true, model: "gpt-x" } } },
      }),
    );
    await hookWithModel?.(request());
    expect(withModel.calls[0]?.argv).toContain("gpt-x");

    // The default is to pin NOTHING: keryx must never name a model the
    // operator's subscription may not cover.
    const noModel = fakeSpawn(transcript("codex-cli", "success.stdout.jsonl"));
    const hookNoModel = await createRunExternal(options({ spawn: noModel.port }));
    await hookNoModel?.(request());
    expect(noModel.calls[0]?.argv).not.toContain("-m");
  });

  test("a dispatch's own model wins over the config's", async () => {
    const sp = fakeSpawn(transcript("codex-cli", "success.stdout.jsonl"));
    const hook = await createRunExternal(
      options({
        spawn: sp.port,
        config: { ...ENABLED, agents: { "codex-cli": { enabled: true, model: "from-config" } } },
      }),
    );
    await hook?.(request({ runtime: { kind: "external", agent: "codex-cli", sandbox: "read-only", model: "from-dispatch" } }));
    expect(sp.calls[0]?.argv).toContain("from-dispatch");
    expect(sp.calls[0]?.argv).not.toContain("from-config");
  });

  test("a probe reporting a missing binary Denies before the worktree is created", async () => {
    const wt = fakeWorktree();
    const hook = await createRunExternal(
      options({ worktree: wt.port, detect: async () => ({ binaryFound: false }) }),
    );
    const result = await hook?.(request());
    expect(result?.status).toBe("Denied");
    expect(result?.output).toContain("not installed");
    expect(wt.created).toHaveLength(0);
  });

  test("a throwing worktree port surfaces as a named Error, not as an exception", async () => {
    const hook = await createRunExternal(
      options({
        worktree: {
          create: async () => {
            throw new Error("git worktree add failed");
          },
          remove: async () => undefined,
          merge: async (id) => ({ worktreeId: id, ok: true }),
        },
      }),
    );
    const result = await hook?.(request());
    expect(result?.status).toBe("Error");
    expect(result?.output).toContain("git worktree add failed");
  });
});

// --- Flow 176 T18: the run-scoped observer ---------------------------------
// The four flat callbacks are FACTORY-scoped — one closure serves every
// dispatch — so an event arriving through them cannot say which child produced
// it. The operator surface keys everything on the run id, and without one a
// second run's transcript appends to the first one's record.
describe("the run-scoped observer", () => {
  test("every signal carries the run id, and the flat callbacks still fire", async () => {
    const flat: string[] = [];
    const seen: Array<[string, string]> = [];
    const starts: unknown[] = [];
    const hook = await createRunExternal(
      options({
        spawn: fakeSpawn(transcript("codex-cli", "success.stdout.jsonl")).port,
        onEvent: () => flat.push("event"),
        onOutcome: () => flat.push("outcome"),
        observer: {
          onStart: (run) => starts.push(run),
          onEvent: (id, event) => seen.push([id, event.kind]),
          onOutcome: (id) => seen.push([id, "outcome"]),
          onResult: (id) => seen.push([id, "result"]),
        },
      }),
    );
    const result = await hook?.(request());
    // This fixture's plain-text answer fails AC13's structured-result
    // validation (a separate concern from the observer signals this test
    // targets); it only asserts the run was not denied outright.
    expect(result?.status).not.toBe("Denied");
    expect(flat.length).toBeGreaterThan(0);
    const ids = new Set(seen.map(([id]) => id));
    expect([...ids]).toEqual(["sub:11111111-2222-3333-4444-555555555555"]);
    expect(seen.some(([, kind]) => kind === "outcome")).toBe(true);
    expect(seen.some(([, kind]) => kind === "result")).toBe(true);
    // Announced twice on purpose: once as soon as the agent is known (so a
    // pre-launch refusal is attributable), once after the model is resolved.
    expect(starts.length).toBeGreaterThanOrEqual(1);
    expect(starts[0]).toMatchObject({
      runId: "sub:11111111-2222-3333-4444-555555555555",
      agentId: "codex-cli",
      label: "flake-hunt",
    });
  });

  test("a refusal that never reached a process is still reported to the observer", async () => {
    const seen: unknown[] = [];
    const hook = await createRunExternal(
      options({
        config: { ...ENABLED, spawnDecision: "ask" },
        observer: { onResult: (id, result) => seen.push([id, result.status]) },
      }),
    );
    const result = await hook?.(request());
    expect(result?.status).toBe("Denied");
    // A silent no-op is the one failure mode security-policy §5 forbids: the
    // operator must be able to see that a dispatch did not happen.
    expect(seen).toEqual([["sub:11111111-2222-3333-4444-555555555555", "Denied"]]);
  });

  test("an approver may refuse with its OWN sentence, and that sentence reaches the caller", async () => {
    const hook = await createRunExternal(
      options({
        config: { ...ENABLED, spawnDecision: "ask" },
        approve: async () => ({ ok: false, reason: "this host has no way to ask" }),
      }),
    );
    const result = await hook?.(request());
    expect(result?.status).toBe("Denied");
    // "nobody could be asked" and "you said no" are different facts.
    expect(result?.output).toBe("this host has no way to ask");
  });

  test("the object approval form is accepted alongside the boolean one", async () => {
    const sp = fakeSpawn(transcript("codex-cli", "success.stdout.jsonl"));
    const hook = await createRunExternal(
      options({
        config: { ...ENABLED, spawnDecision: "ask" },
        spawn: sp.port,
        approve: async () => ({ ok: true }),
      }),
    );
    const result = await hook?.(request());
    // This fixture's plain-text answer fails AC13's structured-result
    // validation, a separate concern from the approval-form acceptance this
    // test targets; it only asserts the run was not denied outright.
    expect(result?.status).not.toBe("Denied");
    expect(sp.calls).toHaveLength(1);
  });

  test("the approver is told which run it is being asked about", async () => {
    const seen: unknown[] = [];
    const hook = await createRunExternal(
      options({
        config: { ...ENABLED, spawnDecision: "ask" },
        approve: async (req) => {
          seen.push(req.workerId);
          return false;
        },
      }),
    );
    await hook?.(request());
    // `/delegate` recognises its own run by this id and does not re-ask.
    expect(seen).toEqual(["sub:11111111-2222-3333-4444-555555555555"]);
  });
});

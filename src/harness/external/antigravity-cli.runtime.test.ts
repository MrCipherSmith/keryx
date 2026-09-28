// End-to-end tests for `antigravity-cli` through `runExternalChild` (flow 357,
// AC3/AC5/AC7). Offline: the process seam and the git worktree are both fakes,
// exercising the REAL recorded transcript in
// `fixtures/external/live/antigravity-cli/2026-09-28/read-only-ok.stream.jsonl`
// with no `agy` installed — same shape as `runtime.test.ts`.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import type { CreatedWorktree, WorktreeMergeResult, WorktreePort } from "../child/worktree";
import type { RuntimeBlock } from "./dispatch";
import { runExternalChild, type RunExternalChildDeps, type RunExternalChildInput } from "./runtime";
import type { ExternalSpawnOptions, ExternalSpawnPort, SpawnedProcess } from "./supervise";

const LIVE_FIXTURE = fileURLToPath(
  new URL("../../../fixtures/external/live/antigravity-cli/2026-09-28/read-only-ok.stream.jsonl", import.meta.url),
);

function transcript(): string[] {
  return readFileSync(LIVE_FIXTURE, "utf8")
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

const EXTERNAL: RuntimeBlock = { kind: "external", agent: "antigravity-cli", sandbox: "read-only" };

function baseInput(overrides: Partial<RunExternalChildInput> = {}): RunExternalChildInput {
  return {
    runtime: EXTERNAL,
    allowedActions: ["read"],
    taskTitle: "Say OK",
    taskDescription: "Reply with the single word OK and nothing else. Do not use any tools.",
    acceptanceCriteria: [],
    worktreeId: "wt-antigravity-1",
    maxPromptBytes: 65536,
    timeoutMs: 60_000,
    parentEnv: { PATH: "/usr/bin", HOME: "/home/op", GOOGLE_API_KEY: "goog-secret" },
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

describe("AC3: replaying the recorded live transcript through the real runtime", () => {
  test("the codec itself classifies the replayed transcript as completed, response OK, usage and conversation id survive", async () => {
    // `runExternalChild`'s own AC13 gate then requires a COMPLETED run's final
    // text to be a valid `subagent-result` JSON document — this fixture's `agy`
    // was asked for the bare word `OK`, so the FULL pipeline reports `Error`
    // with `partial: "OK"`, exactly like codex's own plain-text
    // `success.stdout.jsonl` does (see this same assertion two tests below).
    // AC3's "outcome completed, response OK" is the CODEC's own classification
    // (`classifyAntigravityFailure` returns `null`), asserted directly against
    // the parsed events in `codec/antigravity-cli.test.ts` — this test instead
    // pins what the shared runtime around it does with that same transcript.
    const sp = fakeSpawn(transcript(), 0);
    const wt = fakeWorktree();
    const result = await runExternalChild(baseInput(), baseDeps({ spawn: sp.port, worktree: wt.port }));

    expect(result.status).toBe("Error");
    expect(result.partial).toBe("OK");
    expect(result.costUnits).toBeUndefined(); // antigravity-cli reportsCost: false
    expect(result.sessionRef).toBe("235ab503-43b5-4e17-8bde-52f903ccd7a7");
    expect(result.skippedLines).toBe(0);

    // Ran in the disposable worktree, never the operator's own tree.
    expect(wt.created).toEqual(["wt-antigravity-1"]);
    expect(wt.removed).toEqual(["wt-antigravity-1"]);
    expect(sp.calls[0]?.opts.cwd).toBe("/wt/wt-antigravity-1");
  });

  test("the argv sent to the spawn port is agy's, never claude's or codex's", async () => {
    const sp = fakeSpawn(transcript(), 0);
    await runExternalChild(baseInput(), baseDeps({ spawn: sp.port }));
    const argv = sp.calls[0]?.argv ?? [];
    expect(argv[0]).toBe("agy");
    expect(argv).toContain("--sandbox");
    expect(argv).not.toContain("--dangerously-skip-permissions");
  });

  test("the recorded tool-denied transcript ends Denied, names the action, and scores no unrecognised line", async () => {
    const deniedFixture = path.join(path.dirname(LIVE_FIXTURE), "tool-denied.stream.jsonl");
    const deniedStderr = path.join(path.dirname(LIVE_FIXTURE), "tool-denied.stderr.txt");
    const stdout = readFileSync(deniedFixture, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const stderr = readFileSync(deniedStderr, "utf8").split("\n");
    const sp = fakeSpawn(stdout, 0, stderr);
    const result = await runExternalChild(baseInput(), baseDeps({ spawn: sp.port }));

    expect(result.status).toBe("Denied");
    expect(result.output).toContain("command (RunCommand)");
    expect(result.output).not.toContain("dangerously");
    expect(result.skippedLines).toBe(0);
  });
});

describe("AC5: no credential and no Google config-dir path reaches the child or this codebase", () => {
  test("a fake spawn run's env carries no Google/OpenAI/Anthropic credential, only HOME/PATH", async () => {
    const sp = fakeSpawn(transcript(), 0);
    await runExternalChild(
      baseInput({
        parentEnv: {
          PATH: "/usr/bin",
          HOME: "/home/op",
          GOOGLE_API_KEY: "goog-secret",
          GEMINI_API_KEY: "gm-secret",
          OPENAI_API_KEY: "sk-openai-secret",
          ANTHROPIC_API_KEY: "sk-ant-secret",
        },
      }),
      baseDeps({ spawn: sp.port }),
    );
    const env = sp.calls[0]?.opts.env ?? {};
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/op");
    for (const key of ["GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
      expect(env).not.toHaveProperty(key);
    }
  });

  test("no argv element or env value names ~/.gemini/antigravity-cli — keryx never touches it", async () => {
    const sp = fakeSpawn(transcript(), 0);
    await runExternalChild(
      baseInput({ parentEnv: { PATH: "/usr/bin", HOME: "/home/op" } }),
      baseDeps({ spawn: sp.port }),
    );
    const call = sp.calls[0];
    expect(call).toBeDefined();
    const haystack = [...(call?.argv ?? []), ...Object.values(call?.opts.env ?? {})].join("\n");
    expect(haystack).not.toContain(".gemini/antigravity-cli");
  });

  test("this codec's and this runtime's own source never reference ~/.gemini/antigravity-cli", () => {
    const codecSource = readFileSync(path.join(import.meta.dir, "codec", "antigravity-cli.ts"), "utf8");
    const registrySource = readFileSync(path.join(import.meta.dir, "registry.ts"), "utf8");
    for (const source of [codecSource, registrySource]) {
      expect(source).not.toContain(".gemini/antigravity-cli");
      expect(source).not.toContain("~/.gemini");
    }
  });
});

describe("AC7: sandbox scope", () => {
  test("a worktree-write dispatch is refused with not-implemented, and nothing is spawned", async () => {
    const sp = fakeSpawn([]);
    const wt = fakeWorktree();
    const result = await runExternalChild(
      baseInput({ runtime: { ...EXTERNAL, sandbox: "worktree-write" }, allowedActions: ["read"] }),
      baseDeps({ spawn: sp.port, worktree: wt.port }),
    );
    expect(result.status).toBe("Denied");
    expect(result.output).toContain("not implemented in this release");
    expect(sp.calls).toHaveLength(0);
    expect(wt.created).toHaveLength(0);
  });

  test("a read-only dispatch runs in the disposable worktree and produces no patch artifact", async () => {
    const sp = fakeSpawn(transcript(), 0);
    const wt = fakeWorktree();
    const result = await runExternalChild(baseInput(), baseDeps({ spawn: sp.port, worktree: wt.port }));
    // See the AC3 test above for why this is `Error`/`partial: "OK"` rather
    // than `Completed` through the full pipeline (AC13's structured-result
    // gate). The point of this test is the ABSENCE of a patch artifact.
    expect(result.status).toBe("Error");
    expect(result.partial).toBe("OK");
    expect(result.acp).toBeUndefined(); // no ACP record — this is the line-stream transport
    expect(wt.created).toEqual(["wt-antigravity-1"]);
  });
});

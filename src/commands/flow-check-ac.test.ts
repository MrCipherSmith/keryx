import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../flow/service";
import type { FlowServiceDeps } from "../flow/types";
import {
  acCheckCachePath,
  createFixtureConformPrPort,
  readAcCheckCache,
  resolveDiffAgainstBase,
  runCheckAc,
  writeAcCheckCache,
  type GitSpawn,
} from "./flow-check-ac";

function deps(): FlowServiceDeps {
  return { tracker: null, healthGate: async () => ({ status: "pass", reasons: [] }), now: () => new Date("2026-09-25T00:00:00Z") };
}

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

async function realRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-check-ac-cli-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  await git(root, ["config", "user.name", "fixture"]);
  return root;
}

const CRITERIA = [
  "- AC1: `src/flow/check-ac.ts` implements the checker, evidence in the diff.",
  "- AC2: Live check (run with `env -u OPENROUTER_API_KEY`) — confirms the real endpoint.",
  "- AC3: `src/nowhere/absent.ts` does something this diff never touches.",
].join("\n");

async function frozenFlow(root: string, title: string): Promise<string> {
  const service = createFlowService(deps());
  const created = await service.init({ cwd: root, title });
  const dir = path.basename(created.dir);
  await writeFile(path.join(root, ".metaproject", "flows", dir, "acceptance-criteria.md"), `# Acceptance Criteria\n\n## Criteria\n\n${CRITERIA}\n`, "utf8");
  await service.freeze({ cwd: root, id: dir });
  return dir;
}

/** A fake `GitSpawn` answering `merge-base` and `diff` with a fixed diff text, never touching a real network. */
function fakeGitSpawn(diffText: string): GitSpawn & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (argv: readonly string[]) => {
    calls.push([...argv]);
    if (argv[1] === "merge-base") {
      return { stdout: "deadbeef\n", stderr: "", exitCode: 0 };
    }
    if (argv[1] === "diff") {
      return { stdout: diffText, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "unknown git subcommand", exitCode: 1 };
  }) as GitSpawn & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

const DIFF_WITH_CHECK_AC = [
  "diff --git a/src/flow/check-ac.ts b/src/flow/check-ac.ts",
  "index 0000000..1111111 100644",
  "--- a/src/flow/check-ac.ts",
  "+++ b/src/flow/check-ac.ts",
  "@@ -1,1 +1,2 @@",
  " export {};",
  "+export const x = 1;",
  "",
].join("\n");

describe("resolveDiffAgainstBase", () => {
  test("diffs against the merge base, not the ref directly", async () => {
    const spawn = fakeGitSpawn(DIFF_WITH_CHECK_AC);
    const diff = await resolveDiffAgainstBase(spawn, "origin/main");
    expect(diff).toBe(DIFF_WITH_CHECK_AC);
    expect(spawn.calls[0]).toEqual(["git", "merge-base", "HEAD", "origin/main"]);
    expect(spawn.calls[1]).toEqual(["git", "diff", "--no-color", "-U20", "deadbeef"]);
  });

  test("falls back to the ref itself when merge-base fails, and throws when diff fails", async () => {
    const spawn: GitSpawn = async (argv) => {
      if (argv[1] === "merge-base") return { stdout: "", stderr: "no merge base", exitCode: 1 };
      return { stdout: "", stderr: "bad ref", exitCode: 128 };
    };
    await expect(resolveDiffAgainstBase(spawn, "origin/main")).rejects.toThrow(/`git diff origin\/main` failed/);
  });
});

describe("cache round trip", () => {
  test("writes 0600 and reads back verbatim; a missing file reads undefined", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-check-ac-cache-"));
    try {
      const cachePath = acCheckCachePath(root, "001-fixture");
      expect(await readAcCheckCache(cachePath)).toBeUndefined();
      await writeAcCheckCache(cachePath, { key: "sha256:aaa:bbb", at: "2026-09-25T00:00:00Z", jevAsked: false, verdicts: [] });
      const read = await readAcCheckCache(cachePath);
      expect(read?.key).toBe("sha256:aaa:bbb");
      const mode = (await stat(cachePath)).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runCheckAc", () => {
  test("refuses when the flow is not frozen", async () => {
    const root = await realRepo();
    try {
      const service = createFlowService(deps());
      const created = await service.init({ cwd: root, title: "Unfrozen" });
      const dir = path.basename(created.dir);
      await expect(runCheckAc(root, dir, {}, { gitSpawn: fakeGitSpawn(DIFF_WITH_CHECK_AC) })).rejects.toThrow(/not frozen/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("without the opt-in: deterministic evidence only, Jev never asked, not-checkable separated", async () => {
    const root = await realRepo();
    try {
      const dir = await frozenFlow(root, "No opt-in");
      const result = await runCheckAc(root, dir, {}, { gitSpawn: fakeGitSpawn(DIFF_WITH_CHECK_AC) });
      expect(result.jevAsked).toBe(false);
      const byId = Object.fromEntries(result.verdicts.map((v) => [v.id, v]));
      expect(byId.AC1?.status).toBe("not-evident"); // facts-only degrade, no model call
      expect(byId.AC2?.status).toBe("not-checkable");
      expect(byId.AC2?.notCheckableReason).toMatch(/live check/);
      expect(byId.AC3?.status).toBe("not-evident");
      expect(result.cached).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("with the opt-in and a credential: Jev is asked, and a repeat call hits the cache without asking again", async () => {
    const root = await realRepo();
    try {
      const dir = await frozenFlow(root, "Opt-in");
      await mkdir(path.join(root, ".metaproject"), { recursive: true });
      await writeFile(path.join(root, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { ac_check: true } } }));

      let fetchCalls = 0;
      const fetchFn = (async () => {
        fetchCalls += 1;
        return new Response(
          JSON.stringify({ answers: { AC1: { type: "noul", noul: 0.9 }, AC3: { type: "noul", noul: 0.1 } }, usage: { input_tokens: 10, output_tokens: 5, cost: 0.001 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const env = { OPENROUTER_API_KEY: "sk-or-fixture-key" };
      const first = await runCheckAc(root, dir, {}, { gitSpawn: fakeGitSpawn(DIFF_WITH_CHECK_AC), fetchFn, env });
      expect(first.jevAsked).toBe(true);
      expect(first.cached).toBe(false);
      const byId = Object.fromEntries(first.verdicts.map((v) => [v.id, v]));
      expect(byId.AC1?.status).toBe("likely-met");
      expect(byId.AC1?.probability).toBeCloseTo(0.9);
      expect(byId.AC3?.status).toBe("not-evident");
      expect(byId.AC2?.status).toBe("not-checkable");
      expect(fetchCalls).toBe(1);

      const second = await runCheckAc(root, dir, {}, { gitSpawn: fakeGitSpawn(DIFF_WITH_CHECK_AC), fetchFn, env });
      expect(second.cached).toBe(true);
      expect(fetchCalls).toBe(1); // cache hit — no second Jev call
      expect(second.verdicts).toEqual(first.verdicts);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a Jev failure degrades to facts-only and is never fatal", async () => {
    const root = await realRepo();
    try {
      const dir = await frozenFlow(root, "Jev fails");
      await mkdir(path.join(root, ".metaproject"), { recursive: true });
      await writeFile(path.join(root, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { ac_check: true } } }));
      const fetchFn = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
      const result = await runCheckAc(
        root,
        dir,
        {},
        { gitSpawn: fakeGitSpawn(DIFF_WITH_CHECK_AC), fetchFn, env: { OPENROUTER_API_KEY: "sk-or-fixture-key" } },
      );
      expect(result.jevAsked).toBe(true);
      expect(result.jevError).toBeDefined();
      const byId = Object.fromEntries(result.verdicts.map((v) => [v.id, v]));
      expect(byId.AC1?.status).toBe("not-evident");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--pr uses the fixture PR port's diff instead of git", async () => {
    const root = await realRepo();
    try {
      const dir = await frozenFlow(root, "PR mode");
      const prPort = createFixtureConformPrPort({ pr: { number: 42, title: "t", body: "b", diff: DIFF_WITH_CHECK_AC } });
      const spawn = fakeGitSpawn("SHOULD NOT BE USED");
      const result = await runCheckAc(root, dir, { pr: 42 }, { gitSpawn: spawn, prPort });
      expect(spawn.calls).toEqual([]);
      const byId = Object.fromEntries(result.verdicts.map((v) => [v.id, v]));
      expect(byId.AC1).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

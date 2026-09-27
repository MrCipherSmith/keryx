// Flow 347 T8: `spawn_subagent`'s optional per-call `cwd`.
//
// The incident this closes: a review ran the parent in a worktree checked out
// at a PR head, but the verifier child's tools and prompt resolved against the
// PARENT's cwd (the base branch), not the worktree the review was actually
// about. These tests pin the acceptance rule (project root / descendant /
// sibling git worktree, else refused) and that a refusal spawns nothing.
import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createSpawnSubagentTool } from "./spawn-subagent-tool";
import type { NormalizedEvent, NormalizedRequest, ProviderPort, StreamOptions } from "../../provider/types";

const execFileAsync = promisify(execFile);

const PROBE_CAPABILITIES = {
  streaming: true,
  toolCalls: false,
  parallelToolCalls: false,
  structuredOutput: false,
  reasoningMetadata: false,
  promptCaching: false,
  vision: false,
  tokenCounting: false,
  modelListing: false,
};

/** Records every request the child provider is sent, and answers with plain text. */
function recordingProvider(text: string): { provider: ProviderPort; requests: NormalizedRequest[] } {
  const requests: NormalizedRequest[] = [];
  return {
    requests,
    provider: {
      describe: () => ({ capabilities: PROBE_CAPABILITIES, descriptor: { providerId: "recording" } }),
      async *stream(request, opts: StreamOptions): AsyncGenerator<NormalizedEvent> {
        requests.push(request);
        yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text };
        yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
      },
    },
  };
}

function userLineOf(request: NormalizedRequest): string {
  return request.messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
}

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-subagent-cwd-"));
  cleanupDirs.push(dir);
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "root\n");
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  // A throwaway fixture: skip any commit hooks a developer's global git
  // template installs into every `git init`, so the test does not depend on them.
  await execFileAsync("git", ["commit", "-q", "--no-verify", "-m", "init"], { cwd: dir });
  return dir;
}

test("omitted cwd resolves the child's Project root to the parent's own cwd (unchanged behaviour)", async () => {
  const repo = await makeTempRepo();
  const { provider, requests } = recordingProvider("ok");
  const tool = createSpawnSubagentTool({
    cwd: repo,
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => provider,
    getDetectedProviders: () => [{ name: "ollama" }],
  });
  const result = await tool.invoke({ task: "look around", mode: "read_only" });
  expect(result.isError).toBe(false);
  expect(userLineOf(requests[0]!)).toContain(`Project root: ${repo}`);
});

test("a cwd that is a descendant of the project root is accepted and followed by the child", async () => {
  const repo = await makeTempRepo();
  const sub = path.join(repo, "packages", "app");
  await mkdir(sub, { recursive: true });
  const { provider, requests } = recordingProvider("ok");
  const tool = createSpawnSubagentTool({
    cwd: repo,
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => provider,
    getDetectedProviders: () => [{ name: "ollama" }],
  });
  const result = await tool.invoke({ task: "look around", mode: "read_only", cwd: sub });
  expect(result.isError).toBe(false);
  expect(userLineOf(requests[0]!)).toContain(`Project root: ${await realpath(sub)}`);
});

test("a cwd naming a git worktree of the project's own repository is accepted", async () => {
  const repo = await makeTempRepo();
  const worktreeDir = path.join(path.dirname(repo), `${path.basename(repo)}-review-pr-1`);
  cleanupDirs.push(worktreeDir);
  await execFileAsync("git", ["worktree", "add", "-b", "review-pr-1", worktreeDir], { cwd: repo });
  const { provider, requests } = recordingProvider("ok");
  const tool = createSpawnSubagentTool({
    cwd: repo,
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => provider,
    getDetectedProviders: () => [{ name: "ollama" }],
  });
  const result = await tool.invoke({ task: "verify the PR head", mode: "read_only", cwd: worktreeDir });
  expect(result.isError).toBe(false);
  expect(userLineOf(requests[0]!)).toContain(`Project root: ${await realpath(worktreeDir)}`);
  await execFileAsync("git", ["worktree", "remove", "--force", worktreeDir], { cwd: repo }).catch(() => {});
});

test("a relative cwd resolves against the parent's own cwd", async () => {
  const repo = await makeTempRepo();
  const sub = path.join(repo, "nested");
  await mkdir(sub, { recursive: true });
  const { provider, requests } = recordingProvider("ok");
  const tool = createSpawnSubagentTool({
    cwd: repo,
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => provider,
    getDetectedProviders: () => [{ name: "ollama" }],
  });
  const result = await tool.invoke({ task: "look around", mode: "read_only", cwd: "nested" });
  expect(result.isError).toBe(false);
  expect(userLineOf(requests[0]!)).toContain(`Project root: ${await realpath(sub)}`);
});

test("a nonexistent cwd is refused and nothing spawns", async () => {
  const repo = await makeTempRepo();
  const { provider, requests } = recordingProvider("ok");
  const tool = createSpawnSubagentTool({
    cwd: repo,
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => provider,
    getDetectedProviders: () => [{ name: "ollama" }],
  });
  const result = await tool.invoke({ task: "look around", mode: "read_only", cwd: path.join(repo, "does-not-exist") });
  expect(result.isError).toBe(true);
  expect(result.status).toBe("Error");
  expect(result.output).toMatch(/does not exist/);
  expect(requests.length).toBe(0);
});

test("a cwd outside the project root and not one of its worktrees is refused and nothing spawns", async () => {
  const repo = await makeTempRepo();
  const outsider = await makeTempRepo();
  const { provider, requests } = recordingProvider("ok");
  const tool = createSpawnSubagentTool({
    cwd: repo,
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => provider,
    getDetectedProviders: () => [{ name: "ollama" }],
  });
  const result = await tool.invoke({ task: "look around", mode: "read_only", cwd: outsider });
  expect(result.isError).toBe(true);
  expect(result.status).toBe("Error");
  expect(result.output).toMatch(/neither the project root/);
  expect(requests.length).toBe(0);
});

test("a non-string cwd is refused", async () => {
  const repo = await makeTempRepo();
  const { provider } = recordingProvider("ok");
  const tool = createSpawnSubagentTool({
    cwd: repo,
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => provider,
    getDetectedProviders: () => [{ name: "ollama" }],
  });
  const result = await tool.invoke({ task: "look around", mode: "read_only", cwd: 123 });
  expect(result.isError).toBe(true);
  expect(result.status).toBe("Error");
  expect(result.output).toMatch(/must be a string/);
});

test("cwd combined with an external runtime request is refused before the external hook runs", async () => {
  const repo = await makeTempRepo();
  let externalCalled = false;
  const tool = createSpawnSubagentTool({
    cwd: repo,
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => recordingProvider("ok").provider,
    getDetectedProviders: () => [{ name: "ollama" }],
    runExternal: async () => {
      externalCalled = true;
      return { status: "Completed", output: "should not run", isError: false };
    },
  });
  const result = await tool.invoke({
    task: "look around",
    mode: "read_only",
    cwd: repo,
    runtime: { kind: "external", agent: "codex", sandbox: "read-only" },
  });
  expect(result.isError).toBe(true);
  expect(result.status).toBe("Error");
  expect(result.output).toMatch(/not supported for external/);
  expect(externalCalled).toBe(false);
});

// Flow 347 T8: `spawn_subagent`'s optional per-call `cwd`.
//
// The incident this closes: a review ran the parent in a worktree checked out
// at a PR head, but the verifier child's tools and prompt resolved against the
// PARENT's cwd (the base branch), not the worktree the review was actually
// about. These tests pin the acceptance rule (project root / descendant /
// sibling git worktree, else refused) and that a refusal spawns nothing.
//
// Review F-001 decision: a directory INSIDE a verified linked worktree is
// accepted, exactly as a descendant of the project root is — the worktree is
// verified, and the child's tools stay confined beneath the accepted cwd.
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

/**
 * A tool-calling child: request 1 calls `toolName` with `input`, request 2
 * answers with text. Every request is recorded so a test can read the tool
 * result the child was actually sent.
 */
function toolCallingProvider(toolName: string, input: Record<string, unknown>): {
  provider: ProviderPort;
  requests: NormalizedRequest[];
} {
  const requests: NormalizedRequest[] = [];
  return {
    requests,
    provider: {
      describe: () => ({
        capabilities: { ...PROBE_CAPABILITIES, toolCalls: true },
        descriptor: { providerId: "tool-calling" },
      }),
      async *stream(request, opts: StreamOptions): AsyncGenerator<NormalizedEvent> {
        requests.push(request);
        const base = { attemptId: opts.attemptId };
        if (requests.length === 1) {
          yield { ...base, sequence: 0, kind: "tool_call_start", toolCallId: "t1", toolName } as NormalizedEvent;
          yield { ...base, sequence: 1, kind: "tool_call_end", toolCallId: "t1", input: JSON.stringify(input) } as NormalizedEvent;
          yield { ...base, sequence: 2, kind: "model_end" };
          return;
        }
        yield { ...base, sequence: 0, kind: "text_delta", text: "done" };
        yield { ...base, sequence: 1, kind: "model_end" };
      },
    },
  };
}

function toolResultsOf(request: NormalizedRequest | undefined): string[] {
  return (request?.messages ?? []).filter((m) => m.role === "tool").map((m) => m.content);
}

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

// --- Review F-003: the child's FILE TOOLS follow `cwd`, not only its prompt ---

function spawnToolFor(repo: string, provider: ProviderPort) {
  return createSpawnSubagentTool({
    cwd: repo,
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => provider,
    getDetectedProviders: () => [{ name: "ollama" }],
  });
}

test("F-003: read_file with a relative path reads the descendant cwd's file, not the parent root's", async () => {
  const repo = await makeTempRepo();
  const sub = path.join(repo, "packages", "app");
  await mkdir(sub, { recursive: true });
  await writeFile(path.join(repo, "probe.txt"), "PARENT-ROOT-COPY\n");
  await writeFile(path.join(sub, "probe.txt"), "DESCENDANT-CWD-COPY\n");
  await writeFile(path.join(sub, "only-here.txt"), "ONLY-UNDER-DESCENDANT\n");

  const same = toolCallingProvider("read_file", { path: "probe.txt" });
  expect((await spawnToolFor(repo, same.provider).invoke({ task: "read", mode: "read_only", cwd: sub })).isError).toBe(false);
  const [sameResult] = toolResultsOf(same.requests[1]);
  expect(sameResult).toContain("DESCENDANT-CWD-COPY");
  expect(sameResult).not.toContain("PARENT-ROOT-COPY");

  const only = toolCallingProvider("read_file", { path: "only-here.txt" });
  expect((await spawnToolFor(repo, only.provider).invoke({ task: "read", mode: "read_only", cwd: sub })).isError).toBe(false);
  expect(toolResultsOf(only.requests[1])[0]).toContain("ONLY-UNDER-DESCENDANT");
});

test("F-003: read_file and list_dir with relative paths follow a linked-worktree cwd", async () => {
  const repo = await makeTempRepo();
  const worktreeDir = path.join(path.dirname(repo), `${path.basename(repo)}-wt-f003`);
  cleanupDirs.push(worktreeDir);
  await execFileAsync("git", ["worktree", "add", "-q", "-b", "wt-f003", worktreeDir], { cwd: repo });
  await writeFile(path.join(repo, "probe.txt"), "PARENT-ROOT-COPY\n");
  await writeFile(path.join(worktreeDir, "probe.txt"), "WORKTREE-COPY\n");
  await writeFile(path.join(worktreeDir, "worktree-only.txt"), "x\n");

  const read = toolCallingProvider("read_file", { path: "probe.txt" });
  expect((await spawnToolFor(repo, read.provider).invoke({ task: "read", mode: "read_only", cwd: worktreeDir })).isError).toBe(false);
  const [readResult] = toolResultsOf(read.requests[1]);
  expect(readResult).toContain("WORKTREE-COPY");
  expect(readResult).not.toContain("PARENT-ROOT-COPY");

  const list = toolCallingProvider("list_dir", { path: "." });
  expect((await spawnToolFor(repo, list.provider).invoke({ task: "list", mode: "read_only", cwd: worktreeDir })).isError).toBe(false);
  expect(toolResultsOf(list.requests[1])[0]).toContain("worktree-only.txt");
});

// --- Review F-001: a listed worktree is a candidate, verified by reading files ---

test("F-001: a forged .git/worktrees/<id>/gitdir pointing at an outside repository is refused", async () => {
  const repo = await makeTempRepo();
  const outsider = await makeTempRepo(); // a real, non-prunable directory with its own .git
  const admin = path.join(repo, ".git", "worktrees", "forged");
  await mkdir(admin, { recursive: true });
  await writeFile(path.join(admin, "gitdir"), `${path.join(outsider, ".git")}\n`);
  await writeFile(path.join(admin, "commondir"), "../..\n");
  await writeFile(path.join(admin, "HEAD"), "ref: refs/heads/main\n");
  // The forgery is effective against a naive parser: git itself lists it.
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repo });
  expect(stdout).toContain(`worktree ${outsider}`);

  const { provider, requests } = recordingProvider("ok");
  const result = await spawnToolFor(repo, provider).invoke({ task: "look", mode: "read_only", cwd: outsider });
  expect(result.isError).toBe(true);
  expect(result.output).toMatch(/neither the project root/);
  expect(requests.length).toBe(0);
});

test("F-001: a forged gitdir pointing at a plain outside directory (prunable) is refused", async () => {
  const repo = await makeTempRepo();
  const outsider = await mkdtemp(path.join(tmpdir(), "keryx-subagent-outside-"));
  cleanupDirs.push(outsider);
  const admin = path.join(repo, ".git", "worktrees", "forged");
  await mkdir(admin, { recursive: true });
  await writeFile(path.join(admin, "gitdir"), `${path.join(outsider, ".git")}\n`);
  await writeFile(path.join(admin, "commondir"), "../..\n");
  await writeFile(path.join(admin, "HEAD"), "ref: refs/heads/main\n");

  const { provider, requests } = recordingProvider("ok");
  const result = await spawnToolFor(repo, provider).invoke({ task: "look", mode: "read_only", cwd: outsider });
  expect(result.isError).toBe(true);
  expect(requests.length).toBe(0);
});

test("F-001: a worktree path containing a newline cannot inject an extra accepted path", async () => {
  const repo = await makeTempRepo();
  const outsider = await mkdtemp(path.join(tmpdir(), "keryx-subagent-outside-"));
  cleanupDirs.push(outsider);
  const base = await mkdtemp(path.join(tmpdir(), "keryx-subagent-nl-"));
  cleanupDirs.push(base);
  const evil = path.join(base, `evil\nworktree ${outsider}`);
  try {
    await execFileAsync("git", ["worktree", "add", "-q", "-b", "nl-branch", evil], { cwd: repo });
  } catch {
    // This platform/filesystem (or git) cannot create a newline-bearing
    // worktree path; there is nothing to inject, so nothing to check.
    return;
  }
  const { provider, requests } = recordingProvider("ok");
  const refused = await spawnToolFor(repo, provider).invoke({ task: "look", mode: "read_only", cwd: outsider });
  expect(refused.isError).toBe(true);
  expect(refused.output).toMatch(/neither the project root/);
  expect(requests.length).toBe(0);
  // The genuine (newline-named) worktree itself is still a verified worktree.
  const accepted = await spawnToolFor(repo, provider).invoke({ task: "look", mode: "read_only", cwd: evil });
  expect(accepted.isError).toBe(false);
});

test("F-001: a subdirectory of a genuine linked worktree is accepted", async () => {
  const repo = await makeTempRepo();
  const worktreeDir = path.join(path.dirname(repo), `${path.basename(repo)}-wt-sub`);
  cleanupDirs.push(worktreeDir);
  await execFileAsync("git", ["worktree", "add", "-q", "-b", "wt-sub", worktreeDir], { cwd: repo });
  const inner = path.join(worktreeDir, "src", "deep");
  await mkdir(inner, { recursive: true });
  const { provider, requests } = recordingProvider("ok");
  const result = await spawnToolFor(repo, provider).invoke({ task: "look", mode: "read_only", cwd: inner });
  expect(result.isError).toBe(false);
  expect(userLineOf(requests[0]!)).toContain(`Project root: ${await realpath(inner)}`);
});

test("F-001: a linked worktree whose gitfile was redirected away from this repository is refused", async () => {
  const repo = await makeTempRepo();
  const other = await makeTempRepo();
  const worktreeDir = path.join(path.dirname(repo), `${path.basename(repo)}-wt-redirect`);
  cleanupDirs.push(worktreeDir);
  await execFileAsync("git", ["worktree", "add", "-q", "-b", "wt-redirect", worktreeDir], { cwd: repo });
  // The candidate's own `.git` no longer points back into this repository.
  await writeFile(path.join(worktreeDir, ".git"), `gitdir: ${path.join(other, ".git")}\n`);
  const { provider, requests } = recordingProvider("ok");
  const result = await spawnToolFor(repo, provider).invoke({ task: "look", mode: "read_only", cwd: worktreeDir });
  expect(result.isError).toBe(true);
  expect(requests.length).toBe(0);
});

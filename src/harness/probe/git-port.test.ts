import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createProbeGitPort } from "./git-port";
const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "probe-git-")); dirs.push(root);
  const git = (...args: string[]) => exec("git", args, { cwd: root });
  await git("init"); await git("config", "user.email", "probe-fixture@example.invalid"); await git("config", "user.name", "Fixture");
  await writeFile(path.join(root, "gold.json"), "answer"); await writeFile(path.join(root, "source.ts"), "export const source = 1;");
  await git("add", "."); await git("commit", "-m", "fixture");
  const commit = (await git("rev-parse", "HEAD")).stdout.trim();
  const options = { repoRoot: root, worktreesDir: path.join(root, ".probe-worktrees"), commit, probeId: "012345abcdef", turn: async () => ({ answer: "", events: [] }) };
  return { root, git, commit, options };
}
const task = { id: "one", kind: "deterministic" as const, prompt: "Locate source", expect: { file: "source.ts", symbol: "source" }, goldArtifacts: ["gold.json"] };
test("both arms pin commit and remove gold before any turn", async () => {
  const f = await fixture(); const port = createProbeGitPort(f.options);
  try {
    await port.reconcile(); const result = await port.prepare(task);
    expect(result.goldClean).toBe(true); expect(result.environmentMatches).toBe(true);
    for (const root of Object.values(result.roots)) {
      expect((await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim()).toBe(f.commit);
      expect(await Bun.file(path.join(root, "gold.json")).exists()).toBe(false);
      expect(await readFile(path.join(root, "source.ts"), "utf8")).toContain("source");
    }
  } finally { await port.cleanup(); }
  expect((await f.git("worktree", "list", "--porcelain")).stdout.match(/^worktree /gm)).toHaveLength(1);
});
test("missing base gold refuses preparation without creating arms", async () => {
  const f = await fixture(); const port = createProbeGitPort(f.options);
  const result = await port.prepare({ ...task, goldArtifacts: ["missing.json"] });
  expect(result.goldClean).toBe(false);
  expect((await f.git("worktree", "list", "--porcelain")).stdout.match(/^worktree /gm)).toHaveLength(1);
});
test("restarted adapter reconciles its own stale arms, never unrelated worktree", async () => {
  const f = await fixture(); const unrelated = path.join(f.root, "unrelated");
  await f.git("worktree", "add", "--detach", unrelated, f.commit);
  const first = createProbeGitPort(f.options); await first.prepare(task);
  const restarted = createProbeGitPort(f.options); await restarted.reconcile();
  expect((await f.git("worktree", "list", "--porcelain")).stdout.match(/^worktree /gm)).toHaveLength(2);
  expect(await Bun.file(path.join(unrelated, "source.ts")).exists()).toBe(true);
});
test("unsafe probe identity is rejected before filesystem operations", async () => {
  const f = await fixture();
  expect(() => createProbeGitPort({ ...f.options, probeId: "../other" })).toThrow();
});
test("gold path traversal is rejected without deleting repository files", async () => {
  const f = await fixture(); const port = createProbeGitPort(f.options);
  await expect(port.prepare({ ...task, goldArtifacts: ["../source.ts"] })).rejects.toThrow();
  expect(await Bun.file(path.join(f.root, "source.ts")).exists()).toBe(true);
});

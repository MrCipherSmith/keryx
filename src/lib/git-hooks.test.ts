import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { resolveGitHooksRoot } from "./git-hooks";
import { uniqueTestRoot } from "./test-tmp";

async function run(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

test("resolves the common hooks directory from a linked worktree", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-hook-root");
  const linked = uniqueTestRoot(tmpdir(), "keryx-hook-linked");
  await rm(root, { recursive: true, force: true });
  await rm(linked, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await run(root, ["init"]);
  await run(root, ["config", "user.email", "keryx@example.test"]);
  await run(root, ["config", "user.name", "Keryx Test"]);
  await writeFile(path.join(root, "README.md"), "test\n");
  await run(root, ["add", "README.md"]);
  await run(root, ["commit", "-m", "initial"]);
  await run(root, ["worktree", "add", "-b", "linked", linked]);

  const hooksRoot = await resolveGitHooksRoot(linked);
  expect(hooksRoot).toBe(await realpath(path.join(root, ".git", "hooks")));

  await rm(root, { recursive: true, force: true });
  await rm(linked, { recursive: true, force: true });
});

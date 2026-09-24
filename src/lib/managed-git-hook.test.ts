import { lstat, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { installManagedHook, ManagedGitHookEscapeError, removeManagedHook } from "./managed-git-hook";
import { uniqueTestRoot } from "./test-tmp";

async function run(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

async function initRepo(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await run(root, ["init", "-q"]);
  await run(root, ["config", "user.email", "keryx@example.test"]);
  await run(root, ["config", "user.name", "Keryx Test"]);
}

test("installManagedHook writes a normal (non-symlinked) hook", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-managed-hook-normal");
  try {
    await initRepo(root);
    await installManagedHook(root, "post-commit", "test-block", "echo hi");
    const hookPath = path.join(root, ".git", "hooks", "post-commit");
    const content = await readFile(hookPath, "utf8");
    expect(content).toContain("# keryx:test-block:begin");
    expect(content).toContain("echo hi");
    expect(content).toContain("# keryx:test-block:end");

    // Idempotent update, and removal, both still work on the plain case.
    await installManagedHook(root, "post-commit", "test-block", "echo bye");
    expect(await readFile(hookPath, "utf8")).toContain("echo bye");
    await removeManagedHook(root, "post-commit", "test-block");
    expect(await readFile(hookPath, "utf8")).not.toContain("keryx:test-block");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// R1-F6: the OLD per-command comment ("resolveGitHooksRoot's own symlink
// check") was false — nothing rejected a `.git/hooks` that is ITSELF a
// symlink. `resolveContainedHookPath` now lstat/realpath-checks the hooks
// directory before `installManagedHook` ever `mkdir`s or writes into it.
test("installManagedHook refuses a .git/hooks directory symlinked outside the git common dir", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-managed-hook-dir-link");
  const outside = uniqueTestRoot(tmpdir(), "keryx-managed-hook-dir-link-outside");
  try {
    await initRepo(root);
    await rm(path.join(root, ".git", "hooks"), { recursive: true, force: true });
    await symlink(outside, path.join(root, ".git", "hooks"));

    await expect(installManagedHook(root, "post-commit", "test-block", "echo hi")).rejects.toBeInstanceOf(
      ManagedGitHookEscapeError,
    );
    expect(await readdir(outside)).toEqual([]);
    expect((await lstat(path.join(root, ".git", "hooks"))).isSymbolicLink()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// R1-F6: same escape, one level deeper — the hooks DIRECTORY resolves fine,
// but the specific hook FILE is a symlink pointing outside it.
test("installManagedHook refuses a hook file symlinked outside the git common dir, and does not overwrite the victim", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-managed-hook-file-link");
  const outside = uniqueTestRoot(tmpdir(), "keryx-managed-hook-file-link-outside");
  try {
    await initRepo(root);
    const victimPath = path.join(outside, "victim");
    await writeFile(victimPath, "#!/usr/bin/env sh\necho victim\n", "utf8");
    await symlink(victimPath, path.join(root, ".git", "hooks", "post-commit"));

    await expect(installManagedHook(root, "post-commit", "test-block", "echo hi")).rejects.toBeInstanceOf(
      ManagedGitHookEscapeError,
    );
    expect(await readFile(victimPath, "utf8")).toBe("#!/usr/bin/env sh\necho victim\n");
    expect((await lstat(path.join(root, ".git", "hooks", "post-commit"))).isSymbolicLink()).toBe(true);

    // removeManagedHook refuses the same way.
    await expect(removeManagedHook(root, "post-commit", "test-block")).rejects.toBeInstanceOf(
      ManagedGitHookEscapeError,
    );
    expect(await readFile(victimPath, "utf8")).toBe("#!/usr/bin/env sh\necho victim\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("installManagedHook no-ops (no throw) when there is no git repository at all", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-managed-hook-no-git");
  try {
    await mkdir(root, { recursive: true });
    await installManagedHook(root, "post-commit", "test-block", "echo hi");
    expect(await readdir(root).catch(() => [])).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// R2-F2: `.git/hooks/<hook> -> ../../scripts/<hook>`, a tracked script inside
// the project, is a common and legitimate setup. Before this fix, only the
// git common dir was an accepted resolution target, so this aborted with
// ManagedGitHookEscapeError even though nothing was written outside the
// project.
test("installManagedHook accepts a hook file symlinked to an in-project tracked script", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-managed-hook-inproject-link");
  try {
    await initRepo(root);
    const scriptDir = path.join(root, "scripts");
    await mkdir(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, "post-commit");
    await writeFile(scriptPath, "#!/usr/bin/env sh\necho tracked\n", "utf8");
    await symlink(path.join("..", "..", "scripts", "post-commit"), path.join(root, ".git", "hooks", "post-commit"));

    await installManagedHook(root, "post-commit", "test-block", "echo hi");
    const written = await readFile(scriptPath, "utf8");
    expect(written).toContain("# keryx:test-block:begin");
    expect(written).toContain("echo hi");
    expect((await lstat(path.join(root, ".git", "hooks", "post-commit"))).isSymbolicLink()).toBe(true);

    await removeManagedHook(root, "post-commit", "test-block");
    expect(await readFile(scriptPath, "utf8")).not.toContain("keryx:test-block");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// R2-F2: a dangling hook-file symlink used to surface as a raw ENOENT out of
// `realpath`, uncaught — a crash with no named reason. It is now the same
// `ManagedGitHookEscapeError` every other refusal in this module throws.
test("installManagedHook refuses a dangling hook-file symlink with a named error, not a raw ENOENT", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-managed-hook-dangling-link");
  try {
    await initRepo(root);
    await symlink(path.join(root, "does-not-exist"), path.join(root, ".git", "hooks", "post-commit"));

    let caught: unknown;
    try {
      await installManagedHook(root, "post-commit", "test-block", "echo hi");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ManagedGitHookEscapeError);
    expect((caught as Error).message).toContain("dangling symlink");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a legitimate linked worktree's hooks directory (resolves inside the common dir) still works", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-managed-hook-worktree-root");
  const linked = uniqueTestRoot(tmpdir(), "keryx-managed-hook-worktree-linked");
  try {
    await initRepo(root);
    await writeFile(path.join(root, "README.md"), "test\n");
    await run(root, ["add", "README.md"]);
    await run(root, ["commit", "-q", "-m", "initial"]);
    await rm(linked, { recursive: true, force: true });
    await run(root, ["worktree", "add", "-q", "-b", "linked", linked]);

    await installManagedHook(linked, "post-commit", "test-block", "echo hi");
    const hookPath = path.join(await realpath(path.join(root, ".git", "hooks")), "post-commit");
    expect(await readFile(hookPath, "utf8")).toContain("# keryx:test-block:begin");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(linked, { recursive: true, force: true });
  }
});

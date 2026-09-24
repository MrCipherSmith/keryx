import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { hasManagedHook, installManagedHook, ManagedGitHookEscapeError, removeManagedHook } from "./managed-hook";
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

test("installManagedHook writes a normal (non-symlinked) hook and hasManagedHook/removeManagedHook agree", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-managed-hook2-normal");
  try {
    await initRepo(root);
    expect(await installManagedHook(root, "post-commit", "trigger-foo", "echo hi")).toBe(true);
    const hookPath = path.join(root, ".git", "hooks", "post-commit");
    const content = await readFile(hookPath, "utf8");
    expect(content).toContain("# keryx:trigger-foo:begin");
    expect(content).toContain("echo hi");

    expect(await hasManagedHook(root, "post-commit", "trigger-foo")).toBe(true);

    // A hookName this module supports but managed-git-hook.ts's narrower
    // union type does not (post-merge/post-checkout) — the whole reason
    // trigger/hooks.ts uses this module instead of managed-git-hook.ts's.
    expect(await installManagedHook(root, "post-merge", "trigger-bar", "echo bye")).toBe(true);
    expect(await readFile(path.join(root, ".git", "hooks", "post-merge"), "utf8")).toContain("echo bye");

    expect(await removeManagedHook(root, "post-commit", "trigger-foo")).toBe(true);
    expect(await hasManagedHook(root, "post-commit", "trigger-foo")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// R2-F5: this module used to have no containment check at all — a symlinked
// .git/hooks directory was `mkdir`'d/`readdir`'d/written into without any
// lstat/realpath check. It now reuses managed-git-hook.ts's
// resolveContainedHookPath, so it refuses exactly like installManagedHook in
// managed-git-hook.ts does.
test("installManagedHook refuses a .git/hooks directory symlinked outside the git common dir and the project root", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-managed-hook2-dir-link");
  const outside = uniqueTestRoot(tmpdir(), "keryx-managed-hook2-dir-link-outside");
  try {
    await initRepo(root);
    await rm(path.join(root, ".git", "hooks"), { recursive: true, force: true });
    await symlink(outside, path.join(root, ".git", "hooks"));

    await expect(installManagedHook(root, "post-commit", "trigger-foo", "echo hi")).rejects.toBeInstanceOf(
      ManagedGitHookEscapeError,
    );
    expect(await readdir(outside)).toEqual([]);
    expect((await lstat(path.join(root, ".git", "hooks"))).isSymbolicLink()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("installManagedHook refuses a hook file symlinked outside the git common dir and the project root, and does not overwrite the victim", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-managed-hook2-file-link");
  const outside = uniqueTestRoot(tmpdir(), "keryx-managed-hook2-file-link-outside");
  try {
    await initRepo(root);
    const victimPath = path.join(outside, "victim");
    await writeFile(victimPath, "#!/usr/bin/env sh\necho victim\n", "utf8");
    await symlink(victimPath, path.join(root, ".git", "hooks", "post-checkout"));

    await expect(installManagedHook(root, "post-checkout", "trigger-foo", "echo hi")).rejects.toBeInstanceOf(
      ManagedGitHookEscapeError,
    );
    expect(await readFile(victimPath, "utf8")).toBe("#!/usr/bin/env sh\necho victim\n");

    await expect(removeManagedHook(root, "post-checkout", "trigger-foo")).rejects.toBeInstanceOf(
      ManagedGitHookEscapeError,
    );
    expect(await readFile(victimPath, "utf8")).toBe("#!/usr/bin/env sh\necho victim\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// R2-F2: a hook file symlinked to an in-project, repo-tracked script is a
// common, legitimate setup — this module now accepts it, the same as
// managed-git-hook.ts's installManagedHook does.
test("installManagedHook accepts a hook file symlinked to an in-project tracked script", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-managed-hook2-inproject-link");
  try {
    await initRepo(root);
    const scriptDir = path.join(root, "scripts");
    await mkdir(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, "post-commit");
    await writeFile(scriptPath, "#!/usr/bin/env sh\necho tracked\n", "utf8");
    await symlink(path.join("..", "..", "scripts", "post-commit"), path.join(root, ".git", "hooks", "post-commit"));

    expect(await installManagedHook(root, "post-commit", "trigger-foo", "echo hi")).toBe(true);
    const written = await readFile(scriptPath, "utf8");
    expect(written).toContain("# keryx:trigger-foo:begin");
    expect(written).toContain("echo hi");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installManagedHook no-ops (no throw) when there is no git repository at all", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-managed-hook2-no-git");
  try {
    await mkdir(root, { recursive: true });
    expect(await installManagedHook(root, "post-commit", "trigger-foo", "echo hi")).toBe(false);
    expect(await readdir(root).catch(() => [])).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

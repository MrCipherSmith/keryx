import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";
import { pathExists } from "../lib/fs";
import { installSyncHooks, SYNC_HOOKS, uninstallSyncHooks } from "./hooks";

async function withGitRepo(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sync-hooks-"));
  try {
    await mkdir(path.join(root, ".git", "hooks"), { recursive: true });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("installs post-merge + post-checkout hooks that call keryx sync", async () => {
  await withGitRepo(async (root) => {
    const installed = await installSyncHooks(root);
    expect(installed.sort()).toEqual([...SYNC_HOOKS, "commit-msg"].sort());
    for (const hook of SYNC_HOOKS) {
      const content = await readFile(path.join(root, ".git", "hooks", hook), "utf8");
      expect(content).toContain("# keryx:keryx-sync:begin");
      expect(content).toContain("keryx sync");
    }
    // post-checkout guards on the branch-flag; post-merge does not.
    const checkout = await readFile(path.join(root, ".git", "hooks", "post-checkout"), "utf8");
    expect(checkout).toContain('[ "${3:-1}" = "1" ]');
  });
});

test("preserves existing hook content and is idempotent", async () => {
  await withGitRepo(async (root) => {
    const p = path.join(root, ".git", "hooks", "post-merge");
    await writeFile(p, "#!/usr/bin/env sh\necho user-hook\n", "utf8");
    await installSyncHooks(root);
    await installSyncHooks(root); // second time
    const content = await readFile(p, "utf8");
    expect(content).toContain("echo user-hook"); // preserved
    expect(content.match(/# keryx:keryx-sync:begin/g)?.length).toBe(1); // not duplicated
  });
});

test("uninstall removes only the managed block, leaving user content", async () => {
  await withGitRepo(async (root) => {
    const p = path.join(root, ".git", "hooks", "post-merge");
    await writeFile(p, "#!/usr/bin/env sh\necho user-hook\n", "utf8");
    await installSyncHooks(root);
    await uninstallSyncHooks(root);
    const content = await readFile(p, "utf8");
    expect(content).toContain("echo user-hook");
    expect(content).not.toContain("keryx-sync");
  });
});

test("uninstall reports commit-msg only when it removed something", async () => {
  await withGitRepo(async (root) => {
    // Nothing installed: commit-msg is not reported as removed.
    expect(await uninstallSyncHooks(root)).toEqual([]);

    await installSyncHooks(root);
    expect(await uninstallSyncHooks(root)).toContain("commit-msg");
    expect(await pathExists(path.join(root, ".git", "hooks", "commit-msg"))).toBe(false);
    expect(await pathExists(path.join(root, ".git", "hooks", "keryx-commit-msg"))).toBe(false);
    expect(await uninstallSyncHooks(root)).toEqual([]);
  });
});

test("uninstall does not edit a symlinked commit-msg and warns instead", async () => {
  await withGitRepo(async (root) => {
    await installSyncHooks(root);
    const hookPath = path.join(root, ".git", "hooks", "commit-msg");
    const target = path.join(root, "scripts", "commit-msg");
    await mkdir(path.dirname(target), { recursive: true });
    await rename(hookPath, target);
    await symlink(path.join("..", "..", "scripts", "commit-msg"), hookPath);
    const before = await readFile(target, "utf8");

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await uninstallSyncHooks(root)).not.toContain("commit-msg");
      expect(warn.mock.calls.flat().join(" ")).toContain("is a symlink");
    } finally {
      warn.mockRestore();
    }
    expect(await readFile(target, "utf8")).toBe(before);
    expect(await pathExists(path.join(root, ".git", "hooks", "keryx-commit-msg"))).toBe(true);
  });
});

test("install-hooks honours hooks.commitMsg: false and removes an installed check", async () => {
  await withGitRepo(async (root) => {
    expect(await installSyncHooks(root)).toContain("commit-msg");
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "metaproject.json"), JSON.stringify({ hooks: { commitMsg: false } }), "utf8");

    const installed = await installSyncHooks(root);
    expect(installed).not.toContain("commit-msg");
    expect(installed.sort()).toEqual([...SYNC_HOOKS].sort());
    expect(await pathExists(path.join(root, ".git", "hooks", "commit-msg"))).toBe(false);
    expect(await pathExists(path.join(root, ".git", "hooks", "keryx-commit-msg"))).toBe(false);
  });
});

test("install-hooks run from a subdirectory reads hooks.commitMsg from the project root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sync-hooks-subdir-"));
  try {
    await Bun.spawn(["git", "init", "-q", "--template="], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited;
    expect(await installSyncHooks(root)).toContain("commit-msg");
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "metaproject.json"), JSON.stringify({ hooks: { commitMsg: false } }), "utf8");
    const sub = path.join(root, "packages", "app");
    await mkdir(sub, { recursive: true });

    expect(await installSyncHooks(sub)).not.toContain("commit-msg");
    expect(await pathExists(path.join(root, ".git", "hooks", "keryx-commit-msg"))).toBe(false);
    expect(await pathExists(path.join(root, ".git", "hooks", "commit-msg"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no-op outside a git repo", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-nogit-"));
  try {
    expect(await installSyncHooks(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

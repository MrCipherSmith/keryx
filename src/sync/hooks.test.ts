import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
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
    expect(installed.sort()).toEqual([...SYNC_HOOKS].sort());
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

test("no-op outside a git repo", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-nogit-"));
  try {
    expect(await installSyncHooks(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

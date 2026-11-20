import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { computeLockHash, prepareDependency, readDepsRecords, type RunInstall } from "./deps";
import { addWorktree, createFixture, type Fixture } from "./test-support";

let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

const dependency = { dir: "node_modules", lockfiles: ["bun.lock"], install: "fake install" };

function fakeInstaller(): { run: RunInstall; calls: Array<{ command: string; cwd: string }> } {
  const calls: Array<{ command: string; cwd: string }> = [];
  return {
    calls,
    run: async (command, cwd) => {
      calls.push({ command, cwd });
      mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
      writeFileSync(path.join(cwd, "node_modules", "installed.txt"), "x");
      return { code: 0 };
    },
  };
}

function seedMain(root: string, lock: string): void {
  writeFileSync(path.join(root, "bun.lock"), lock);
  mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
}

describe("prepareDependency (AC2)", () => {
  test("clones from the main checkout when locks match, then skips on the second call", async () => {
    fixture = createFixture();
    seedMain(fixture.main, "lock-A");
    const worktree = addWorktree(fixture, "wt-a");
    writeFileSync(path.join(worktree, "bun.lock"), "lock-A");
    const installer = fakeInstaller();

    const first = await prepareDependency({ mainRoot: fixture.main, worktreeRoot: worktree, dependency, runInstall: installer.run });
    expect(first.method).toBe("clone");
    expect(first.lockHash).toBe(await computeLockHash(worktree, ["bun.lock"]));
    expect(readFileSync(path.join(worktree, "node_modules", "pkg", "index.js"), "utf8")).toContain("module.exports");
    expect(installer.calls).toHaveLength(0);

    const second = await prepareDependency({ mainRoot: fixture.main, worktreeRoot: worktree, dependency, runInstall: installer.run });
    expect(second.method).toBe("skipped");
    expect(installer.calls).toHaveLength(0);
    expect((await readDepsRecords(worktree)).map((record) => record.dir)).toEqual(["node_modules"]);
  });

  test("a changed lock triggers an install", async () => {
    fixture = createFixture();
    seedMain(fixture.main, "lock-A");
    const worktree = addWorktree(fixture, "wt-a");
    writeFileSync(path.join(worktree, "bun.lock"), "lock-A");
    const installer = fakeInstaller();
    await prepareDependency({ mainRoot: fixture.main, worktreeRoot: worktree, dependency, runInstall: installer.run });

    writeFileSync(path.join(worktree, "bun.lock"), "lock-B");
    const record = await prepareDependency({ mainRoot: fixture.main, worktreeRoot: worktree, dependency, runInstall: installer.run });
    expect(record.method).toBe("install");
    expect(installer.calls).toEqual([{ command: "fake install", cwd: worktree }]);
  });

  test("clones then installs when the main checkout's lock differs from the worktree's", async () => {
    fixture = createFixture();
    seedMain(fixture.main, "lock-A");
    const worktree = addWorktree(fixture, "wt-a");
    writeFileSync(path.join(worktree, "bun.lock"), "lock-B");
    const installer = fakeInstaller();

    const record = await prepareDependency({ mainRoot: fixture.main, worktreeRoot: worktree, dependency, runInstall: installer.run });
    expect(record.method).toBe("install");
    expect(installer.calls).toHaveLength(1);
    expect(existsSync(path.join(worktree, "node_modules", "pkg", "index.js"))).toBe(true);
  });

  test("installs when the main checkout has no dependency directory", async () => {
    fixture = createFixture();
    const worktree = addWorktree(fixture, "wt-a");
    const installer = fakeInstaller();
    const record = await prepareDependency({ mainRoot: fixture.main, worktreeRoot: worktree, dependency, runInstall: installer.run });
    expect(record.method).toBe("install");
    expect(installer.calls).toHaveLength(1);
  });

  test("a failing install is an error and records nothing", async () => {
    fixture = createFixture();
    const worktree = addWorktree(fixture, "wt-a");
    await expect(
      prepareDependency({ mainRoot: fixture.main, worktreeRoot: worktree, dependency, runInstall: async () => ({ code: 1, stderr: "boom" }) }),
    ).rejects.toThrow("boom");
    expect(await readDepsRecords(worktree)).toEqual([]);
  });

  test("the record lives in the worktree git dir, not the working copy", async () => {
    fixture = createFixture();
    const worktree = addWorktree(fixture, "wt-a");
    await prepareDependency({ mainRoot: fixture.main, worktreeRoot: worktree, dependency, runInstall: fakeInstaller().run });
    expect(existsSync(path.join(fixture.main, ".git", "worktrees", "wt-a", "keryx", "deps.json"))).toBe(true);
  });
});

describe("computeLockHash", () => {
  test("depends on contents and order", async () => {
    fixture = createFixture();
    writeFileSync(path.join(fixture.main, "a.lock"), "1");
    writeFileSync(path.join(fixture.main, "b.lock"), "2");
    const ab = await computeLockHash(fixture.main, ["a.lock", "b.lock"]);
    expect(ab).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeLockHash(fixture.main, ["b.lock", "a.lock"])).not.toBe(ab);
  });
});

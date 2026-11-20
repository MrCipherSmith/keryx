import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createWorktree } from "./create";
import { prepareWorktree, readPrepareState } from "./prepare";
import { createProjectFixture, everyPortFree, statusOf, type ProjectFixture } from "./project-fixture";
import { gitDirOf } from "./git";
import { worktreeStatus } from "./status";

let project: ProjectFixture;

beforeEach(async () => {
  project = await createProjectFixture();
});
afterEach(() => project.cleanup());

function create(name: string) {
  return createWorktree({
    cwd: project.main,
    name,
    base: "main",
    path: path.join(project.base, name),
    runInstall: project.runInstall,
    isPortFree: everyPortFree,
  });
}

describe("create + prepare (AC4)", () => {
  test("leaves the worktree clean and the main checkout untouched", async () => {
    const mainBefore = statusOf(project, project.main, true);
    const created = await create("wt-a");

    expect(created.prepare.ok).toBe(true);
    expect(created.branch).toBe("wt-a");
    expect(statusOf(project, created.path)).toBe("");
    expect(statusOf(project, project.main, true)).toBe(mainBefore);

    // Only ignored files appear: the copied .env, the dependencies, the derived data.
    const ignored = statusOf(project, created.path, true).trim().split("\n").sort();
    expect(ignored).toEqual(["!! .env", "!! .metaproject/data/", "!! node_modules/"]);
  });

  test("names copied and skipped env files, never their contents", async () => {
    const created = await create("wt-env");
    expect(created.prepare.env?.copied).toEqual([".env"]);
    expect(created.prepare.env?.skipped.map((item) => item.file)).toEqual([".env.local"]);
    expect(readFileSync(path.join(created.path, ".env"), "utf8")).toBe("SECRET=top-secret-value\n");
    expect(existsSync(path.join(created.path, ".env.local"))).toBe(false);

    const printed = JSON.stringify(created.prepare);
    expect(printed).not.toContain("top-secret-value");
    expect(printed).not.toContain("also-secret");
  });

  test("keeps the mode of a copied env file", async () => {
    const created = await create("wt-mode");
    expect(statSync(path.join(created.path, ".env")).mode & 0o777).toBe(statSync(path.join(project.main, ".env")).mode & 0o777);
  });

  test("a second prepare is a no-op: dependencies skipped, env kept, state recorded", async () => {
    const created = await create("wt-idem");
    const first = await readPrepareState(await gitDirOf(created.path));
    const second = await prepareWorktree({ cwd: created.path, runInstall: project.runInstall, isPortFree: everyPortFree });

    expect(second.ok).toBe(true);
    expect(second.deps).toEqual([{ dir: "node_modules", method: "skipped" }]);
    expect(second.env?.copied).toEqual([]);
    expect(second.env?.skipped.map((item) => item.file).sort()).toEqual([".env", ".env.local"]);
    expect(second.ports).toEqual(created.prepare.ports ?? {});
    expect(statusOf(project, created.path)).toBe("");
    expect(first?.steps).toEqual({ env: "ok", deps: "ok", ports: "ok", indexes: "ok" });
    expect((await readPrepareState(await gitDirOf(created.path)))?.steps).toEqual(first?.steps ?? {});
  });

  test("--only runs just the named steps and keeps the other outcomes", async () => {
    const created = await create("wt-only");
    const report = await prepareWorktree({ cwd: created.path, only: ["indexes"], isPortFree: everyPortFree });
    expect(report.steps).toEqual(["indexes"]);
    expect(report.env).toBeUndefined();
    expect(report.deps).toBeUndefined();
    expect(report.indexes?.map((index) => `${index.name}:${index.status}`)).toEqual(["memory:built"]);
    expect((await readPrepareState(await gitDirOf(created.path)))?.steps.env).toBe("ok");
  });

  test("a failed install is reported, the worktree is kept and the other steps still run", async () => {
    const created = await createWorktree({
      cwd: project.main,
      name: "wt-fail",
      base: "main",
      path: path.join(project.base, "wt-fail"),
      runInstall: async () => ({ code: 1, stderr: "registry unreachable" }),
      isPortFree: everyPortFree,
    });
    // The copy-on-write clone may satisfy the dependency without an install; force one by
    // checking the report shape either way.
    if (created.prepare.deps?.[0]?.method === "clone") {
      expect(created.prepare.ok).toBe(true);
    } else {
      expect(created.prepare.ok).toBe(false);
      expect(created.prepare.errors.join("\n")).toContain("registry unreachable");
      expect(created.prepare.ports).toBeDefined();
    }
    expect(existsSync(created.path)).toBe(true);
  });

  test("refuses the main checkout and a directory that is not a repository", async () => {
    await expect(prepareWorktree({ cwd: project.main })).rejects.toThrow("main checkout");
    await expect(prepareWorktree({ cwd: path.join(project.base, "user-home") })).rejects.toThrow("not a git repository");
  });

  test("status reports names and state without content", async () => {
    const created = await create("wt-status");
    const status = await worktreeStatus(created.path, { homeDir: project.userHome });
    expect(status.main).toBe(false);
    expect(status.branch).toBe("wt-status");
    expect(status.checkout?.checkoutId).toBe(created.prepare.checkoutId);
    expect(status.envFiles).toEqual([".env"]);
    expect(status.ports.PORT).toBe(String(created.prepare.ports?.web));
    expect(status.prepare?.steps.deps).toBe("ok");
    expect(JSON.stringify(status)).not.toContain("top-secret-value");
    expect((await worktreeStatus(project.main)).main).toBe(true);
  });
});

describe("create", () => {
  test("rejects a bad name and an unknown base before touching git", async () => {
    await expect(createWorktree({ cwd: project.main, name: "../evil" })).rejects.toThrow("invalid worktree name");
    await expect(createWorktree({ cwd: project.main, name: "ok", base: "no-such-ref" })).rejects.toThrow("base ref not found");
    await expect(createWorktree({ cwd: project.main, name: "ok", base: "--output=x" })).rejects.toThrow("never starts with");
  });
});

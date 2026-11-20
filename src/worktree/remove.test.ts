import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createMemoryService } from "../memory/service";
import { resolveGitCommonDir } from "../lib/git-worktrees";
import { createWorktree, type CreateResult } from "./create";
import { createProjectFixture, everyPortFree, type ProjectFixture } from "./project-fixture";
import { portsJournalPath } from "./ports";
import { removeWorktree, WorktreeRemoveRefusal } from "./remove";
import { fixtureGit } from "./test-support";

let project: ProjectFixture;

beforeEach(async () => {
  project = await createProjectFixture();
});
afterEach(() => project.cleanup());

function create(name: string): Promise<CreateResult> {
  return createWorktree({
    cwd: project.main,
    name,
    base: "main",
    path: path.join(project.base, name),
    runInstall: project.runInstall,
    isPortFree: everyPortFree,
  });
}

function journal(): string {
  const common = path.join(project.main, ".git");
  try {
    return readFileSync(portsJournalPath(common), "utf8");
  } catch {
    return "";
  }
}

const branches = (): string[] => fixtureGit(project.base, project.main, ["branch", "--format=%(refname:short)"]).trim().split("\n");

describe("remove", () => {
  test("removes a clean worktree, frees its ports and deletes the merged branch", async () => {
    const created = await create("wt-clean");
    expect(journal()).toContain(created.prepare.checkoutId);

    const result = await removeWorktree({ cwd: project.main, name: "wt-clean", env: { KERYX_HOME: project.userHome } });
    expect(result.portsReleased).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(existsSync(created.path)).toBe(false);
    expect(journal()).not.toContain(created.prepare.checkoutId);
    expect(branches()).not.toContain("wt-clean");
  });

  test("refuses while unpromoted entries exist, and lists them; --force removes anyway", async () => {
    const created = await create("wt-unpromoted");
    await createMemoryService().create({ cwd: created.path, type: "lesson", slug: "only-here", title: "Only here" });

    const refusal = await removeWorktree({ cwd: project.main, name: "wt-unpromoted" }).catch((cause: unknown) => cause);
    expect(refusal).toBeInstanceOf(WorktreeRemoveRefusal);
    expect((refusal as WorktreeRemoveRefusal).reason).toBe("unpromoted");
    expect((refusal as Error).message).toContain(".metaproject/memory/lessons/only-here.md");
    expect(existsSync(created.path)).toBe(true);
    expect(journal()).toContain(created.prepare.checkoutId);

    const forced = await removeWorktree({ cwd: project.main, name: "wt-unpromoted", force: true });
    expect(forced.portsReleased).toBe(true);
    expect(existsSync(created.path)).toBe(false);
    expect(journal()).not.toContain(created.prepare.checkoutId);
    // -D only with --force: the branch had nothing unmerged, so it goes either way.
    expect(branches()).not.toContain("wt-unpromoted");
  });

  test("refuses a dirty worktree without --force", async () => {
    const created = await create("wt-dirty");
    writeFileSync(path.join(created.path, "scratch.txt"), "work in progress\n");
    const refusal = await removeWorktree({ cwd: project.main, name: "wt-dirty" }).catch((cause: unknown) => cause);
    expect((refusal as WorktreeRemoveRefusal).reason).toBe("dirty");
    expect(existsSync(created.path)).toBe(true);
  });

  test("--keep-branch leaves the branch; an unmerged branch survives without --force", async () => {
    const kept = await create("wt-keep");
    await removeWorktree({ cwd: project.main, name: "wt-keep", keepBranch: true });
    expect(existsSync(kept.path)).toBe(false);
    expect(branches()).toContain("wt-keep");

    const unmerged = await create("wt-unmerged");
    writeFileSync(path.join(unmerged.path, "feature.txt"), "x\n");
    fixtureGit(project.base, unmerged.path, ["add", "feature.txt"]);
    fixtureGit(project.base, unmerged.path, ["commit", "-q", "-m", "feature"]);
    const result = await removeWorktree({ cwd: project.main, name: "wt-unmerged" });
    expect(result.branchDeleted).toBe(false);
    expect(result.branchKept).toContain("not fully merged");
    expect(branches()).toContain("wt-unmerged");
  });

  test("never removes the main checkout, an unknown name, or the worktree it runs in", async () => {
    const created = await create("wt-self");
    await expect(removeWorktree({ cwd: project.main, name: "main" })).rejects.toThrow("main checkout");
    await expect(removeWorktree({ cwd: project.main, name: "nope" })).rejects.toThrow("no linked worktree");
    await expect(removeWorktree({ cwd: created.path, name: "wt-self" })).rejects.toThrow("runs in");
  });

  test("a re-created worktree with the same name gets a new checkout id and a fresh port record (AC3)", async () => {
    const first = await create("wt-again");
    await removeWorktree({ cwd: project.main, name: "wt-again" });
    const second = await create("wt-again");
    expect(second.prepare.checkoutId).not.toBe(first.prepare.checkoutId);
    expect(journal()).not.toContain(first.prepare.checkoutId);
    expect(journal()).toContain(second.prepare.checkoutId);
    expect(await resolveGitCommonDir(second.path)).toBe(path.join(project.main, ".git"));
  });
});

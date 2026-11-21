import { afterEach, describe, expect, test } from "bun:test";
import { gitDirOf, FORBIDDEN_GIT_SUBCOMMANDS, gitSubcommand, runGit } from "./git";
import { addWorktree, createFixture, type Fixture } from "./test-support";
import path from "node:path";

let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

describe("runGit", () => {
  test("refuses every forbidden subcommand, also behind global options", async () => {
    for (const subcommand of FORBIDDEN_GIT_SUBCOMMANDS) {
      await expect(runGit(process.cwd(), [subcommand])).rejects.toThrow("forbidden");
      await expect(runGit(process.cwd(), ["-c", "user.name=t", "-C", ".", subcommand])).rejects.toThrow("forbidden");
    }
  });

  test("finds the subcommand after global options", () => {
    expect(gitSubcommand(["-c", "a=b", "-C", "/x", "--no-pager", "status"])).toBe("status");
    expect(gitSubcommand([])).toBeUndefined();
  });

  test("reports exit code and output without throwing on failure", async () => {
    fixture = createFixture();
    const bad = await runGit(fixture.main, ["rev-parse", "--verify", "nope"]);
    expect(bad.code).not.toBe(0);
    const good = await runGit(fixture.main, ["rev-parse", "--is-inside-work-tree"]);
    expect(good).toMatchObject({ code: 0, stdout: "true\n" });
  });

  test("gitDirOf is the worktree's own git directory", async () => {
    fixture = createFixture();
    const worktree = addWorktree(fixture, "wt-a");
    expect(await gitDirOf(fixture.main)).toBe(path.join(fixture.main, ".git"));
    expect(await gitDirOf(worktree)).toBe(path.join(fixture.main, ".git", "worktrees", "wt-a"));
  });
});

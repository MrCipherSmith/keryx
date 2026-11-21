import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { worktreeAgentBlock, worktreeAgentLines } from "./agent-lines";
import { addWorktree, createFixture, type Fixture } from "./test-support";

let fixture: Fixture;
beforeEach(() => {
  fixture = createFixture();
});
afterEach(() => fixture.cleanup());

describe("worktreeAgentLines (spec 5.3)", () => {
  test("a linked worktree yields the absolute root and its index path", async () => {
    const worktree = addWorktree(fixture, "wt-lines");
    const lines = await worktreeAgentLines(worktree);
    expect(lines).toEqual([
      `Worktree root: ${realpathSync(worktree)}`,
      `Metaproject index: ${path.join(realpathSync(worktree), ".metaproject", "index.md")}`,
    ]);
  });

  test("a subdirectory of the worktree resolves to the same root", async () => {
    const worktree = addWorktree(fixture, "wt-sub");
    const lines = await worktreeAgentLines(path.join(worktree, ".git").replace(/\.git$/, ""));
    expect(lines?.[0]).toBe(`Worktree root: ${realpathSync(worktree)}`);
  });

  test("the main checkout yields nothing", async () => {
    expect(await worktreeAgentLines(fixture.main)).toBeUndefined();
    expect(await worktreeAgentBlock(fixture.main)).toBe("");
  });

  test("a directory outside git yields nothing", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "keryx-not-git-"));
    try {
      expect(await worktreeAgentLines(outside)).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("the block is the two lines joined", async () => {
    const worktree = addWorktree(fixture, "wt-block");
    const block = await worktreeAgentBlock(worktree);
    expect(block.split("\n")).toHaveLength(2);
  });
});

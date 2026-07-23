import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { createFlowService } from "./service";
import type { FlowServiceDeps } from "./types";

// Flow 116 / AC1-AC2: flow ids are allocated per CLONE, not per working copy.
// Two linked worktrees of one repository must never mint the same number —
// that is how 002, 084 and 103 ended up duplicated on main.

const ROOTS: string[] = [];

afterAll(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

function makeDeps(): FlowServiceDeps {
  return {
    tracker: null,
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-07-22T10:00:00Z"),
  };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "keryx test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "keryx test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

// A repository with one commit, so `git worktree add` has something to branch from.
async function freshRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-flow-alloc-"));
  ROOTS.push(root);
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), "{}\n", "utf8");
  await git(root, "init", "-b", "main");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  return root;
}

test("ids stay unique across linked worktrees that cannot see each other's flows", async () => {
  const repo = await freshRepo();
  const service = createFlowService(makeDeps());

  const first = await service.init({ cwd: repo, title: "Work in the main checkout" });
  expect(first.flow.id).toBe("001");

  // The worktree branches off `main`, where flow 001 is not committed yet: its
  // own .metaproject/flows listing is empty, which is exactly the blind spot.
  const worktree = path.join(repo, "wt");
  await git(repo, "worktree", "add", "-b", "feature", worktree, "main");
  expect(await pathExists(path.join(worktree, ".metaproject", "flows"))).toBe(false);

  const second = await service.init({ cwd: worktree, title: "Work in the worktree" });
  expect(second.flow.id).toBe("002");
});

test("concurrent inits from two worktrees of one clone never collide", async () => {
  const repo = await freshRepo();
  const service = createFlowService(makeDeps());

  const worktree = path.join(repo, "wt");
  await git(repo, "worktree", "add", "-b", "feature", worktree, "main");

  const [a, b] = await Promise.all([
    service.init({ cwd: repo, title: "Racing A" }),
    service.init({ cwd: worktree, title: "Racing B" }),
  ]);

  expect(new Set([a.flow.id, b.flow.id]).size).toBe(2);
});

test("a renumbered id is never handed out again", async () => {
  const repo = await freshRepo();
  const service = createFlowService(makeDeps());

  const first = await service.init({ cwd: repo, title: "Original" });
  await service.renumber({
    cwd: repo,
    ref: path.basename(first.dir),
    to: "050",
    reason: "test: free 001",
  });

  // 001 is now unused on disk, but it was handed out once — reuse would make
  // historical references (PRs, journals) ambiguous.
  const next = await service.init({ cwd: repo, title: "After renumber" });
  expect(next.flow.id).not.toBe("001");
  expect(Number(next.flow.id)).toBeGreaterThan(50);
});

test("outside a git checkout, allocation falls back to the local flows listing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-flow-nogit-"));
  ROOTS.push(root);
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  const service = createFlowService(makeDeps());

  const first = await service.init({ cwd: root, title: "No git here" });
  const second = await service.init({ cwd: root, title: "Still no git" });

  expect(first.flow.id).toBe("001");
  expect(second.flow.id).toBe("002");
});

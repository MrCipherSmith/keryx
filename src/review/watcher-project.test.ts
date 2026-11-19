import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureWatcher, pollWatcher } from "./watcher";
import { resolveWatcherCheckout } from "./watcher-project";

test("scheduled polls find a remote configured only in a linked checkout, then preserve state when it disappears", async () => {
  const root = mkdtempSync(join(tmpdir(), "watch-project-"));
  const main = join(root, "main");
  const linked = join(root, "linked\ncheckout");
  const key = { repo: "team/reviews", repositoryId: "R_test", viewer: "fixture" };
  const previousDir = process.env.KERYX_DATA_DIR,
    previousPath = process.env.PATH;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgSign=false",
        ...args,
      ],
      { cwd, stdio: "pipe" },
    );
  try {
    mkdirSync(main);
    git(main, "init", "-q");
    git(main, "commit", "--allow-empty", "-qm", "fixture");
    git(main, "config", "extensions.worktreeConfig", "true");
    git(main, "worktree", "add", "--detach", linked);
    git(linked, "config", "--worktree", "remote.origin.url", "https://github.com/team/reviews.git");
    expect(realpathSync(await resolveWatcherCheckout(main, key.repo))).toBe(realpathSync(linked));

    process.env.KERYX_DATA_DIR = join(root, "data");
    process.env.PATH = root + ":" + previousPath;
    writeFileSync(join(root, "gh"), '#!/bin/sh\nexec cat "$PWD/board.json"\n', { mode: 0o700 });
    writeFileSync(
      join(linked, "board.json"),
      JSON.stringify({
        data: {
          viewer: { login: key.viewer },
          repository: {
            id: key.repositoryId,
            nameWithOwner: key.repo,
            pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      }),
    );
    configureWatcher(main, key, 1);
    const baseline = await pollWatcher(main, key);
    expect(baseline.lastSuccessAt).toBeTruthy();
    expect(baseline.lastError).toBeNull();

    git(main, "worktree", "remove", "--force", linked);
    const missing = await pollWatcher(main, key);
    expect(missing.lastSuccessAt).toBe(baseline.lastSuccessAt);
    expect(missing.lastError).toContain("connected");
    expect(missing.events).toEqual([]);
  } finally {
    if (previousDir === undefined) delete process.env.KERYX_DATA_DIR;
    else process.env.KERYX_DATA_DIR = previousDir;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});

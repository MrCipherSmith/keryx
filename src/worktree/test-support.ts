// Hermetic git fixtures for the src/worktree tests: temp dirs under os.tmpdir(),
// no global/system git config, no template hooks, no real $HOME.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withoutGitDiscoveryOverrides } from "../lib/git-env";

export interface Fixture {
  /** Parent of everything the fixture created. */
  base: string;
  /** The main checkout. */
  main: string;
  cleanup(): void;
}

function fixtureEnv(base: string): Record<string, string> {
  return {
    ...withoutGitDiscoveryOverrides(process.env),
    HOME: base,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@keryx.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@keryx.invalid",
  };
}

/** Run git synchronously in a fixture directory; throws with stderr on failure. */
export function fixtureGit(base: string, cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, env: fixtureEnv(base), stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

/** A main checkout with one commit whose `.gitignore` ignores `.env`, `.env.ignored` and `node_modules`. */
export function createFixture(): Fixture {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-worktree-")));
  const main = path.join(base, "main");
  mkdirSync(main);
  fixtureGit(base, main, ["init", "-q", "--template=", "-b", "main"]);
  writeFileSync(path.join(main, ".gitignore"), ".env\n.env.ignored\nnode_modules\n");
  writeFileSync(path.join(main, "README.md"), "fixture\n");
  fixtureGit(base, main, ["add", "."]);
  fixtureGit(base, main, ["commit", "-q", "-m", "init"]);
  return { base, main, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** Add a linked worktree named `name` on a new branch; returns its absolute path. */
export function addWorktree(fixture: Fixture, name: string): string {
  const worktree = path.join(fixture.base, name);
  fixtureGit(fixture.base, fixture.main, ["worktree", "add", "-q", "-b", name, worktree]);
  return worktree;
}

export function removeWorktree(fixture: Fixture, worktree: string): void {
  fixtureGit(fixture.base, fixture.main, ["worktree", "remove", "--force", worktree]);
}

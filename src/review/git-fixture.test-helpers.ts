// Real git repositories for the review gates' tests (flow 460): the diff a package's target names is recomputed from git,
// so the fixture is a repository, not a stub.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const EMAIL = "200531777+MrCipherSmith@users.noreply.github.com";
const ENV = { ...process.env, GIT_AUTHOR_NAME: "keryx test", GIT_AUTHOR_EMAIL: EMAIL, GIT_COMMITTER_NAME: "keryx test", GIT_COMMITTER_EMAIL: EMAIL };

export function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: ENV, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** `git init` on branch main, with the committer identity the repository's commit hook accepts. */
export function initRepo(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", EMAIL);
  git(dir, "config", "user.name", "keryx test");
  git(dir, "config", "commit.gpgsign", "false");
}

/** Writes the files, stages exactly them and commits; returns the new commit's sha. */
export function commitFiles(dir: string, files: Record<string, string>, message: string): string {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  git(dir, "add", "--", ...Object.keys(files));
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

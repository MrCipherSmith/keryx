import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bindProjectGithubAccount, readProjectGithubAccount } from "./review-accounts";
import { boardGraphql, reviewGitCommonDir, reviewRepositories } from "../review/board-github";
import { listGithubAccounts } from "../review/github-cli";
import { verifyIdentity } from "../review/watcher-project";
import { beginWatcherOperation, configureWatcher, pollWatcher, readWatcher } from "../review/watcher";
import { SAFE_BUN_SPAWN_ARGS } from "../lib/safe-exec";
import { fixtureGitEnv, isolateGitDiscovery } from "../review/test-git-fixture";

const key = { repo: "org/repo", repositoryId: "R_test", viewer: "alice" };
const testEnv = ["PATH", "KERYX_DATA_DIR", "GH_TOKEN", "GITHUB_TOKEN", "GH_DEBUG", "ACCOUNT_FIXTURE_DENY"];
let saved: Record<string, string | undefined>, restoreGit: () => void;
let root: string, project: string, worktree: string, second: string;

function git(cwd: string, ...args: string[]) {
  return execFileSync("/usr/bin/git", [
    "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", ...args,
  ], { cwd, stdio: "pipe", env: fixtureGitEnv() });
}

beforeEach(() => {
  saved = Object.fromEntries(testEnv.map(name => [name, process.env[name]]));
  restoreGit = isolateGitDiscovery();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "review-accounts-")));
  project = path.join(root, "project");
  worktree = path.join(root, "linked");
  second = path.join(root, "second");
  for (const directory of [project, second]) {
    mkdirSync(directory);
    git(directory, "init", "-q");
    git(directory, "commit", "--allow-empty", "-qm", "fixture");
    git(directory, "remote", "add", "origin", "https://github.com/org/repo.git");
  }
  git(project, "worktree", "add", "--detach", worktree);
  process.env.KERYX_DATA_DIR = path.join(root, "data");
  process.env.PATH = root + path.delimiter + saved.PATH;
  process.env.GH_TOKEN = "fixture-ambient-token";
  process.env.GITHUB_TOKEN = "fixture-ambient-override";
  process.env.GH_DEBUG = "api";
  delete process.env.ACCOUNT_FIXTURE_DENY;
  writeFileSync(path.join(root, "gh"), `#!/bin/sh
set -eu
if [ "$1" = auth ]; then
  test -z "${'$'}{GH_TOKEN:-}"
  test -z "${'$'}{GITHUB_TOKEN:-}"
  test -z "${'$'}{GH_DEBUG:-}"
  if [ "$2" = status ]; then
    printf '%s\\n' '[{"login":"alice","active":true,"state":"success","token":"redaction-sentinel"},{"login":"bob","active":false,"state":"success"}]'
    exit
  fi
  test "$2 $3 $4 $5" = 'token --hostname github.com --user'
  case "$6" in alice|bob|mismatch) echo "fixture-account-$6"; exit ;; esac
  echo "credential-diagnostic-must-not-escape" >&2
  exit 1
fi
test "$1 $2 $3 $4" = 'api --hostname github.com graphql'
repo='{ "id":"R_test", "nameWithOwner":"org/repo", "pullRequests":{ "nodes":[], "pageInfo":{"hasNextPage":false} } }'
case "${'$'}{GH_TOKEN:-}" in
  fixture-account-alice|fixture-account-bob)
    test -z "${'$'}{GH_DEBUG:-}"
    test -z "${'$'}{GITHUB_TOKEN:-}"
    viewer="${'$'}{GH_TOKEN#fixture-account-}"
    test "${'$'}{ACCOUNT_FIXTURE_DENY:-}" != "$viewer" || repo='null'
    ;;
  fixture-account-mismatch) viewer='bob' ;;
  *) viewer='legacy' ;;
esac
printf '{"data":{"viewer":{"login":"%s"},"repository":%s}}\\n' "$viewer" "$repo"
`, { mode: 0o700 });
});

afterEach(() => {
  restoreGit();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

async function viewer(cwd: string) {
  return (await boardGraphql<{ viewer: { login: string } }>(cwd, "{ viewer { login } }", {})).viewer.login;
}

test("saved accounts have no token metadata and separate project bindings are shared by linked worktrees", async () => {
  const cli = path.resolve(import.meta.dir, "../cli.ts");
  const result = execFileSync(process.execPath, [...SAFE_BUN_SPAWN_ARGS, cli, "review", "accounts", "project", "--json"],
    { cwd: project, encoding: "utf8", timeout: 15_000 });
  expect(JSON.parse(result)).toEqual({ eligible: true, login: null, configured: false });
  expect(await listGithubAccounts(project)).toEqual([
    { login: "alice", active: true, state: "success" }, { login: "bob", active: false, state: "success" },
  ]);
  expect(await readProjectGithubAccount(project)).toEqual({ eligible: true, login: null, configured: false });
  expect(await viewer(project)).toBe("legacy");
  expect(await bindProjectGithubAccount(worktree, "alice")).toEqual({ eligible: true, login: "alice", configured: true });
  expect(await bindProjectGithubAccount(second, "bob")).toEqual({ eligible: true, login: "bob", configured: true });
  process.env.GH_TOKEN = "fixture-changed-ambient";
  expect(await Promise.all([viewer(project), viewer(worktree), viewer(second)])).toEqual(["alice", "alice", "bob"]);
});

test("failed account changes and bad credentials retain the selected account and expose only fixed errors", async () => {
  await bindProjectGithubAccount(project, "alice");
  process.env.ACCOUNT_FIXTURE_DENY = "bob";
  await expect(bindProjectGithubAccount(project, "bob")).rejects.toThrow("has access to this repository");
  await expect(bindProjectGithubAccount(project, "mismatch")).rejects.toThrow("Reconnect @mismatch");
  await expect(bindProjectGithubAccount(project, "missing")).rejects.toThrow(/^access: Reconnect @missing in Settings → Integrations\.$/);
  expect(await viewer(project)).toBe("alice");
  expect(await readProjectGithubAccount(project)).toMatchObject({ login: "alice" });
});

test("the watcher authenticates the pinned viewer and an explicit disconnect invalidates pending and future work", async () => {
  await bindProjectGithubAccount(project, "alice");
  const order = beginWatcherOperation();
  const common = (await reviewGitCommonDir(project))!;
  configureWatcher(project, key, 5, { project: common, order });
  await verifyIdentity(project, key);
  const first = await pollWatcher(project, key);
  expect(first.lastError).toBeNull();
  expect(first.lastSuccessAt).not.toBeNull();
  expect(await bindProjectGithubAccount(worktree, null)).toEqual({ eligible: true, login: null, configured: true });
  expect(readWatcher(project, key).state).toBe("paused");
  expect(await reviewRepositories(project)).toEqual(["org/repo"]);
  await expect(viewer(project)).rejects.toThrow("Choose a GitHub account");
  await expect(verifyIdentity(project, key)).rejects.toThrow("Choose a GitHub account");
  expect((await pollWatcher(project, key)).lastAttemptAt).toBe(first.lastAttemptAt);
  expect(() => configureWatcher(project, key, 5, { project: common, order })).toThrow("account changed");
});

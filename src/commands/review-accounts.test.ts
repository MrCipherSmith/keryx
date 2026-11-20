import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bindProjectGithubAccount, readProjectGithubAccount } from "./review-accounts";
import { boardGraphql, reviewGitCommonDir, reviewRepositories } from "../review/board-github";
import { applyReviewRuleAction } from "../review/review-rules";
import type { ReviewBoardSnapshot, ReviewCard } from "../review/board-types";
import { listGithubAccounts } from "../review/github-cli";
import { verifyIdentity } from "../review/watcher-project";
import { beginWatcherOperation, configureWatcher, pollWatcher, readWatcher } from "../review/watcher";
import { SAFE_BUN_SPAWN_ARGS } from "../lib/safe-exec";
import { fixtureGitEnv, isolateGitDiscovery } from "../review/test-git-fixture";

const key = { repo: "org/repo", repositoryId: "R_test", viewer: "alice" };
const testEnv = ["PATH", "KERYX_DATA_DIR", "GH_TOKEN", "GITHUB_TOKEN", "GH_DEBUG", "ACCOUNT_FIXTURE_DENY", "ACCOUNT_FIXTURE_HOLD"];
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
  delete process.env.ACCOUNT_FIXTURE_HOLD;
  writeFileSync(path.join(root, "gh"), `#!/bin/sh
set -eu
hold() {
  : > "$1.started"
  while [ ! -e "$1.release" ]; do sleep 0.02; done
}
if [ "$1" = auth ]; then
  test -z "${'$'}{GH_TOKEN:-}"
  test -z "${'$'}{GITHUB_TOKEN:-}"
  test -z "${'$'}{GH_DEBUG:-}"
  if [ "$2" = status ]; then
    printf '%s\\n' '[{"login":"alice","active":true,"state":"success","token":"redaction-sentinel"},{"login":"bob","active":false,"state":"success"}]'
    exit
  fi
  test "$2 $3 $4 $5" = 'token --hostname github.com --user'
  if [ "$6" = bob ] && [ -n "${'$'}{ACCOUNT_FIXTURE_HOLD:-}" ]; then hold "$ACCOUNT_FIXTURE_HOLD"; fi
  case "$6" in alice|bob|mismatch) echo "fixture-account-$6"; exit ;; esac
  echo "credential-diagnostic-must-not-escape" >&2
  exit 1
fi
if [ "$1 $2 $3" = 'api --hostname github.com' ]; then
  case "$4" in */notifications*) hold "$ACCOUNT_FIXTURE_HOLD"; echo '[]'; exit ;; esac
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
if [ -f "$PWD/board-fixture.json" ]; then repo="$(cat "$PWD/board-fixture.json")"; fi
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


function waitForFixtureMarker(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(file), check);
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error("The GitHub fixture did not reach its gate."));
    }, 4000);
    function check() {
      if (!existsSync(file)) return;
      watcher.close();
      clearTimeout(timer);
      resolve();
    }
    check();
  });
}

test.each([null, "alice"] as const)("a delayed bind cannot overrule the later selection %p", async (latest) => {
  await bindProjectGithubAccount(project, "alice");
  const gate = path.join(root, "old-bind");
  process.env.ACCOUNT_FIXTURE_HOLD = gate;
  const stale = bindProjectGithubAccount(project, "bob").catch((error: unknown) => error);
  try {
    await waitForFixtureMarker(gate + ".started");
    expect(await bindProjectGithubAccount(worktree, latest)).toMatchObject({ login: latest, configured: true });
  } finally {
    writeFileSync(gate + ".release", "");
  }
  expect(await stale).toMatchObject({ message: "stale: A newer GitHub account selection superseded this request." });
  expect(await readProjectGithubAccount(project)).toMatchObject({ login: latest, configured: true });
});

test("the optional notifications warning cannot expose a board prepared under the previous binding", async () => {
  await bindProjectGithubAccount(project, "alice");
  writeFileSync(path.join(project, "board-fixture.json"), JSON.stringify({
    id: key.repositoryId, nameWithOwner: key.repo, pullRequests: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{
        number: 4, title: "Old account data", state: "OPEN", isDraft: false, author: { login: "alice" },
        headRefOid: "head", baseRefOid: "base", updatedAt: "2026-11-20T00:00:00Z", reviewDecision: null,
        assignees: { pageInfo: { hasNextPage: false }, nodes: [] }, reviewRequests: { pageInfo: { hasNextPage: false }, nodes: [] },
        commits: { nodes: [{ commit: { oid: "head", statusCheckRollup: { state: "SUCCESS", contexts: { totalCount: 1 } } } }] },
      }],
    },
  }));
  const gate = path.join(root, "board-notifications");
  const cli = path.resolve(import.meta.dir, "../cli.ts");
  const child = Bun.spawn([process.execPath, ...SAFE_BUN_SPAWN_ARGS, cli, "review", "board", "--json"], {
    cwd: project, env: { ...process.env, ACCOUNT_FIXTURE_HOLD: gate }, stdout: "pipe", stderr: "pipe",
  });
  const output = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  try {
    await waitForFixtureMarker(gate + ".started");
    await bindProjectGithubAccount(worktree, null);
  } finally {
    writeFileSync(gate + ".release", "");
  }
  const [exit, stdout, stderr] = await output;
  expect(exit).not.toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toContain("GitHub account changed");
});

test("first binding keeps the equivalent watcher and its queued work, but switching accounts cancels it", async () => {
  const differentViewer = { ...key, viewer: "bob" };
  configureWatcher(project, key, 12);
  configureWatcher(project, differentViewer, 8);
  applyReviewRuleAction(project, key, { kind: "save", rule: {
    id: "push", name: "Review pushes", enabled: true, event: "push",
    author: "", assignee: "", reviewer: "", requireGreen: true, budgetMinutes: 5, budgetTokens: null,
  } });
  const card: ReviewCard = {
    number: 4, title: "Test review", url: "", state: "open", draft: false,
    author: "alice", assignees: [], reviewers: [], decision: null, ci: "pending",
    baseSha: "base", headSha: "before", updatedAt: "2026-11-20T00:00:00Z",
  };
  const board = (headSha: string): ReviewBoardSnapshot => ({
    ...key, version: 1, repositories: [key.repo], fetchedAt: "", warnings: [],
    cards: [{ ...card, headSha }],
  });
  await pollWatcher(project, key, { fetch: async () => board("before") });
  const waiting = await pollWatcher(project, key, { fetch: async () => board("after") });
  const ruleStatus = () => applyReviewRuleAction(project, key, { kind: "status", number: 4 }).activity;
  expect(ruleStatus()).toMatchObject([{ state: "waiting", headSha: "after" }]);

  await bindProjectGithubAccount(worktree, "alice");
  expect(readWatcher(project, key)).toMatchObject({
    state: "enabled", intervalMinutes: 12, lastSuccessAt: waiting.lastSuccessAt,
  });
  expect(readWatcher(project, differentViewer).state).toBe("paused");
  expect(ruleStatus()).toMatchObject([{ state: "waiting", headSha: "after" }]);

  await pollWatcher(project, key, { fetch: async () => board("newer") });
  expect(ruleStatus().some(item => item.state === "waiting" && item.headSha === "newer")).toBe(true);
  const preflight = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const green = board("newer");
  green.cards[0]!.ci = "passed";
  let launched = false;
  const tick = pollWatcher(project, key, {
    fetch: async () => green,
    dispatch: async (_cwd, _key, _revision, _schedule, authorize) => {
      preflight.resolve();
      await release.promise;
      return authorize(() => {
        launched = true;
        return { id: "unexpected-previous-account-run" };
      });
    },
  });
  try {
    await Promise.race([preflight.promise, tick.then(() => { throw new Error("The scheduled work did not reach dispatch."); })]);
    await bindProjectGithubAccount(project, "bob");
  } finally {
    release.resolve();
    await tick;
  }
  expect(launched).toBe(false);
  expect(readWatcher(project, key).state).toBe("paused");
  expect(ruleStatus()).toContainEqual(expect.objectContaining({ state: "skipped", headSha: "newer" }));
  expect(ruleStatus().every(item => item.state === "skipped")).toBe(true);
});

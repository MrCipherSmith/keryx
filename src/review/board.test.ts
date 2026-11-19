import { expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReviewBoard } from "../commands/review-board";
import { listReviewCards, verifyScheduledSubject } from "./board";
import { configuredRepositories, selectRepository } from "./board-github";

const repo = "org/base";
const end = { hasNextPage: false, endCursor: null };
const more = { hasNextPage: true, endCursor: "next" };
const identities = (names: string[]) => ({ pageInfo: end, nodes: names.map((login) => ({ login })) });
const card = (number: number) => ({
  number, title: "Discuss API", state: "OPEN", isDraft: true, author: { login: "colleague" },
  headRefOid: "head", baseRefOid: "base", updatedAt: "2026-11-19T00:00:00Z", reviewDecision: null,
  assignees: identities(["assigned"]), reviewRequests: { pageInfo: end, nodes: [{ requestedReviewer: { __typename: "Team", slug: "platform", organization: { login: "org" } } }] },
  commits: { nodes: [{ commit: { oid: "head", statusCheckRollup: { state: "SUCCESS", contexts: { totalCount: 2 } } } }] },
});
const page = (cards: unknown[], pageInfo: typeof end | typeof more) => ({
  viewer: { login: "me" }, repository: { id: "repo-id", nameWithOwner: repo, pullRequests: { nodes: cards, pageInfo } },
});
const queryFrom = (results: unknown[]) => async <T>() => {
  const result = results.shift();
  if (result instanceof Error) throw result;
  return result as T;
};

test("selects origin or an explicitly connected base repo, excludes push URLs and other hosts", () => {
  const repos = configuredRepositories("upstream\tgit@github.com:org/base.git (fetch)\norigin\thttps://github.com/me/fork.git (fetch)\nx\thttps://github.com.evil.invalid/org/other.git (fetch)\nx\thttps://github.com/org/secret.git (push)");
  expect(selectRepository(repos)).toBe("me/fork");
  expect(selectRepository(repos, "ORG/base")).toBe(repo);
  expect(() => selectRepository(repos, "other/base")).toThrow("configuration:");
});

test("--repositories reads configured Git remotes even before any remote or gh access is available", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-remotes-"));
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    execFileSync("git", ["init", "--quiet"], { cwd });
    await runReviewBoard(["--json", "--repositories"], cwd);
    expect(log).toHaveBeenLastCalledWith("[]");
    execFileSync("git", ["remote", "add", "origin", "https://github.com/org/base.git"], { cwd });
    await runReviewBoard(["--json", "--repositories"], cwd);
    expect(log).toHaveBeenLastCalledWith(JSON.stringify([repo]));
    for (const [flag, value] of [["--state", "open"], ["--repo", repo], ["--number", "1"]] as const) {
      await expect(runReviewBoard(["--json", "--repositories", flag, value], cwd)).rejects.toThrow("--repositories");
    }
  } finally {
    log.mockRestore();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Desktop can decode a large Review board from the CLI stdout pipe", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-pipe-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/org/base.git"], { cwd });
    const rows = Array.from({ length: 50 }, (_, i) => ({ ...card(i + 1), title: "ревью ✓".repeat(3_000) }));
    await writeFile(join(cwd, "response.json"), JSON.stringify({ data: page(rows, end) }));
    await writeFile(join(cwd, "gh"), '#!/bin/sh\nexec cat "$PWD/response.json"\n', { mode: 0o700 });
    const cli = Bun.spawn([process.execPath, join(import.meta.dir, "../cli.ts"), "review", "board", "--json"], {
      cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: cwd + ":" + process.env.PATH },
    });
    const [status, output] = await Promise.all([cli.exited, new Response(cli.stdout).text()]);
    expect(status).toBe(0);
    expect(JSON.parse(output).cards.map((item: { title: string }) => item.title)).toEqual(rows.map(item => item.title));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("lists all pages once and maps assignments, team requests and current-head CI", async () => {
  const results = [page([card(1)], more), page([card(1), card(2)], end)];
  const list = await listReviewCards(repo, [repo], "all", queryFrom(results));
  expect(list.cards.map((pr) => pr.number)).toEqual([1, 2]);
  expect(list.cards[0]).toMatchObject({ assignees: ["assigned"], reviewers: ["org/platform"], ci: "passed", draft: true });
  expect(list.warnings).toEqual([]);
});

test("a changed head cannot inherit the previous CI; a failed next page keeps complete earlier rows", async () => {
  const pr = { ...card(3), headRefOid: "new" };
  const result = await listReviewCards(repo, [repo], "open", queryFrom([page([pr], more), new Error("unavailable: network")]));
  expect(result.cards[0]?.ci).toBe("unknown");
  expect(result.warnings.length).toBeGreaterThan(0);
});

test("reported access loss on a later page is fatal", async () => {
  await expect(listReviewCards(repo, [repo], "open", queryFrom([page([card(1)], more), new Error("access: denied")]))).rejects.toThrow("access:");
});

test("a nested page completes the filter values", async () => {
  const pr = { ...card(7), assignees: { nodes: [], pageInfo: more } };
  const result = await listReviewCards(repo, [repo], "open", queryFrom([page([pr], end), { viewer: { login: "me" }, repository: { id: "repo-id", pullRequest: { assignees: identities(["last"]) } } }]));
  expect(result.cards[0]?.assignees).toEqual(["last"]);
  expect(result.warnings).toEqual([]);
});

test("an interrupted reviewers page keeps known names and marks the filter incomplete", async () => {
  const pr = card(9);
  const withMore = { ...pr, reviewRequests: { ...pr.reviewRequests, pageInfo: more } };
  const result = await listReviewCards(repo, [repo], "open", queryFrom([page([withMore], end), new Error("unavailable: offline")]));
  expect(result.cards[0]).toMatchObject({ reviewers: ["org/platform"], reviewersComplete: false });
  expect(result.warnings.length).toBe(1);
});

test("unavailable repository on a nested reviewers page invalidates the private list", async () => {
  const pr = card(9);
  const withMore = { ...pr, reviewRequests: { ...pr.reviewRequests, pageInfo: more } };
  await expect(listReviewCards(repo, [repo], "open", queryFrom([page([withMore], end), { viewer: { login: "me" }, repository: null }]))).rejects.toThrow("access:");
});

test("CI rollup distinguishes red, green, pending, absent and unknown", async () => {
  const states = ["ERROR", "FAILURE", "SUCCESS", "EXPECTED", "PENDING", "new-value", null];
  const rows = states.map((state, i) => ({
    ...card(i + 1),
    commits: { nodes: [{ commit: { oid: "head", statusCheckRollup: state && { state, contexts: { totalCount: 1 } } } }] },
  }));
  const result = await listReviewCards(repo, [repo], "open", queryFrom([page(rows, end)]));
  expect(result.cards.map((pr) => pr.ci)).toEqual(["failed", "failed", "passed", "pending", "pending", "unknown", "none"]);
});

test("incomplete first page and account changes never become an empty successful board", async () => {
  await expect(listReviewCards(repo, [repo], "open", queryFrom([new Error("unavailable: offline")]))).rejects.toThrow("unavailable:");
  const next = { ...page([], end), viewer: { login: "other" } };
  await expect(listReviewCards(repo, [repo], "open", queryFrom([page([card(1)], more), next]))).rejects.toThrow("access:");
});

test("a repeated pagination cursor returns partial without looping", async () => {
  const result = await listReviewCards(repo, [repo], "open", queryFrom([page([card(1)], more), page([card(2)], more)]));
  expect(result.cards.map((pr) => pr.number)).toEqual([1, 2]);
  expect(result.warnings.length).toBe(1);
});

test("watcher reads request identities on both the first and subsequent reviewer pages", async () => {
  const first = card(1);
  const reviewer = (login: string, id: string) => ({id,requestedReviewer:{__typename:"User",login}});
  const responses = [page([{...first,reviewRequests:{pageInfo:more,nodes:[reviewer("Ada","id1")]}}], end),
    {viewer:{login:"me"},repository:{id:"repo-id",pullRequest:{reviewRequests:{pageInfo:end,nodes:[reviewer("BOB","id2")]}}}}];
  const result = await listReviewCards(repo,[repo],"open", async <T>(query: string) => {
    expect(query).toContain("id requestedReviewer");
    return responses.shift() as T;
  }, true);
  expect(result.cards[0]?.reviewRequestIds).toEqual({ada:"id1",bob:"id2"});
});

test("a scheduled run rechecks the current revision, CI, assignee and paginated team request", async () => {
  const key = { repo, repositoryId: "repo-id", viewer: "me", number: 12 };
  const revision = { baseSha: "base", headSha: "head" };
  const rule = { author: "colleague", assignee: "assigned", recipient: "ORG/PLATFORM", requireGreen: true };
  const subject = (pr: unknown) => ({
    viewer: { login: "me" },
    repository: { id: "repo-id", pullRequest: pr },
  });
  const pr = card(12);
  await verifyScheduledSubject(
    key,
    revision,
    rule,
    queryFrom([
      subject({ ...pr, reviewRequests: { nodes: [], pageInfo: more } }),
      subject({ reviewRequests: pr.reviewRequests }),
    ]),
  );
  for (const changed of [
    { ...pr, state: "CLOSED" },
    { ...pr, headRefOid: "moved" },
    { ...pr, baseRefOid: "moved" },
    { ...pr, author: { login: "someone-else" } },
    { ...pr, assignees: identities([]) },
    { ...pr, reviewRequests: { nodes: [], pageInfo: end } },
    { ...pr, commits: { nodes: [] } },
  ])
    await expect(verifyScheduledSubject(key, revision, rule, queryFrom([subject(changed)]))).rejects.toThrow(
      "stale:",
    );
  await expect(
    verifyScheduledSubject(
      key,
      revision,
      rule,
      queryFrom([{ viewer: { login: "someone-else" }, repository: { id: "repo-id", pullRequest: pr } }]),
    ),
  ).rejects.toThrow("access:");
});

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PUBLICATION_RECEIPT } from "../review/desk-publication-types";
import { DeskRunStore } from "../review/desk-run-store";
import type { DeskFinish, DeskRunKey } from "../review/desk-run-types";
import * as boardGithub from "../review/board-github";
import { reviewNeedsViewer, type ReviewCompare } from "../review/review-entity";
import * as boardCommand from "./review-board";
import { MAX_REVIEW_COMPARES, parseCompare, readReviews, REVIEWS_USAGE, runReviewReviews, type CompareHeads } from "./review-reviews";

const sha = (c: string) => c.repeat(40);
const key: DeskRunKey = { repo: "org/repo", repositoryId: "gid", viewer: "user", number: 12 };
const first = { baseSha: sha("a"), headSha: sha("b") };
const second = { baseSha: sha("a"), headSha: sha("c") };
const done = (reviewed: typeof first, findings = { blocker: 0, major: 1, minor: 0, info: 0 }): DeskFinish => ({
  state: "completed", phase: "Complete", reason: "Done",
  result: { reviewed, coverage: "complete", verdict: "COMMENT", report: "private report body", findings },
  usage: { total: { totalTokens: 120 }, coordinator: {}, reviewers: [], partial: false },
});

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "keryx-reviews-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function withStore<T>(fn: (store: DeskRunStore) => T): T {
  const store = new DeskRunStore(root);
  try { return fn(store); } finally { store.close(); }
}
/** Request, start and optionally finish one attempt. */
function attempt(store: DeskRunStore, k: DeskRunKey, revision: typeof first, finish?: DeskFinish) {
  const id = store.atomic(() => store.request("/project", k, revision))!;
  const a = store.byId(id)!;
  a.run.state = "running";
  a.pid = null;
  store.save(a);
  if (finish) store.end(a, finish);
  return id;
}

function prCard(number: number, headSha: string, state = "OPEN") {
  const none = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
  return { number, title: `PR ${number}`, state, isDraft: false, author: { login: "author" }, headRefOid: headSha, baseRefOid: sha("a"),
    updatedAt: "2026-11-20T00:00:00Z", reviewDecision: null, assignees: none, reviewRequests: none,
    commits: { nodes: [{ commit: { oid: headSha, statusCheckRollup: null } }] } };
}
/** A GitHub double: identity, then PR cards by number. Records every query; `fails` refuses a card batch holding that PR. */
function github(heads: Record<number, { head: string; state?: string }>, viewer = "user", fails?: number) {
  const queries: string[] = [];
  const query = async <T>(text: string): Promise<T> => {
    queries.push(text);
    if (text.includes("ReviewIdentity")) return { viewer: { login: viewer }, repository: { id: "gid" } } as T;
    if (fails !== undefined && text.includes(`p${fails}:pullRequest`)) throw new Error("unavailable: GitHub returned 502");
    if (text.includes("ReviewActivePulls")) {
      const repository: Record<string, unknown> = { id: "gid" };
      for (const [, n] of text.matchAll(/p(\d+):pullRequest/g)) {
        const pr = heads[Number(n)];
        repository[`p${n}`] = pr ? prCard(Number(n), pr.head, pr.state) : null;
      }
      return { viewer: { login: viewer }, repository } as T;
    }
    throw new Error(`unexpected query ${text.slice(0, 40)}`);
  };
  return { query, queries };
}
const comparing = (result: ReviewCompare | Error = { status: "ahead", aheadBy: 2 }) => {
  const calls: [string, string][] = [];
  const compare: CompareHeads = async (base, head) => {
    calls.push([base, head]);
    if (result instanceof Error) throw result;
    return result;
  };
  return { compare, calls };
};
const source = (gh: ReturnType<typeof github>, compare: CompareHeads) =>
  ({ repo: "org/repo", repositories: ["org/repo"], query: gh.query, compare, root });
/** Rewrite stored rows directly: an attempt's creation time, or a Review's local close. */
function editStore(sql: string, params: (string | number)[]) {
  const db = new Database(path.join(root, "runs.sqlite"));
  try { db.run(sql, params); } finally { db.close(); }
}
const prHead = (n: number) => n.toString(16).padStart(2, "0").repeat(20);

test("a missing store returns an empty list without creating one or reading PRs", async () => {
  const gh = github({});
  const cmp = comparing();
  const result = await readReviews(source(gh, cmp.compare));
  expect(result).toMatchObject({ version: 1, repo: "org/repo", repositories: ["org/repo"], repositoryId: "gid", viewer: "user", reviews: [], warnings: [] });
  expect(Object.keys(result)).toEqual(["version", "repo", "repositories", "repositoryId", "viewer", "fetchedAt", "reviews", "warnings"]);
  expect(existsSync(path.join(root, "runs.sqlite"))).toBe(false);
  expect(gh.queries).toHaveLength(1);
  expect(cmp.calls).toHaveLength(0);
});

test("one summary per Review with state, freshness, rounds and latest findings; no reports", async () => {
  const ids = withStore(store => {
    const r1 = attempt(store, key, first, done(first, { blocker: 1, major: 0, minor: 0, info: 0 }));
    const r2 = attempt(store, key, second, done(second));
    mkdirSync(store.directory(r2), { recursive: true });
    writeFileSync(path.join(store.directory(r2), PUBLICATION_RECEIPT), JSON.stringify({ url: "https://github.com/org/repo/pull/12#r" }));
    // Another viewer's Review and a deleted attempt stay out of this account's list; an archived one is kept, flagged.
    attempt(store, { ...key, viewer: "colleague", number: 13 }, first, done(first));
    const archived = attempt(store, { ...key, number: 14 }, first, done(first));
    const a = store.byId(archived)!;
    a.run.decision = { action: "archive", reason: "noise", at: "2026-11-20T00:00:00Z" };
    store.save(a);
    const deleted = attempt(store, { ...key, number: 16 }, first, done(first));
    const d = store.byId(deleted)!;
    d.run.decision = { action: "delete", reason: "noise", at: "2026-11-20T00:00:00Z" };
    store.save(d);
    const running = attempt(store, { ...key, number: 15 }, first);
    store.openQuestion(running, { id: "q1", question: "Which?", options: [{ id: "a", label: "A", description: "" }], allowFreeform: false });
    return { r1, r2, running };
  });
  const gh = github({ 12: { head: sha("d") }, 14: { head: sha("b") }, 15: { head: sha("b") }, 16: { head: sha("b") } });
  const cmp = comparing({ status: "ahead", aheadBy: 3 });
  const result = await readReviews(source(gh, cmp.compare));

  expect(result.reviews.map(r => r.number)).toEqual([15, 14, 12]);
  const [waiting, archivedReview, published] = result.reviews;
  expect(archivedReview).toMatchObject({ archived: true, state: "ready", reviewed: first });
  expect(archivedReview!.rounds[0]!.attempts[0]).toMatchObject({ archived: true, decision: "archive" });
  expect(reviewNeedsViewer(archivedReview!)).toBe(false);
  expect(waiting).toMatchObject({ state: "needs_answer", freshness: { kind: "current" }, latestRound: 1, findings: null });
  expect(published).toMatchObject({
    state: "published", latestRound: 2, tokens: 240, source: "manual", onHeadMove: "ask", closedAt: null,
    findings: { blocker: 0, major: 1, minor: 0, info: 0 }, publication: "published",
    freshness: { kind: "behind", commits: 3, rewritten: false }, reviewed: second, archived: false,
  });
  expect(published!.card?.headSha).toBe(sha("d"));
  expect(published!.rounds.map(r => [r.number, r.headSha, r.previousRunId])).toEqual([[2, sha("c"), ids.r1], [1, sha("b"), null]]);
  expect(published!.rounds[0]!.attempts.map(a => a.id)).toEqual([ids.r2]);
  expect(cmp.calls).toEqual([[sha("c"), sha("d")]]);
  expect(JSON.stringify(result)).not.toContain("private report body");
  expect(JSON.stringify(result)).not.toContain("reviewerProgress");
});

test("a failed comparison leaves the count unknown and warns; a closed PR is not compared", async () => {
  withStore(store => {
    attempt(store, key, first, done(first));
    attempt(store, { ...key, number: 20 }, first, done(first));
  });
  const cmp = comparing(new Error("unavailable: rate limit"));
  const result = await readReviews(source(github({ 12: { head: sha("d") }, 20: { head: sha("e"), state: "MERGED" } }), cmp.compare));
  const byNumber = new Map(result.reviews.map(r => [r.number, r]));
  expect(byNumber.get(12)).toMatchObject({ state: "ready", freshness: { kind: "behind", commits: null, rewritten: false } });
  expect(byNumber.get(20)).toMatchObject({ state: "closed", freshness: { kind: "behind", commits: null } });
  expect(cmp.calls).toHaveLength(1);
  expect(result.warnings).toEqual(["Some commit counts could not be read. Refresh to retry."]);
});

test(`at most ${MAX_REVIEW_COMPARES} comparisons per call, for the Reviews with the newest activity`, async () => {
  const heads: Record<number, { head: string }> = {};
  const ids = withStore(store => {
    const created: Record<number, string> = {};
    for (let n = 1; n <= MAX_REVIEW_COMPARES + 2; n++) {
      created[n] = attempt(store, { ...key, number: n }, first, done(first));
      heads[n] = { head: prHead(n) };
    }
    return created;
  });
  // The lowest PR numbers have the newest activity, so they are listed first and are the ones compared.
  for (const [n, id] of Object.entries(ids)) {
    editStore("UPDATE runs SET details=json_set(details,'$.createdAt',?) WHERE id=?", [`2026-11-${String(40 - Number(n)).padStart(2, "0")}T00:00:00.000Z`, id]);
  }
  const cmp = comparing();
  const result = await readReviews(source(github(heads), cmp.compare));
  expect(result.reviews).toHaveLength(MAX_REVIEW_COMPARES + 2);
  expect(result.reviews.map(r => r.number).slice(0, 3)).toEqual([1, 2, 3]);
  expect(cmp.calls.map(([, head]) => parseInt(head.slice(0, 2), 16)).sort((a, b) => a - b))
    .toEqual(Array.from({ length: MAX_REVIEW_COMPARES }, (_, i) => i + 1));
  expect(result.reviews.filter(r => r.freshness.kind === "behind" && r.freshness.commits === null).map(r => r.number)).toEqual([26, 27]);
  expect(result.warnings).toHaveLength(1);
});

test(`exactly ${MAX_REVIEW_COMPARES} Reviews behind are all compared without a warning`, async () => {
  const heads: Record<number, { head: string }> = {};
  withStore(store => {
    for (let n = 1; n <= MAX_REVIEW_COMPARES; n++) {
      attempt(store, { ...key, number: n }, first, done(first));
      heads[n] = { head: prHead(n) };
    }
  });
  const cmp = comparing();
  const result = await readReviews(source(github(heads), cmp.compare));
  expect(cmp.calls).toHaveLength(MAX_REVIEW_COMPARES);
  expect(result.warnings).toEqual([]);
});

test("comparisons that outlast the deadline leave the count unknown with one warning", async () => {
  withStore(store => {
    attempt(store, key, first, done(first));
    attempt(store, { ...key, number: 13 }, first, done(first));
  });
  const calls: string[] = [];
  const compare: CompareHeads = (_base, head) => {
    calls.push(head);
    return head === sha("d") ? Promise.resolve({ status: "ahead", aheadBy: 1 }) : new Promise<ReviewCompare>(() => {});
  };
  const started = Date.now();
  const result = await readReviews({ ...source(github({ 12: { head: sha("d") }, 13: { head: sha("e") } }), compare), compareBudgetMs: 50 });
  expect(Date.now() - started).toBeLessThan(2000);
  const byNumber = new Map(result.reviews.map(r => [r.number, r]));
  expect(byNumber.get(12)?.freshness).toEqual({ kind: "behind", commits: 1, rewritten: false });
  expect(byNumber.get(13)?.freshness).toEqual({ kind: "behind", commits: null, rewritten: false });
  expect(result.warnings).toEqual(["Some commit counts took too long to read. Refresh to retry."]);
});

test("a reviewed head that is not a full object id is never sent to GitHub", async () => {
  const named = { baseSha: sha("a"), headSha: "main" };
  withStore(store => attempt(store, key, named, done(named)));
  const cmp = comparing();
  const result = await readReviews(source(github({ 12: { head: sha("d") } }), cmp.compare));
  expect(cmp.calls).toHaveLength(0);
  expect(result.reviews[0]?.freshness).toEqual({ kind: "behind", commits: null, rewritten: false });
});

test("a Review closed locally is not read from GitHub", async () => {
  withStore(store => {
    attempt(store, key, first, done(first));
    attempt(store, { ...key, number: 13 }, first, done(first));
  });
  editStore("UPDATE reviews SET closed_at=? WHERE pr=?", ["2026-11-21T00:00:00Z", 12]);
  const gh = github({ 12: { head: sha("d") }, 13: { head: sha("b") } });
  const result = await readReviews(source(gh, comparing().compare));
  const cardQueries = gh.queries.filter(text => text.includes("ReviewActivePulls"));
  expect(cardQueries.join("\n")).not.toContain("p12:pullRequest");
  expect(cardQueries.join("\n")).toContain("p13:pullRequest");
  expect(new Map(result.reviews.map(r => [r.number, r.state])).get(12)).toBe("closed");
  expect(result.reviews.find(r => r.number === 12)?.card).toBeNull();

  // Opt-in for "Show closed": the closed Review's card is read too, and it still is not compared.
  const shown = github({ 12: { head: sha("d") }, 13: { head: sha("b") } });
  const cmp = comparing();
  const withClosed = await readReviews({ ...source(shown, cmp.compare), includeClosed: true });
  expect(shown.queries.filter(text => text.includes("ReviewActivePulls")).join("\n")).toContain("p12:pullRequest");
  expect(withClosed.reviews.find(r => r.number === 12)).toMatchObject({ state: "closed", card: { number: 12, headSha: sha("d") } });
  expect(cmp.calls).toHaveLength(0);
});

test("one failed card batch keeps the cards of the others; its Reviews do not count as waiting on the viewer", async () => {
  const heads: Record<number, { head: string; state?: string }> = {};
  withStore(store => {
    for (let n = 1; n <= 25; n++) {
      attempt(store, { ...key, number: n }, first, done(first));
      heads[n] = { head: sha("b"), state: "MERGED" };
    }
  });
  // Batches hold 20 numbers, newest PR first: 25..6 and 5..1. The second one fails.
  const result = await readReviews(source(github(heads, "user", 3), comparing().compare));
  const byNumber = new Map(result.reviews.map(r => [r.number, r]));
  expect(byNumber.get(25)).toMatchObject({ state: "closed" });
  expect(byNumber.get(6)).toMatchObject({ state: "closed" });
  expect(byNumber.get(3)).toMatchObject({ card: null, state: "ready", publication: "pending" });
  expect(result.reviews.filter(reviewNeedsViewer)).toEqual([]);
  expect(result.warnings).toEqual(["Some pull requests could not be loaded. Refresh to retry."]);
});

test("PRs that cannot be read leave cards empty with a warning; an access failure is not retained", async () => {
  withStore(store => attempt(store, key, first, done(first)));
  const failing = (message: string) => ({ ...github({}), query: async <T>(text: string): Promise<T> => {
    if (text.includes("ReviewIdentity")) return { viewer: { login: "user" }, repository: { id: "gid" } } as T;
    throw new Error(message);
  } });
  const result = await readReviews(source(failing("unavailable: GitHub is down"), comparing().compare));
  expect(result.reviews[0]).toMatchObject({ card: null, state: "ready", freshness: { kind: "unknown" } });
  expect(result.warnings).toEqual(["Some pull requests could not be loaded. Refresh to retry."]);
  await expect(readReviews(source(failing("access: account changed"), comparing().compare))).rejects.toThrow("access:");
});

test("a PR GitHub does not return leaves its head unknown and is not compared", async () => {
  withStore(store => {
    attempt(store, key, first, done(first));
    attempt(store, { ...key, number: 21 }, first, done(first));
  });
  const cmp = comparing();
  const result = await readReviews(source(github({ 12: { head: sha("b") } }), cmp.compare));
  const byNumber = new Map(result.reviews.map(r => [r.number, r]));
  expect(byNumber.get(21)).toMatchObject({ card: null, state: "ready", freshness: { kind: "unknown" } });
  expect(byNumber.get(12)).toMatchObject({ state: "ready", freshness: { kind: "current" } });
  expect(cmp.calls).toHaveLength(0);
});

test("an unidentified account or repository is refused", async () => {
  const query = async <T>(): Promise<T> => ({ viewer: null, repository: null }) as T;
  await expect(readReviews({ repo: "org/repo", repositories: [], query, compare: comparing().compare, root })).rejects.toThrow("access:");
});

test("a store that predates Reviews is migrated when it is read", async () => {
  mkdirSync(root, { recursive: true });
  const db = new Database(path.join(root, "runs.sqlite"));
  db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, pr INTEGER NOT NULL, viewer TEXT COLLATE NOCASE NOT NULL,
    state TEXT NOT NULL, pid INTEGER, cwd TEXT NOT NULL, request TEXT NOT NULL, details TEXT NOT NULL)`);
  const details = { id: "old-run", source: "manual", ...first, state: "failed", phase: "Failed", reason: "x",
    createdAt: "2026-10-01T00:00:00.000Z", startedAt: null, finishedAt: null, result: null };
  db.run("INSERT INTO runs (id,repo,pr,viewer,state,cwd,request,details) VALUES (?,?,?,?,?,?,?,?)",
    ["old-run", "gid", 12, "USER", "failed", "/p", JSON.stringify(key), JSON.stringify(details)]);
  db.close();
  const result = await readReviews(source(github({ 12: { head: sha("b") } }), comparing().compare));
  expect(result.reviews).toHaveLength(1);
  expect(result.reviews[0]).toMatchObject({ number: 12, state: "stopped", latestRound: 1 });
  expect(result.reviews[0]!.rounds[0]!.attempts.map(a => a.id)).toEqual(["old-run"]);
});

test("parseCompare reads only a known status and a non-negative count", () => {
  expect(parseCompare('{"status":"diverged","ahead_by":2}')).toEqual({ status: "diverged", aheadBy: 2 });
  expect(() => parseCompare('{"status":"weird","ahead_by":2}')).toThrow("unavailable:");
  expect(() => parseCompare('{"status":"ahead","ahead_by":-1}')).toThrow("unavailable:");
  expect(() => parseCompare('{"status":"ahead","ahead_by":"2"}')).toThrow("unavailable:");
});

test("the command needs --json, refuses unknown flags and prints its usage on --help", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runReviewReviews(["--help"], root);
    expect(log).toHaveBeenLastCalledWith(REVIEWS_USAGE);
  } finally { log.mockRestore(); }
  await expect(runReviewReviews([], root)).rejects.toThrow(REVIEWS_USAGE);
  await expect(runReviewReviews(["--json", "--state", "open"], root)).rejects.toThrow("--state");
  await expect(runReviewReviews(["--json", "--include-closed=yes"], root)).rejects.toThrow("--include-closed");
  await expect(runReviewReviews(["--json", "extra"], root)).rejects.toThrow(/positional/i);
});

test("the GitHub-bound JSON writer lives with the GitHub binding; the board command keeps its own private", () => {
  expect(typeof boardGithub.writeBoundJson).toBe("function");
  expect(Object.keys(boardCommand)).not.toContain("writeJson");
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendNote,
  listReviewStates,
  markReview,
  openReviewRound,
  readReviewState,
  recordPublication,
  reviewJournalPath,
  reviewStatePath,
  ReviewStateError,
  roundTransitionAllowed,
  updateReviewRound,
  type OpenRoundInput,
} from "./review-state";

const sha = (c: string) => c.repeat(40);
const pr = { repo: "Org/Repo", number: 7, url: "https://github.com/Org/Repo/pull/7" };
const ID = "org-repo-7-alice";
let root: string;
let tick = 0;
const now = () => new Date(Date.UTC(2026, 10, 25, 0, 0, tick++));
const opts = { now };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-review-state-"));
  mkdirSync(path.join(root, ".metaproject"));
  tick = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function open(over: Partial<OpenRoundInput> = {}) {
  return openReviewRound(root, { pr, viewer: "alice", baseSha: sha("a"), headSha: sha("b"), settingsKey: "k1", sessionId: "s1", ...over }, opts);
}
const journal = () => readFileSync(reviewJournalPath(root, ID), "utf8").trimEnd().split("\n");

async function refused(promise: Promise<unknown>, code: string, pattern: RegExp): Promise<void> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ReviewStateError);
  expect((error as ReviewStateError).code).toBe(code as ReviewStateError["code"]);
  expect((error as Error).message).toMatch(pattern);
}

describe("round rule R5 (AC2)", () => {
  test("the first open creates round 1 with the session as start", async () => {
    const result = await open();
    expect(result.action).toBe("created");
    expect(result.round).toMatchObject({ number: 1, previousRound: null, state: "planning", settingsKey: "k1", sessionId: "s1", package: null });
    expect(result.round.sessions).toEqual([{ id: "s1", openedAt: "2026-11-25T00:00:00.000Z", reason: "start" }]);
    expect(result.review).toMatchObject({ schema: "keryx.review", version: 1, id: ID, state: "reviewing", onHeadMove: "ask", source: "session", viewer: "alice" });
    const stored = JSON.parse(readFileSync(reviewStatePath(root, ID), "utf8"));
    expect(stored.rounds).toHaveLength(1);
    expect(path.relative(root, reviewStatePath(root, ID))).toBe(`.metaproject/reviews/pr/${ID}/review.json`);
  });

  test("the same base, head and key from another session reuses the round and records both sessions", async () => {
    await open();
    await updateReviewRound(root, ID, { state: "dispatching" }, opts);
    const result = await open({ sessionId: "s2" });
    expect(result.action).toBe("reused");
    expect(result.round.number).toBe(1);
    expect(result.round.state).toBe("dispatching");
    expect(result.round.sessionId).toBe("s2");
    expect(result.round.sessions.map((s) => [s.id, s.reason])).toEqual([["s1", "start"], ["s2", "restart"]]);
    expect(result.review.rounds).toHaveLength(1);
  });

  test("the same session again reuses without a new session entry", async () => {
    await open();
    const result = await open();
    expect(result.action).toBe("reused");
    expect(result.round.sessions).toHaveLength(1);
  });

  test("a new head opens round 2 with previousRound 1", async () => {
    await open();
    const result = await open({ headSha: sha("c") });
    expect(result.action).toBe("advanced");
    expect(result.round).toMatchObject({ number: 2, previousRound: 1, headSha: sha("c"), state: "planning" });
    expect(result.review.rounds.map((r) => r.number)).toEqual([1, 2]);
  });

  test("a different settings key opens round 2", async () => {
    await open();
    const result = await open({ settingsKey: "k2" });
    expect(result.action).toBe("advanced");
    expect(result.round).toMatchObject({ number: 2, previousRound: 1, settingsKey: "k2" });
  });

  test("an unknown settings key on either side matches any key", async () => {
    await open({ settingsKey: null });
    expect((await open({ settingsKey: "k9" })).action).toBe("reused");
    expect((await open({ settingsKey: null })).action).toBe("reused");
  });

  test("an older round's revision is not resurrected: only the last round is compared", async () => {
    await open();
    await open({ headSha: sha("c") });
    const result = await open();
    expect(result.action).toBe("advanced");
    expect(result.round.number).toBe(3);
  });

  test("a stale review goes back to reviewing on a new round", async () => {
    await open();
    await markReview(root, ID, "stale", opts);
    expect((await open({ headSha: sha("c") })).review.state).toBe("reviewing");
  });

  test("a closed review is refused without reopen and reopened with it", async () => {
    await open();
    await markReview(root, ID, "closed", opts);
    await refused(open(), "refused", /closed; pass --reopen/);
    const result = await open({ reopen: true });
    expect(result.action).toBe("reused");
    expect(result.review.state).toBe("reviewing");
  });

  test("short or non-hex SHAs are invalid and nothing is written", async () => {
    await refused(open({ headSha: "abc123" }), "invalid", /head must be a full 40-character SHA/);
    expect(existsSync(reviewStatePath(root, ID))).toBe(false);
  });

  test("a review without a viewer has the bare PR id", async () => {
    const result = await open({ viewer: null });
    expect(result.review.id).toBe("org-repo-7");
  });
});

describe("round updates (AC3)", () => {
  test("forward transitions, a skip, and paused round trips", async () => {
    await open();
    expect((await updateReviewRound(root, ID, { state: "dispatching" }, opts)).round.state).toBe("dispatching");
    expect((await updateReviewRound(root, ID, { state: "paused" }, opts)).round.state).toBe("paused");
    expect((await updateReviewRound(root, ID, { state: "planning" }, opts)).round.state).toBe("planning");
    // A missed call is recovered by the next one: planning straight to reconciling.
    expect((await updateReviewRound(root, ID, { state: "reconciling" }, opts)).round.state).toBe("reconciling");
    const ready = await updateReviewRound(root, ID, { state: "ready", verdict: "comment" }, opts);
    expect(ready.round.state).toBe("ready");
    expect(ready.review.state).toBe("ready");
  });

  test("backward moves outside paused are refused", async () => {
    await open();
    await updateReviewRound(root, ID, { state: "reconciling" }, opts);
    await refused(updateReviewRound(root, ID, { state: "planning" }, opts), "refused", /cannot go from reconciling to planning/);
    expect(roundTransitionAllowed("paused", "ready")).toBe(false);
    expect(roundTransitionAllowed("ready", "paused")).toBe(false);
    expect(roundTransitionAllowed("dispatching", "dispatching")).toBe(true);
  });

  test("a ready round takes only verdict, findings and usage", async () => {
    await open();
    await updateReviewRound(root, ID, { state: "ready" }, opts);
    const before = readFileSync(reviewStatePath(root, ID), "utf8");
    await refused(updateReviewRound(root, ID, { plan: { slices: 1, waves: 1, assignments: { done: 0, total: 1 } } }, opts), "refused", /ready; it takes only/);
    await refused(updateReviewRound(root, ID, { reviewers: [{ role: "review-logic", state: "done" }] }, opts), "refused", /refused: reviewers/);
    await refused(updateReviewRound(root, ID, { state: "paused" }, opts), "refused", /refused: state/);
    await refused(updateReviewRound(root, ID, { package: ".metaproject/reviews/x" }, opts), "refused", /refused: package/);
    expect(readFileSync(reviewStatePath(root, ID), "utf8")).toBe(before);
    const after = await updateReviewRound(root, ID, {
      verdict: "approve", usage: { tokens: 900, costUsd: 1.5 },
      findings: { blocker: 0, major: 1, minor: 2, info: 0, carried: 1, rechecked: 0 },
    }, opts);
    expect(after.round).toMatchObject({ verdict: "approve", usage: { tokens: 900, costUsd: 1.5 }, findings: { major: 1, carried: 1 } });
  });

  test("plan, reviewers merged by role, usage replaced, package made project-relative, session restart", async () => {
    await open();
    await updateReviewRound(root, ID, { package: path.join(root, ".metaproject/reviews/rv-1"), state: "planning" }, opts);
    await updateReviewRound(root, ID, { state: "dispatching", plan: { slices: 3, waves: 2, assignments: { done: 0, total: 6 } } }, opts);
    await updateReviewRound(root, ID, { reviewers: [{ role: "review-logic", state: "running" }, { role: "review-testing", state: "running" }], usage: { tokens: 100, costUsd: null } }, opts);
    const result = await updateReviewRound(root, ID, { reviewers: [{ role: "review-logic", state: "done", findings: 2 }], usage: { tokens: 50, costUsd: 0.2 }, sessionId: "s3" }, opts);
    expect(result.round.package).toBe(".metaproject/reviews/rv-1");
    expect(result.round.plan).toEqual({ slices: 3, waves: 2, assignments: { done: 0, total: 6 } });
    expect(result.round.reviewers).toEqual([{ role: "review-logic", state: "done", findings: 2 }, { role: "review-testing", state: "running" }]);
    expect(result.round.usage).toEqual({ tokens: 50, costUsd: 0.2 });
    expect(result.round.sessionId).toBe("s3");
    expect(result.round.sessions.map((s) => s.reason)).toEqual(["start", "restart"]);
  });

  test("a package outside the project is refused", async () => {
    await open();
    await refused(updateReviewRound(root, ID, { package: "../elsewhere" }, opts), "invalid", /not a directory inside the project/);
  });

  test("an unknown review or round is not-found", async () => {
    await refused(updateReviewRound(root, ID, { state: "paused" }, opts), "not-found", /no review/);
    await open();
    await refused(updateReviewRound(root, ID, { round: 4, state: "paused" }, opts), "not-found", /no round 4/);
  });

  test("updating an older round leaves the review state alone", async () => {
    await open();
    await open({ headSha: sha("c") });
    const result = await updateReviewRound(root, ID, { round: 1, state: "ready" }, opts);
    expect(result.round.number).toBe(1);
    expect(result.review.state).toBe("reviewing");
  });
});

describe("publish, mark, note, list", () => {
  test("publish records the round's head and marks the review published; mark ready re-derives", async () => {
    await open();
    await updateReviewRound(root, ID, { state: "ready", verdict: "comment" }, opts);
    const published = await recordPublication(root, ID, { verdict: "comment", url: "https://github.com/Org/Repo/pull/7#r1" }, opts);
    expect(published.review.state).toBe("published");
    expect(published.review.publications).toEqual([{ round: 1, headSha: sha("b"), verdict: "comment", url: "https://github.com/Org/Repo/pull/7#r1", at: "2026-11-25T00:00:02.000Z" }]);
    await markReview(root, ID, "stale", opts);
    expect((await markReview(root, ID, "ready", opts)).review.state).toBe("published");
  });

  test("mark refuses a review without rounds and anything but closed on a closed review", async () => {
    await open();
    await markReview(root, ID, "closed", opts);
    await refused(markReview(root, ID, "ready", opts), "refused", /closed/);
    await refused(recordPublication(root, ID, { verdict: "approve" }, opts), "refused", /closed/);
  });

  test("a note appends one line and leaves review.json byte-for-byte", async () => {
    await open();
    const before = readFileSync(reviewStatePath(root, ID), "utf8");
    await appendNote(root, ID, "provider failed:\n  rate limit", opts);
    expect(readFileSync(reviewStatePath(root, ID), "utf8")).toBe(before);
    expect(journal().at(-1)).toBe("- 2026-11-25T00:00:01.000Z note provider failed: rate limit");
  });

  test("every write appends exactly one journal line", async () => {
    await open();
    await open({ sessionId: "s2" });
    await updateReviewRound(root, ID, { state: "dispatching" }, opts);
    await updateReviewRound(root, ID, { state: "ready" }, opts);
    await recordPublication(root, ID, { verdict: "approve" }, opts);
    await markReview(root, ID, "stale", opts);
    await appendNote(root, ID, "done", opts);
    const lines = journal();
    expect(lines).toHaveLength(7);
    expect(lines.map((line) => line.split(" ")[2])).toEqual(["open", "open", "round", "round", "publish", "mark", "note"]);
    for (const line of lines) expect(line).toMatch(/^- \d{4}-\d\d-\d\dT[\d:.]+Z \w+ \S/);
    // A refused write adds nothing.
    await refused(updateReviewRound(root, ID, { state: "paused" }, opts), "refused", /ready/);
    expect(journal()).toHaveLength(7);
  });

  test("updatedAt moves on every write", async () => {
    const first = await open();
    const second = await updateReviewRound(root, ID, { state: "dispatching" }, opts);
    expect(second.review.updatedAt > first.review.updatedAt).toBe(true);
    expect(second.review.createdAt).toBe(first.review.createdAt);
  });

  test("list returns every review by id and reports a foreign one", async () => {
    await open();
    await open({ viewer: null });
    const foreignDir = path.join(root, ".metaproject/reviews/pr/zz-foreign-1");
    mkdirSync(foreignDir, { recursive: true });
    writeFileSync(path.join(foreignDir, "review.json"), JSON.stringify({ schema: "keryx.review", version: 2 }));
    mkdirSync(path.join(root, ".metaproject/reviews/pr/empty-dir"), { recursive: true });
    const listing = await listReviewStates(root);
    expect(listing.reviews.map((r) => r.id)).toEqual(["org-repo-7", ID]);
    expect(listing.unreadable).toEqual([expect.objectContaining({ id: "zz-foreign-1", code: "foreign" })]);
  });

  test("list of a project with no reviews is empty", async () => {
    expect(await listReviewStates(root)).toEqual({ reviews: [], unreadable: [] });
  });
});

describe("foreign schema or version (AC3)", () => {
  for (const foreign of [{ schema: "keryx.review", version: 2, id: ID }, { schema: "other", version: 1, id: ID }]) {
    test(`${foreign.schema} v${foreign.version} is reported and never rewritten`, async () => {
      const file = reviewStatePath(root, ID);
      mkdirSync(path.dirname(file), { recursive: true });
      const text = `${JSON.stringify({ ...foreign, rounds: [], publications: [], pr }, null, 4)}\n`;
      writeFileSync(file, text);
      await refused(readReviewState(root, ID), "foreign", /leaves it unchanged/);
      await refused(open(), "foreign", /schema/);
      await refused(updateReviewRound(root, ID, { state: "paused" }, opts), "foreign", /schema/);
      await refused(recordPublication(root, ID, { verdict: "approve" }, opts), "foreign", /schema/);
      await refused(markReview(root, ID, "closed", opts), "foreign", /schema/);
      await refused(appendNote(root, ID, "x", opts), "foreign", /schema/);
      expect(readFileSync(file, "utf8")).toBe(text);
      expect(existsSync(reviewJournalPath(root, ID))).toBe(false);
    });
  }

  test("a broken file is unreadable, not foreign", async () => {
    const file = reviewStatePath(root, ID);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{not json");
    await refused(readReviewState(root, ID), "unreadable", /not valid JSON/);
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  test("a missing review reads as null", async () => {
    expect(await readReviewState(root, ID)).toBeNull();
  });
});

describe("lock and atomic write (AC3)", () => {
  test("concurrent opens of the same revision yield one round with both sessions", async () => {
    const [a, b] = await Promise.all([open({ sessionId: "s1" }), open({ sessionId: "s2" })]);
    expect([a.action, b.action].sort()).toEqual(["created", "reused"]);
    const review = await readReviewState(root, ID);
    expect(review?.rounds).toHaveLength(1);
    expect(review?.rounds[0]?.sessions.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    expect(journal()).toHaveLength(2);
  });

  test("concurrent opens of two heads yield rounds 1 and 2, never two round 1s", async () => {
    await Promise.all([open({ headSha: sha("c") }), open({ headSha: sha("d") })]);
    const review = await readReviewState(root, ID);
    expect(review?.rounds.map((r) => [r.number, r.previousRound])).toEqual([[1, null], [2, 1]]);
  });

  test("no temp file or lock is left behind", async () => {
    await open();
    await updateReviewRound(root, ID, { state: "dispatching" }, opts);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(path.dirname(reviewStatePath(root, ID))).sort()).toEqual(["journal.md", "review.json"]);
  });
});

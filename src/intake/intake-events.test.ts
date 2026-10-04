// AC1 (flow 403): a poll over a fake `gh` and a fake board raises events of the five kinds, each with its key.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runIntakePoll } from "./poll";
import { readIntakeCardViews } from "./store";
import { FakeGh, FakeSink, OTHER_REPO, REPO, TestClock, depsFor, issuesJson, local, ownPrsJson, reviewsJson, runsJson, setupIntakeEnv, testConfig, type IntakeTestEnv } from "./intake.test-helpers";
import { parseAssignedIssues, parseFailedRuns, parseOwnPrs, parseReviewRequests } from "./events";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
  env.setBoard([{ id: "F1", title: "A flow", status: "open" }]);
});
afterEach(async () => {
  await env.teardown();
});

describe("AC1: the five kinds of event and their keys", () => {
  test("a poll after the baseline raises one card per event, keyed as the PRD says", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const deps = depsFor(env, { gh, clock, config: testConfig() });
    await runIntakePoll(env.root, deps);

    clock.advance(11 * 60_000);
    gh.set("issue", issuesJson([{ number: 12, updatedAt: "2026-10-05T09:00:00Z" }]));
    gh.set("review", reviewsJson([{ number: 30, updatedAt: "2026-10-05T09:01:00Z" }]));
    gh.set(
      "pr",
      ownPrsJson([
        {
          number: 7,
          updatedAt: "2026-10-05T09:02:00Z",
          comments: [
            { id: "IC_1", author: "carol", createdAt: "2026-10-05T09:02:00Z" },
            { id: "IC_mine", author: "me", createdAt: "2026-10-05T09:03:00Z", viewerDidAuthor: true },
          ],
        },
      ]),
    );
    gh.set(
      "ci",
      runsJson([
        { id: 900, branch: "own-7", createdAt: "2026-10-05T09:04:00Z" },
        { id: 901, branch: "somebody-elses", createdAt: "2026-10-05T09:05:00Z" },
      ]),
    );
    env.setBoard([{ id: "F1", title: "A flow", status: "closed", closedAt: "2026-10-05" }]);

    const result = await runIntakePoll(env.root, deps);
    expect(result.outcome).toBe("ok");
    expect(result.newEvents).toBe(5);
    const cards = await readIntakeCardViews(env.root);
    expect(cards.map((c) => c.eventKey).sort()).toEqual(
      [`board:F1`, `ci:${REPO}:900`, `comment:${REPO}#7:IC_1`, `issue:${REPO}#12`, `review:${REPO}#30`].sort(),
    );
    expect(Object.fromEntries(cards.map((c) => [c.kind, c.repo ?? null]))).toEqual({ issue: REPO, review: REPO, ci: REPO, comment: REPO, board: null });
  });

  test("every configured repository is read, and an event carries its own repository", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const deps = depsFor(env, { gh, clock, config: testConfig({ repos: [REPO, OTHER_REPO] }) });
    await runIntakePoll(env.root, deps);
    clock.advance(11 * 60_000);
    gh.set("issue", issuesJson([{ number: 3, updatedAt: "2026-10-05T09:00:00Z" }], OTHER_REPO), OTHER_REPO);
    await runIntakePoll(env.root, deps);
    const cards = await readIntakeCardViews(env.root);
    expect(cards.map((c) => c.eventKey)).toEqual([`issue:${OTHER_REPO}#3`]);
    expect(new Set(gh.calls.map((c) => c.repo))).toEqual(new Set([REPO, OTHER_REPO]));
  });

  test("the parsers drop rows without a number or a stamp and refuse non-JSON", () => {
    expect(parseAssignedIssues(REPO, "[{\"title\":\"no number\",\"updatedAt\":\"x\"}]")).toEqual([]);
    expect(parseAssignedIssues(REPO, "not json")).toEqual({ error: "gh did not answer with JSON" });
    expect(parseReviewRequests(REPO, "{}")).toEqual({ error: "gh answered with something other than a list" });
    expect(parseFailedRuns(REPO, runsJson([{ id: 1, branch: "b", createdAt: "t" }]), new Set())).toEqual([]);
    const own = parseOwnPrs(REPO, ownPrsJson([{ number: 1, updatedAt: "t", comments: [{ id: "c", createdAt: "t", author: "me" }] }]));
    expect("error" in own ? [] : own.comments).toEqual([]);
  });

  test("a card goes to the sink with its buttons for the kind", async () => {
    const gh = new FakeGh();
    const sink = new FakeSink();
    const clock = new TestClock(local(12));
    const deps = depsFor(env, { gh, clock, sink, config: testConfig() });
    await runIntakePoll(env.root, deps);
    clock.advance(11 * 60_000);
    gh.set("issue", issuesJson([{ number: 12, updatedAt: "2026-10-05T09:00:00Z" }]));
    gh.set("review", reviewsJson([{ number: 30, updatedAt: "2026-10-05T09:01:00Z" }]));
    const result = await runIntakePoll(env.root, deps);
    expect(result.sent).toBe(2);
    const byKind = Object.fromEntries(sink.cards.map((c) => [c.kind, c.actions]));
    expect(byKind).toEqual({ issue: ["take", "decline", "later"], review: ["review-flow", "skip"] });
  });
});

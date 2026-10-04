// AC2 (flow 403): the first poll of a source only takes a baseline; only what is new after it makes a card.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runIntakePoll } from "./poll";
import { readIntakeCardViews, readIntakeState } from "./store";
import { FakeGh, FakeSink, REPO, TestClock, depsFor, issuesJson, local, ownPrsJson, reviewsJson, runsJson, setupIntakeEnv, testConfig, type IntakeTestEnv } from "./intake.test-helpers";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
});
afterEach(async () => {
  await env.teardown();
});

function existingWork(gh: FakeGh): void {
  gh.set("issue", issuesJson([{ number: 1, updatedAt: "2026-09-01T10:00:00Z" }, { number: 2, updatedAt: "2026-09-02T10:00:00Z" }]));
  gh.set("review", reviewsJson([{ number: 20, updatedAt: "2026-09-03T10:00:00Z" }]));
  gh.set("pr", ownPrsJson([{ number: 7, updatedAt: "2026-09-04T10:00:00Z", comments: [{ id: "IC_old", createdAt: "2026-09-04T10:00:00Z" }] }]));
  gh.set("ci", runsJson([{ id: 500, branch: "own-7", createdAt: "2026-09-05T10:00:00Z" }]));
  env.setBoard([{ id: "F1", title: "Old flow", status: "closed", closedAt: "2026-09-06" }]);
}

describe("AC2: the first poll is a baseline", () => {
  test("a first poll over existing work makes no card and sends nothing", async () => {
    const gh = new FakeGh();
    existingWork(gh);
    const sink = new FakeSink();
    const result = await runIntakePoll(env.root, depsFor(env, { gh, clock: new TestClock(local(12)), sink, config: testConfig() }));
    expect(result.outcome).toBe("ok");
    expect(result.baseline).toBe(true);
    expect(result.newEvents).toBe(0);
    expect(result.cardIds).toEqual([]);
    expect(sink.cards).toEqual([]);
    expect(await readIntakeCardViews(env.root)).toEqual([]);
    const state = await readIntakeState(env.root);
    expect(Object.keys(state.seen).sort()).toEqual(["board:F1", `ci:${REPO}:500`, `comment:${REPO}#7:IC_old`, `issue:${REPO}#1`, `issue:${REPO}#2`, `review:${REPO}#20`].sort());
    expect(state.baselined.length).toBe(5);
  });

  test("the next poll with one new event makes exactly one card", async () => {
    const gh = new FakeGh();
    existingWork(gh);
    const clock = new TestClock(local(12));
    const deps = depsFor(env, { gh, clock, config: testConfig() });
    await runIntakePoll(env.root, deps);
    clock.advance(11 * 60_000);
    gh.set("issue", issuesJson([{ number: 1, updatedAt: "2026-09-01T10:00:00Z" }, { number: 2, updatedAt: "2026-09-02T10:00:00Z" }, { number: 3, updatedAt: "2026-10-05T11:00:00Z" }]));
    const result = await runIntakePoll(env.root, deps);
    expect(result.baseline).toBe(false);
    expect(result.newEvents).toBe(1);
    expect(result.cardIds).toHaveLength(1);
    expect((await readIntakeCardViews(env.root)).map((c) => c.eventKey)).toEqual([`issue:${REPO}#3`]);
  });

  test("a source that failed on the first poll takes its baseline on the first poll that reads it", async () => {
    const gh = new FakeGh();
    existingWork(gh);
    gh.fail("issue", "HTTP 502");
    const clock = new TestClock(local(12));
    const deps = depsFor(env, { gh, clock, config: testConfig() });
    const first = await runIntakePoll(env.root, deps);
    expect(first.failures.map((f) => f.source)).toContain(`issue:${REPO}`);
    expect((await readIntakeState(env.root)).baselined).not.toContain(`issue:${REPO}`);

    clock.advance(11 * 60_000);
    gh.restore("issue");
    const second = await runIntakePoll(env.root, deps);
    expect(second.newEvents).toBe(0);
    expect(await readIntakeCardViews(env.root)).toEqual([]);
    expect((await readIntakeState(env.root)).baselined).toContain(`issue:${REPO}`);

    clock.advance(11 * 60_000);
    gh.set("issue", issuesJson([{ number: 1, updatedAt: "2026-09-01T10:00:00Z" }, { number: 2, updatedAt: "2026-09-02T10:00:00Z" }, { number: 9, updatedAt: "2026-10-05T12:00:00Z" }]));
    const third = await runIntakePoll(env.root, deps);
    expect(third.cardIds).toHaveLength(1);
  });

  test("an empty first poll is still a baseline, so the first ticket afterwards is news", async () => {
    const gh = new FakeGh();
    env.setBoard([]);
    const clock = new TestClock(local(12));
    const deps = depsFor(env, { gh, clock, config: testConfig() });
    expect((await runIntakePoll(env.root, deps)).baseline).toBe(true);
    clock.advance(11 * 60_000);
    gh.set("issue", issuesJson([{ number: 1, updatedAt: "2026-10-05T12:00:00Z" }]));
    expect((await runIntakePoll(env.root, deps)).cardIds).toHaveLength(1);
  });
});

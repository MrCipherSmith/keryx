// AC3 (flow 403): one event is one card. A repeat poll, a restart or a changed `updatedAt` makes no second card.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runIntakePoll } from "./poll";
import { readIntakeCardViews, readIntakeLedger, updateIntakeState } from "./store";
import { FakeGh, TestClock, depsFor, issuesJson, local, ownPrsJson, setupIntakeEnv, testConfig, takeBaseline, REPO, type IntakeTestEnv } from "./intake.test-helpers";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
  env.setBoard([{ id: "F1", title: "A flow", status: "open" }]);
});
afterEach(async () => {
  await env.teardown();
});

describe("AC3: no event makes two cards", () => {
  test("a repeat poll over the same data makes no new card", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const deps = depsFor(env, { gh, clock, config: testConfig() });
    await takeBaseline(env.root, deps, clock);
    gh.set("issue", issuesJson([{ number: 5, updatedAt: "2026-10-05T11:00:00Z" }]));
    const first = await runIntakePoll(env.root, deps);
    expect(first.cardIds).toHaveLength(1);
    for (let i = 0; i < 3; i += 1) {
      clock.advance(11 * 60_000);
      const again = await runIntakePoll(env.root, deps);
      expect(again.newEvents).toBe(0);
      expect(again.cardIds).toEqual([]);
    }
    expect(await readIntakeCardViews(env.root)).toHaveLength(1);
    expect((await readIntakeLedger(env.root)).filter((r) => r.state === "queued")).toHaveLength(1);
  });

  test("a restart (a fresh runner, a fresh clock, the same files) makes no new card", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    await takeBaseline(env.root, depsFor(env, { gh, clock, config: testConfig() }), clock);
    gh.set("issue", issuesJson([{ number: 5, updatedAt: "2026-10-05T11:00:00Z" }]));
    expect((await runIntakePoll(env.root, depsFor(env, { gh, clock, config: testConfig() }))).cardIds).toHaveLength(1);

    const restartedGh = new FakeGh().set("issue", issuesJson([{ number: 5, updatedAt: "2026-10-05T11:00:00Z" }]));
    const restartedClock = new TestClock(local(13));
    const after = await runIntakePoll(env.root, depsFor(env, { gh: restartedGh, clock: restartedClock, config: testConfig() }));
    expect(after.newEvents).toBe(0);
    expect(await readIntakeCardViews(env.root)).toHaveLength(1);
  });

  test("a ticket whose updatedAt changed is not a new event", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const deps = depsFor(env, { gh, clock, config: testConfig() });
    gh.set("issue", issuesJson([{ number: 5, updatedAt: "2026-09-01T10:00:00Z" }]));
    await takeBaseline(env.root, deps, clock);
    gh.set("issue", issuesJson([{ number: 5, updatedAt: "2026-10-05T11:30:00Z" }]));
    const result = await runIntakePoll(env.root, deps);
    expect(result.newEvents).toBe(0);
    expect(await readIntakeCardViews(env.root)).toEqual([]);
  });

  test("a card already registered for an event is not made again when the state lost track of it", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const deps = depsFor(env, { gh, clock, config: testConfig() });
    await takeBaseline(env.root, deps, clock);
    gh.set("issue", issuesJson([{ number: 5, updatedAt: "2026-10-05T11:00:00Z" }]));
    await runIntakePoll(env.root, deps);
    await updateIntakeState(env.root, (s) => {
      const { [`issue:${REPO}#5`]: _dropped, ...seen } = s.seen;
      return { ...s, seen };
    });
    clock.advance(11 * 60_000);
    const result = await runIntakePoll(env.root, deps);
    expect(result.newEvents).toBe(0);
    expect(await readIntakeCardViews(env.root)).toHaveLength(1);
  });

  test("a new comment is one card, and the same comment later is none", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const deps = depsFor(env, { gh, clock, config: testConfig() });
    gh.set("pr", ownPrsJson([{ number: 7, updatedAt: "2026-09-01T10:00:00Z" }]));
    await takeBaseline(env.root, deps, clock);
    const withComment = ownPrsJson([{ number: 7, updatedAt: "2026-10-05T11:00:00Z", comments: [{ id: "IC_1", createdAt: "2026-10-05T11:00:00Z" }] }]);
    gh.set("pr", withComment);
    expect((await runIntakePoll(env.root, deps)).cardIds).toHaveLength(1);
    clock.advance(11 * 60_000);
    expect((await runIntakePoll(env.root, deps)).cardIds).toEqual([]);
  });

  test("a board entry that moves is news once; one that stays put is not", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const deps = depsFor(env, { gh, clock, config: testConfig() });
    await takeBaseline(env.root, deps, clock);
    env.setBoard([{ id: "F1", title: "A flow", status: "closed", closedAt: "2026-10-05" }]);
    expect((await runIntakePoll(env.root, deps)).cardIds).toHaveLength(1);
    clock.advance(11 * 60_000);
    expect((await runIntakePoll(env.root, deps)).cardIds).toEqual([]);
    clock.advance(11 * 60_000);
    env.setBoard([{ id: "F1", title: "A flow", status: "closed", closedAt: "2026-10-05", verdict: "pass" }]);
    expect((await runIntakePoll(env.root, deps)).cardIds).toHaveLength(1);
  });
});

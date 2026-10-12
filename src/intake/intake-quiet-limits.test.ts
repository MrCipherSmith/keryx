// AC15 (flow 403): quiet hours 22:00-08:00 local, at most 6 cards an hour, the rest folded into one "ещё N событий"
// card, and no event lost.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_INTAKE_CONFIG, inQuietHours } from "./config";
import { flushIntakeCards, runIntakePoll } from "./poll";
import { readIntakeCards, readIntakeLedgerCards } from "./store";
import { FakeGh, FakeSink, TestClock, depsFor, issuesJson, local, setupIntakeEnv, takeBaseline, testConfig, type IntakeTestEnv } from "./intake.test-helpers";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
  env.setBoard([]);
});
afterEach(async () => {
  await env.teardown();
});

const issues = (from: number, to: number): string => issuesJson(Array.from({ length: to - from + 1 }, (_, i) => ({ number: from + i, updatedAt: `2026-10-05T${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z` })));

describe("quiet hours (AC15)", () => {
  test("22:00 to 08:00 local, start inclusive, end exclusive, wrapping midnight", () => {
    const quiet = DEFAULT_INTAKE_CONFIG.quietHours;
    expect(quiet).toEqual({ startHour: 22, endHour: 8 });
    expect(inQuietHours(local(22, 0), quiet)).toBe(true);
    expect(inQuietHours(local(21, 59), quiet)).toBe(false);
    expect(inQuietHours(local(0, 30), quiet)).toBe(true);
    expect(inQuietHours(local(7, 59), quiet)).toBe(true);
    expect(inQuietHours(local(8, 0), quiet)).toBe(false);
    expect(inQuietHours(local(12), { startHour: 5, endHour: 5 })).toBe(false);
    expect(inQuietHours(local(3), { startHour: 1, endHour: 6 })).toBe(true);
  });

  test("a card made in quiet hours is held, and goes out when they end", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(21, 30));
    const sink = new FakeSink();
    const deps = depsFor(env, { gh, clock, sink, config: testConfig() });
    await takeBaseline(env.root, deps, clock);
    clock.set(local(23, 0));
    gh.set("issue", issues(1, 2));
    const poll = await runIntakePoll(env.root, deps);
    expect(poll.cardIds).toHaveLength(2);
    expect(poll.sent).toBe(0);
    expect(poll.held).toBe(2);
    expect(sink.cards).toEqual([]);

    clock.set(local(7, 59, 6));
    expect((await flushIntakeCards(env.root, deps)).sent).toBe(0);
    clock.set(local(8, 0, 6));
    const flushed = await flushIntakeCards(env.root, deps);
    expect(flushed.sent).toBe(2);
    expect(sink.cards.map((c) => c.ref)).toEqual(["1", "2"]);
    expect((await readIntakeLedgerCards(env.root)).map((c) => c.state)).toEqual(["sent", "sent"]);
  });

  test("a poll in quiet hours still reads, so nothing is missed overnight", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(23, 0));
    const deps = depsFor(env, { gh, clock, sink: new FakeSink(), config: testConfig() });
    await takeBaseline(env.root, deps, clock);
    const before = gh.calls.length;
    await runIntakePoll(env.root, deps);
    expect(gh.calls.length).toBeGreaterThan(before);
  });

  test("a card queued with no sink (serve stopped) is sent by the next flush with one", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const noSink = depsFor(env, { gh, clock, config: testConfig() });
    await takeBaseline(env.root, noSink, clock);
    gh.set("issue", issues(1, 1));
    expect((await runIntakePoll(env.root, noSink)).held).toBe(1);
    const sink = new FakeSink();
    expect((await flushIntakeCards(env.root, depsFor(env, { gh, clock, sink, config: testConfig() }))).sent).toBe(1);
    expect(sink.cards).toHaveLength(1);
  });
});

describe("six cards an hour, then one overflow card (AC15)", () => {
  test("ten events in one hour: six cards, one overflow card, four events folded, none lost", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const sink = new FakeSink();
    const deps = depsFor(env, { gh, clock, sink, config: testConfig() });
    await takeBaseline(env.root, deps, clock);
    gh.set("issue", issues(1, 10));
    const result = await runIntakePoll(env.root, deps);
    expect(result.cardIds).toHaveLength(10);
    expect(result.sent).toBe(7);
    expect(result.collapsed).toBe(4);
    expect(result.held).toBe(0);

    const regular = sink.cards.filter((c) => c.kind !== "overflow");
    const overflow = sink.cards.filter((c) => c.kind === "overflow");
    expect(regular).toHaveLength(6);
    expect(overflow).toHaveLength(1);
    expect(overflow[0]!.title).toBe("ещё 4 событий");
    expect(overflow[0]!.collapsedIds).toHaveLength(4);
    expect(overflow[0]!.actions).toEqual([]);

    const folded = await readIntakeLedgerCards(env.root);
    expect(folded.filter((c) => c.kind === "issue" && c.state === "sent")).toHaveLength(6);
    const collapsed = folded.filter((c) => c.state === "collapsed");
    expect(collapsed).toHaveLength(4);
    expect(new Set(collapsed.map((c) => c.collapsedInto))).toEqual(new Set([overflow[0]!.id]));
    const cards = await readIntakeCards(env.root);
    expect([...(cards[overflow[0]!.id]!.collapsedIds ?? [])].sort()).toEqual(collapsed.map((c) => c.cardId).sort());
    expect(Object.values(cards).filter((c) => c.kind === "issue")).toHaveLength(10);
  });

  test("events past the limit in the same hour join the same overflow card, not a second one", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const sink = new FakeSink();
    const deps = depsFor(env, { gh, clock, sink, config: testConfig() });
    await takeBaseline(env.root, deps, clock);
    gh.set("issue", issues(1, 8));
    await runIntakePoll(env.root, deps);
    clock.advance(10 * 60_000);
    gh.set("issue", issues(1, 11));
    const second = await runIntakePoll(env.root, deps);
    expect(second.cardIds).toHaveLength(3);
    expect(second.collapsed).toBe(3);
    expect(sink.cards.filter((c) => c.kind === "overflow")).toHaveLength(1);
    const cards = await readIntakeCards(env.root);
    const overflow = Object.values(cards).filter((c) => c.kind === "overflow");
    expect(overflow).toHaveLength(1);
    expect(overflow[0]!.collapsedIds).toHaveLength(5);
    expect(overflow[0]!.title).toBe("ещё 5 событий");
    const folded = await readIntakeLedgerCards(env.root);
    expect(folded.filter((c) => c.kind === "issue").every((c) => c.state === "sent" || c.state === "collapsed")).toBe(true);
    expect(folded.filter((c) => c.kind === "issue")).toHaveLength(11);
  });

  test("an hour later the allowance is back and a new event is sent on its own", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const sink = new FakeSink();
    const deps = depsFor(env, { gh, clock, sink, config: testConfig() });
    await takeBaseline(env.root, deps, clock);
    gh.set("issue", issues(1, 8));
    await runIntakePoll(env.root, deps);
    clock.advance(61 * 60_000);
    gh.set("issue", issues(1, 9));
    const result = await runIntakePoll(env.root, deps);
    expect(result.sent).toBe(1);
    expect(result.collapsed).toBe(0);
    expect(sink.cards.at(-1)!.ref).toBe("9");
  });

  test("a burst held through quiet hours is sent as six cards and one overflow card when they end", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(21, 0));
    const sink = new FakeSink();
    const deps = depsFor(env, { gh, clock, sink, config: testConfig() });
    await takeBaseline(env.root, deps, clock);
    clock.set(local(23, 0));
    gh.set("issue", issues(1, 9));
    expect((await runIntakePoll(env.root, deps)).held).toBe(9);
    clock.set(local(8, 5, 6));
    const flushed = await flushIntakeCards(env.root, deps);
    expect(flushed.sent).toBe(7);
    expect(flushed.collapsed).toBe(3);
    expect(sink.cards.filter((c) => c.kind !== "overflow").map((c) => c.ref)).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  test("the limit is the configured one", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const sink = new FakeSink();
    const deps = depsFor(env, { gh, clock, sink, config: testConfig({ cardsPerHour: 2 }) });
    await takeBaseline(env.root, deps, clock);
    gh.set("issue", issues(1, 5));
    await runIntakePoll(env.root, deps);
    expect(sink.cards.filter((c) => c.kind !== "overflow")).toHaveLength(2);
    expect(sink.cards.find((c) => c.kind === "overflow")!.title).toBe("ещё 3 событий");
  });
});

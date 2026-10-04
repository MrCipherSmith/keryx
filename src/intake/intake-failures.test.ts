// AC17 (flow 403): a failure of gh, the model or delivery goes into the report and a status line in the topic; the
// poll goes on with what still works, and an undelivered card is retried with a growing delay.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { backoffMs, DELIVERY_MAX_ATTEMPTS } from "../scheduler/digest-delivery";
import { flushIntakeCards, runIntakePoll } from "./poll";
import { readIntakeCardViews, readIntakeState } from "./store";
import { FakeGh, FakeSink, REPO, TestClock, depsFor, fakeAssessor, issuesJson, local, reviewsJson, setupIntakeEnv, takeBaseline, testConfig, type IntakeTestEnv } from "./intake.test-helpers";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
  env.setBoard([]);
});
afterEach(async () => {
  await env.teardown();
});

const reportOf = async (root: string, p: string | undefined): Promise<string> => readFile(path.join(root, p!), "utf8");

describe("a failed gh call (AC17)", () => {
  test("one failing source is reported and the others are still read", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const sink = new FakeSink();
    const deps = depsFor(env, { gh, clock, sink, config: testConfig() });
    await takeBaseline(env.root, deps, clock);
    gh.fail("issue", "HTTP 502 from github");
    gh.set("review", reviewsJson([{ number: 30, updatedAt: "2026-10-05T09:01:00Z" }]));
    const result = await runIntakePoll(env.root, deps);
    expect(result.outcome).toBe("ok");
    expect(result.cardIds).toHaveLength(1);
    expect(result.failures.map((f) => f.source)).toEqual([`issue:${REPO}`]);
    expect(result.failures[0]!.detail).toContain("HTTP 502");
    expect(result.statusLine).toContain("не все источники прочитаны");
    expect(sink.statuses).toHaveLength(1);
    expect(sink.statuses[0]).toContain(`issue:${REPO}`);
    expect(await reportOf(env.root, result.reportPath)).toContain(`issue:${REPO}: gh_issue_assigned failed: HTTP 502`);
  });

  test("a source that failed does not make its tickets look new when it comes back", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const deps = depsFor(env, { gh, clock, config: testConfig() });
    gh.set("issue", issuesJson([{ number: 1, updatedAt: "2026-09-01T10:00:00Z" }]));
    await takeBaseline(env.root, deps, clock);
    gh.fail("issue", "HTTP 500");
    await runIntakePoll(env.root, deps);
    clock.advance(11 * 60_000);
    gh.restore("issue");
    const back = await runIntakePoll(env.root, deps);
    expect(back.newEvents).toBe(0);
    expect(await readIntakeCardViews(env.root)).toEqual([]);
  });

  test("when no source can be read the run fails, in the report and the topic", async () => {
    const gh = new FakeGh();
    for (const kind of ["issue", "review", "pr"] as const) gh.fail(kind, "gh: not logged in");
    const sink = new FakeSink();
    const result = await runIntakePoll(env.root, depsFor(env, { gh, clock: new TestClock(local(12)), sink, config: testConfig() }));
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("no GitHub source could be read");
    expect(result.detail).toContain("not logged in");
    expect(result.statusLine).toContain("опрос остановлен");
    expect(sink.statuses).toHaveLength(1);
    expect(await reportOf(env.root, result.reportPath)).toContain("not logged in");
    expect(sink.statuses[0]).toContain(result.reportPath!);
    expect((await readIntakeState(env.root)).lastRun?.outcome).toBe("failed");
  });

  test("a gh that is not on PATH is a reported failure, not a crash", async () => {
    const empty = path.join(env.aside, "empty");
    await mkdir(empty);
    const sink = new FakeSink();
    const result = await runIntakePoll(env.root, { ...depsFor(env, { gh: new FakeGh(), clock: new TestClock(local(12)), sink, config: testConfig() }), env: { ...env.env, PATH: empty } });
    expect(result.outcome).toBe("failed");
    expect(result.failures[0]!.detail).toContain('"gh" was not found on PATH');
    expect(sink.statuses[0]).toContain("gh");
  });

  test("an answer that is not JSON is a failure of that source", async () => {
    const gh = new FakeGh();
    gh.set("issue", "<html>rate limited</html>");
    const result = await runIntakePoll(env.root, depsFor(env, { gh, clock: new TestClock(local(12)), config: testConfig() }));
    expect(result.failures).toContainEqual({ source: `issue:${REPO}`, detail: "gh did not answer with JSON" });
  });

  test("a failing own-PR list means the failed runs are reported as not read", async () => {
    const gh = new FakeGh();
    gh.fail("pr", "HTTP 500");
    const result = await runIntakePoll(env.root, depsFor(env, { gh, clock: new TestClock(local(12)), config: testConfig() }));
    expect(result.failures.map((f) => f.source)).toEqual(expect.arrayContaining([`pr:${REPO}`, `ci:${REPO}`]));
  });

  test("the same status line is not sent twice within the hour, and is sent again after it", async () => {
    const gh = new FakeGh();
    gh.fail("issue", "HTTP 502");
    const clock = new TestClock(local(12));
    const sink = new FakeSink();
    const deps = depsFor(env, { gh, clock, sink, config: testConfig() });
    await runIntakePoll(env.root, deps);
    clock.advance(11 * 60_000);
    const second = await runIntakePoll(env.root, deps);
    expect(second.statusLine).toBeDefined();
    expect(sink.statuses).toHaveLength(1);
    clock.advance(61 * 60_000);
    await runIntakePoll(env.root, deps);
    expect(sink.statuses).toHaveLength(2);
  });

  test("a missing product index is in the report but not in the topic", async () => {
    env.setBoard("absent");
    const sink = new FakeSink();
    const result = await runIntakePoll(env.root, depsFor(env, { gh: new FakeGh(), clock: new TestClock(local(12)), sink, config: testConfig() }));
    expect(result.outcome).toBe("ok");
    expect(result.failures.map((f) => f.source)).toEqual(["board"]);
    expect(sink.statuses).toEqual([]);
    expect(await reportOf(env.root, result.reportPath)).toContain("no product index");
  });

  test("a status line that cannot be sent is no error of the run", async () => {
    const gh = new FakeGh().fail("issue", "HTTP 502");
    const sink = new FakeSink();
    sink.statusOk = false;
    const result = await runIntakePoll(env.root, depsFor(env, { gh, clock: new TestClock(local(12)), sink, config: testConfig() }));
    expect(result.outcome).toBe("ok");
    expect((await readIntakeState(env.root)).lastStatus).toBeUndefined();
  });
});

describe("a failed model call (AC17)", () => {
  test("the card is still made, without an assessment, and the failure is reported", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const sink = new FakeSink();
    const deps = depsFor(env, { gh, clock, sink, assess: fakeAssessor({ fail: "provider returned 529" }).assess, config: testConfig() });
    await takeBaseline(env.root, deps, clock);
    gh.set("issue", issuesJson([{ number: 1, updatedAt: "2026-10-05T01:00:00Z" }, { number: 2, updatedAt: "2026-10-05T02:00:00Z" }]));
    const result = await runIntakePoll(env.root, deps);
    expect(result.outcome).toBe("ok");
    expect(result.cardIds).toHaveLength(2);
    expect(sink.cards).toHaveLength(2);
    expect(sink.cards.every((c) => c.assessment === undefined && c.suggestion === undefined)).toBe(true);
    expect(result.failures).toEqual([{ source: "model", detail: "2 assessment(s) failed: provider returned 529" }]);
    expect(sink.statuses[0]).toContain("model");
    expect(await reportOf(env.root, result.reportPath)).toContain("model: 2 assessment(s) failed");
  });

  test("a model that throws is a failure too, and never stops the poll", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const deps = depsFor(env, {
      gh,
      clock,
      assess: async () => {
        throw new Error("socket hang up");
      },
      config: testConfig(),
    });
    await takeBaseline(env.root, deps, clock);
    gh.set("issue", issuesJson([{ number: 1, updatedAt: "2026-10-05T01:00:00Z" }]));
    const result = await runIntakePoll(env.root, deps);
    expect(result.cardIds).toHaveLength(1);
    expect(result.failures[0]!.detail).toContain("socket hang up");
  });

  test("an assessment is cut to 400 characters and a suggestion outside the card's buttons is dropped", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const sink = new FakeSink();
    const deps = depsFor(env, {
      gh,
      clock,
      sink,
      assess: async () => ({ ok: true as const, assessment: "x".repeat(900), suggestion: "ci-triage", costUsd: 0 }),
      config: testConfig(),
    });
    await takeBaseline(env.root, deps, clock);
    gh.set("issue", issuesJson([{ number: 1, updatedAt: "2026-10-05T01:00:00Z" }]));
    await runIntakePoll(env.root, deps);
    expect(sink.cards[0]!.assessment).toHaveLength(400);
    expect(sink.cards[0]!.suggestion).toBeUndefined();
  });
});

describe("a failed delivery (AC17)", () => {
  async function queuedOne(): Promise<{ gh: FakeGh; clock: TestClock; sink: FakeSink; deps: ReturnType<typeof depsFor> }> {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const sink = new FakeSink();
    const deps = depsFor(env, { gh, clock, sink, config: testConfig() });
    await takeBaseline(env.root, deps, clock);
    gh.set("issue", issuesJson([{ number: 1, updatedAt: "2026-10-05T01:00:00Z" }]));
    return { gh, clock, sink, deps };
  }

  test("a card that could not be sent stays queued, is reported, and is retried after a growing delay", async () => {
    const { gh: _gh, clock, sink, deps } = await queuedOne();
    sink.script = [{ ok: false, reason: "Bad Gateway" }];
    const result = await runIntakePoll(env.root, deps);
    expect(result.sent).toBe(0);
    expect(result.held).toBe(1);
    expect(result.failures.map((f) => f.source)).toEqual(["delivery"]);
    expect(result.failures[0]!.detail).toContain("Bad Gateway");
    expect(sink.statuses[0]).toContain("delivery");
    expect(await reportOf(env.root, result.reportPath)).toContain("delivery: card");
    expect((await readIntakeCardViews(env.root))[0]!.state).toBe("queued");

    clock.advance(backoffMs(1) - 1000);
    expect((await flushIntakeCards(env.root, deps)).sent).toBe(0);
    expect(sink.cards).toEqual([]);
    clock.advance(2000);
    const retried = await flushIntakeCards(env.root, deps);
    expect(retried.sent).toBe(1);
    expect((await readIntakeCardViews(env.root))[0]!.state).toBe("sent");
    expect((await readIntakeState(env.root)).delivery).toEqual({});
  });

  test("the delay grows with each failure", async () => {
    const { clock, sink, deps } = await queuedOne();
    sink.script = [{ ok: false, reason: "down" }, { ok: false, reason: "down" }, { ok: false, reason: "down" }];
    await runIntakePoll(env.root, deps);
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const before = await readIntakeState(env.root);
      const next = Object.values(before.delivery)[0]!;
      delays.push(Date.parse(next.nextAt) - clock.now().getTime());
      clock.advance(Date.parse(next.nextAt) - clock.now().getTime() + 1);
      await flushIntakeCards(env.root, deps);
    }
    const last = Object.values((await readIntakeState(env.root)).delivery)[0]!;
    delays.push(Date.parse(last.nextAt) - clock.now().getTime());
    expect(delays[1]!).toBeGreaterThan(delays[0]!);
    expect(delays[2]!).toBeGreaterThan(delays[1]!);
    expect(last.attempts).toBe(3);
  });

  test("a sink that throws is a failed delivery, not a crash", async () => {
    const { clock: _clock, deps } = await queuedOne();
    const throwing = { ...deps, sink: { sendCard: async () => { throw new Error("ECONNRESET"); }, sendStatus: async () => ({ ok: true }) } };
    const result = await runIntakePoll(env.root, throwing);
    expect(result.outcome).toBe("ok");
    expect(result.failures[0]!.detail).toContain("ECONNRESET");
    expect((await readIntakeCardViews(env.root))[0]!.state).toBe("queued");
  });

  test("after the last attempt the card is given up on, and the report says so", async () => {
    const { clock, sink, deps } = await queuedOne();
    sink.script = Array.from({ length: DELIVERY_MAX_ATTEMPTS + 2 }, () => ({ ok: false as const, reason: "down" }));
    await runIntakePoll(env.root, deps);
    let gaveUp = false;
    for (let i = 0; i < DELIVERY_MAX_ATTEMPTS && !gaveUp; i += 1) {
      clock.advance(48 * 60 * 60_000);
      const flushed = await flushIntakeCards(env.root, deps);
      gaveUp = flushed.failures.some((f) => f.detail.includes("gave up"));
    }
    expect(gaveUp).toBe(true);
    expect((await readIntakeCardViews(env.root))[0]!.state).toBe("undelivered");
    clock.advance(48 * 60 * 60_000);
    expect((await flushIntakeCards(env.root, deps)).sent).toBe(0);
  });
});

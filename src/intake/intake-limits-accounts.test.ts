// AC16 (flow 403): a poll is bounded by a model budget, a timeout and a memory limit; exceeding one stops the run and
// says so in the report and in a status line. The GitHub account is chosen by the project's path.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runIntakePoll, type IntakeDeps } from "./poll";
import { readIntakeCardViews, readIntakeState } from "./store";
import { FakeGh, FakeSink, TestClock, depsFor, fakeAssessor, issuesJson, local, setupIntakeEnv, takeBaseline, testConfig, type IntakeTestEnv } from "./intake.test-helpers";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
  env.setBoard([]);
});
afterEach(async () => {
  await env.teardown();
});

const threeIssues = (): string => issuesJson([1, 2, 3].map((n) => ({ number: n, updatedAt: `2026-10-05T0${n}:00:00Z` })));

describe("the budget (AC16)", () => {
  test("the default budget is fifty cents a run", () => {
    expect(testConfig().budgetUsd).toBe(0.5);
  });

  test("a run that reaches the budget does not abort: the rest are carded without an assessment, and the run says so", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const sink = new FakeSink();
    const dear = fakeAssessor({ costUsd: 0.3 });
    const deps = depsFor(env, { gh, clock, sink, assess: dear.assess, config: testConfig() });
    await takeBaseline(env.root, deps, clock);
    gh.set("issue", threeIssues());
    const run = await runIntakePoll(env.root, deps);
    // The budget ends the model calls, not the run: no failure, no abort, nothing left for later.
    expect(run.outcome).toBe("ok");
    expect(run.stoppedBy).toBeUndefined();
    expect(dear.inputs).toHaveLength(2);
    expect(run.costUsd).toBeCloseTo(0.6, 5);
    expect(run.cardIds).toHaveLength(3);
    expect(run.notes.join("\n")).toContain("model budget of $0.50 reached; 1 remaining event(s) were sent without an assessment");
    const views = await readIntakeCardViews(env.root);
    expect(views).toHaveLength(3);
    expect(views.filter((v) => v.assessment === undefined || v.assessment === "")).toHaveLength(1);
    const report = await readFile(path.join(env.root, run.reportPath!), "utf8");
    expect(report).toContain("## Notes");
    expect(report).toContain("without an assessment");
    expect(report).toContain("model cost: $0.6000 of $0.50");

    // the next poll has nothing left over from this one
    clock.advance(11 * 60_000);
    const next = await runIntakePoll(env.root, depsFor(env, { gh, clock, sink, assess: fakeAssessor({ costUsd: 0.01 }).assess, config: testConfig() }));
    expect(next.outcome).toBe("ok");
    expect(next.cardIds).toHaveLength(0);
  });

  test("the model is told what is left of the budget", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const assessor = fakeAssessor({ costUsd: 0.1 });
    const deps = depsFor(env, { gh, clock, assess: assessor.assess, config: testConfig() });
    await takeBaseline(env.root, deps, clock);
    gh.set("issue", threeIssues());
    await runIntakePoll(env.root, deps);
    expect(assessor.inputs.map((i) => Math.round(i.remainingUsd * 100) / 100)).toEqual([0.5, 0.4, 0.3]);
  });

  test("a run with no budget calls no model and still makes its cards", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const assessor = fakeAssessor();
    const deps = depsFor(env, { gh, clock, assess: assessor.assess, config: testConfig({ budgetUsd: 0 }) });
    await takeBaseline(env.root, deps, clock);
    gh.set("issue", threeIssues());
    const result = await runIntakePoll(env.root, deps);
    expect(assessor.inputs).toEqual([]);
    expect(result.outcome).toBe("ok");
    expect(result.cardIds).toHaveLength(3);
  });
});

describe("the timeout and the memory limit (AC16)", () => {
  test("a timeout stops the run, in the report and the status line", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const sink = new FakeSink();
    let fire: (() => void) | undefined;
    const limits: IntakeDeps["limits"] = {
      armTimeout: (_ms, f) => {
        fire = f;
        return () => {};
      },
      armWatch: () => () => {},
    };
    gh.onCall = () => fire?.();
    const result = await runIntakePoll(env.root, { ...depsFor(env, { gh, clock, sink, config: testConfig({ maxSeconds: 30 }) }), limits });
    expect(result.outcome).toBe("failed");
    expect(result.stoppedBy).toBe("timeout");
    expect(result.detail).toContain("timed out after 30s");
    expect(result.statusLine).toContain("timed out after 30s");
    expect(sink.statuses.join("\n")).toContain("timed out");
    expect(await readFile(path.join(env.root, result.reportPath!), "utf8")).toContain("timed out after 30s");
    expect(gh.calls).toHaveLength(1);
  });

  test("the timeout is the configured one", async () => {
    let armed = 0;
    const limits: IntakeDeps["limits"] = {
      armTimeout: (ms) => {
        armed = ms;
        return () => {};
      },
      armWatch: () => () => {},
    };
    await runIntakePoll(env.root, { ...depsFor(env, { gh: new FakeGh(), clock: new TestClock(local(12)), config: testConfig({ maxSeconds: 42 }) }), limits });
    expect(armed).toBe(42_000);
  });

  test("memory growth past the limit stops the run, in the report and the status line", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const sink = new FakeSink();
    let reads = 0;
    const limits: IntakeDeps["limits"] = { armTimeout: () => () => {}, armWatch: () => () => {}, rssMb: () => (reads++ === 0 ? 100 : 5000) };
    const result = await runIntakePoll(env.root, { ...depsFor(env, { gh, clock, sink, config: testConfig({ memoryLimitMb: 512 }) }), limits });
    expect(result.outcome).toBe("failed");
    expect(result.stoppedBy).toBe("memory");
    expect(result.detail).toContain("memory limit exceeded");
    expect(sink.statuses.join("\n")).toContain("memory limit exceeded");
    expect(await readFile(path.join(env.root, result.reportPath!), "utf8")).toContain("memory limit exceeded");
    expect((await readIntakeState(env.root)).lastRun?.outcome).toBe("failed");
  });
});

describe("the GitHub account follows the project's path (AC16)", () => {
  test("a project outside the work root runs as the personal account", async () => {
    const gh = new FakeGh();
    const result = await runIntakePoll(env.root, depsFor(env, { gh, clock: new TestClock(local(12)), config: testConfig() }));
    expect(result.ghAccount).toBe("personal");
    expect(gh.calls.length).toBeGreaterThan(0);
    for (const call of gh.calls) expect(call.env["GH_ACCOUNT"]).toBe("personal");
  });

  test("a project under the work root runs as the work account", async () => {
    env.env["GH_WORK_ROOT"] = path.dirname(env.root);
    const gh = new FakeGh();
    const result = await runIntakePoll(env.root, depsFor(env, { gh, clock: new TestClock(local(12)), config: testConfig() }));
    expect(result.ghAccount).toBe("work");
    for (const call of gh.calls) expect(call.env["GH_ACCOUNT"]).toBe("work");
  });

  test("no gh call ever switches or logs in, and a token in the environment is not handed on", async () => {
    env.env["GH_TOKEN"] = "ghp_should_not_travel";
    env.env["GITHUB_TOKEN"] = "ghp_should_not_travel_either";
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const deps = depsFor(env, { gh, clock, config: testConfig() });
    await takeBaseline(env.root, deps, clock);
    gh.set("issue", threeIssues());
    await runIntakePoll(env.root, deps);
    for (const call of gh.calls) {
      expect(call.argv[0]).not.toBe("auth");
      expect(call.argv).not.toContain("switch");
      expect(call.argv).not.toContain("login");
      expect(call.env["GH_TOKEN"]).toBeUndefined();
      expect(call.env["GITHUB_TOKEN"]).toBeUndefined();
    }
  });

  test("the take button is offered on a personal-account ticket and withheld under the work account", async () => {
    const personal = new FakeGh();
    const clock = new TestClock(local(12));
    const personalSink = new FakeSink();
    const personalDeps = depsFor(env, { gh: personal, clock, sink: personalSink, config: testConfig() });
    await takeBaseline(env.root, personalDeps, clock);
    personal.set("issue", issuesJson([{ number: 1, updatedAt: "2026-10-05T01:00:00Z" }]));
    await runIntakePoll(env.root, personalDeps);
    expect(personalSink.cards[0]!.actions).toEqual(["take", "decline", "later"]);
    expect(personalSink.cards[0]!.takeAllowed).toBe(true);
  });

  test("under the work account the take action is absent unless the config allows it", async () => {
    env.env["GH_WORK_ROOT"] = path.dirname(env.root);
    for (const allowTakeInWork of [false, true]) {
      const gh = new FakeGh();
      const clock = new TestClock(local(12));
      const sink = new FakeSink();
      const config = testConfig({ allowTakeInWork });
      const deps = depsFor(env, { gh, clock, sink, config });
      await takeBaseline(env.root, deps, clock);
      gh.set("issue", issuesJson([{ number: allowTakeInWork ? 2 : 1, updatedAt: "2026-10-05T01:00:00Z" }]));
      await runIntakePoll(env.root, deps);
      const card = sink.cards.at(-1)!;
      expect(card.account).toBe("work");
      expect(card.takeAllowed).toBe(allowTakeInWork);
      expect(card.actions.includes("take")).toBe(allowTakeInWork);
      expect(card.actions).toContain("decline");
    }
  });
});

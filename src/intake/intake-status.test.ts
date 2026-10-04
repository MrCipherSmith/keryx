// Flow 403 (AC15, AC20): the status object every surface reads, pause and resume, and the `keryx intake` command.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { intakeCommand } from "../commands/intake";
import { intakePollDue, nextIntakePollAt, runIntakePoll, runIntakeTick } from "./poll";
import { buildIntakeStatus, setIntakePaused } from "./status";
import { appendIntakeIfState, readIntakeState } from "./store";
import { FakeGh, FakeSink, TestClock, depsFor, issuesJson, local, setupIntakeEnv, takeBaseline, testConfig, type IntakeTestEnv } from "./intake.test-helpers";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
  env.setBoard([]);
});
afterEach(async () => {
  await env.teardown();
});

async function twoCards(clock: TestClock, sink: FakeSink): Promise<FakeGh> {
  const gh = new FakeGh();
  const deps = depsFor(env, { gh, clock, sink, config: testConfig() });
  await takeBaseline(env.root, deps, clock);
  gh.set("issue", issuesJson([1, 2].map((n) => ({ number: n, updatedAt: `2026-10-05T0${n}:00:00Z` }))));
  await runIntakePoll(env.root, deps);
  return gh;
}

describe("buildIntakeStatus", () => {
  test("counts what waits, what is queued, deferred and decided, and builds the sidebar line", async () => {
    const clock = new TestClock(local(12));
    const sink = new FakeSink();
    await twoCards(clock, sink);
    const waiting = await buildIntakeStatus(env.root, { now: clock.now, env: env.env, config: testConfig() });
    expect(waiting.waiting).toBe(2);
    expect(waiting.line).toMatch(/^Intake: 2 ждут \| следующий опрос \d\d:\d\d$/);
    expect(waiting.nextPollAt).not.toBeNull();
    expect(waiting.quiet).toBe(false);
    expect(waiting.ghAccount).toBe("personal");
    expect(waiting.tabs.waiting).toHaveLength(2);

    const [first, second] = sink.cards;
    await appendIntakeIfState(env.root, first!.id, ["sent"], { state: "decided", choice: "decline", decidedAt: clock.now().toISOString(), decidedBy: "1" });
    await appendIntakeIfState(env.root, second!.id, ["sent"], { state: "decided", choice: "later", decidedAt: clock.now().toISOString(), decidedBy: "1", remindAt: local(16).toISOString() });
    const after = await buildIntakeStatus(env.root, { now: clock.now, env: env.env, config: testConfig() });
    expect(after).toMatchObject({ waiting: 0, decided: 1, deferred: 1, queued: 0 });
    expect(after.tabs.decided[0]!.choice).toBe("decline");
    expect(after.tabs.deferred[0]!.remindAt).toBe(local(16).toISOString());
    expect(after.tabs.events).toHaveLength(2);
  });

  test("queued cards are counted apart, and quiet hours show", async () => {
    const clock = new TestClock(local(23));
    const gh = new FakeGh();
    const deps = depsFor(env, { gh, clock, sink: new FakeSink(), config: testConfig() });
    await takeBaseline(env.root, deps, clock);
    gh.set("issue", issuesJson([{ number: 1, updatedAt: "2026-10-05T01:00:00Z" }]));
    await runIntakePoll(env.root, deps);
    const status = await buildIntakeStatus(env.root, { now: clock.now, env: env.env, config: testConfig() });
    expect(status).toMatchObject({ queued: 1, waiting: 0, quiet: true });
  });

  test("a disabled intake says so", async () => {
    const status = await buildIntakeStatus(env.root, { now: () => local(12), env: env.env, config: testConfig({ enabled: false }) });
    expect(status.line).toBe("Intake: выкл");
    expect(status.nextPollAt).toBeNull();
  });

  test("the work account is shown for a project under the work root", async () => {
    env.env["GH_WORK_ROOT"] = env.root.slice(0, env.root.lastIndexOf("/"));
    expect((await buildIntakeStatus(env.root, { env: env.env, config: testConfig() })).ghAccount).toBe("work");
  });
});

describe("pause and resume", () => {
  test("a paused intake does not poll on its own, still polls by hand, and resumes", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const config = testConfig();
    await setIntakePaused(env.root, true);
    expect((await buildIntakeStatus(env.root, { now: clock.now, env: env.env, config })).line).toBe("Intake: 0 ждут | пауза");
    const skipped = await runIntakePoll(env.root, depsFor(env, { gh, clock, config }));
    expect(skipped.outcome).toBe("skipped");
    expect(gh.calls).toEqual([]);
    expect(intakePollDue(config, await readIntakeState(env.root), clock.now())).toBe(false);
    const tick = await runIntakeTick(env.root, depsFor(env, { gh, clock, config }));
    expect(tick.poll).toBeUndefined();

    const manual = await runIntakePoll(env.root, depsFor(env, { gh, clock, config, manual: true }));
    expect(manual.outcome).toBe("ok");
    expect(gh.calls.length).toBeGreaterThan(0);

    await setIntakePaused(env.root, false);
    clock.advance(11 * 60_000);
    const state = await readIntakeState(env.root);
    expect(intakePollDue(config, state, clock.now())).toBe(true);
    expect(nextIntakePollAt(config, state)).toBe(new Date(Date.parse(state.lastPollAt!) + 10 * 60_000).toISOString());
  });

  test("the tick polls when the interval has passed, and only then", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const deps = depsFor(env, { gh, clock, sink: new FakeSink(), config: testConfig() });
    expect((await runIntakeTick(env.root, deps)).poll?.baseline).toBe(true);
    clock.advance(5 * 60_000);
    expect((await runIntakeTick(env.root, deps)).poll).toBeUndefined();
    clock.advance(6 * 60_000);
    expect((await runIntakeTick(env.root, deps)).poll?.outcome).toBe("ok");
  });

  test("a second poll started while one runs is skipped", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const deps = depsFor(env, { gh, clock, config: testConfig() });
    let inner: Awaited<ReturnType<typeof runIntakePoll>> | undefined;
    gh.onCall = async () => {
      gh.onCall = undefined;
      inner = await runIntakePoll(env.root, deps);
    };
    await runIntakePoll(env.root, deps);
    expect(inner?.outcome).toBe("skipped");
    expect(inner?.detail).toContain("already running");
  });
});

describe("keryx intake", () => {
  async function run(args: string[]): Promise<string> {
    const cwd = process.cwd();
    const write = process.stdout.write.bind(process.stdout);
    let out = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.chdir(env.root);
    try {
      await intakeCommand(args);
    } finally {
      process.chdir(cwd);
      process.stdout.write = write;
    }
    return out;
  }

  test("pause, status --json, resume", async () => {
    await env.teardown();
    env = await setupIntakeEnv({ config: {} });
    expect(await run(["pause"])).toContain("на паузе");
    const paused = JSON.parse(await run(["status", "--json"])) as { paused: boolean; line: string };
    expect(paused.paused).toBe(true);
    expect(paused.line).toContain("пауза");
    expect(await run(["resume"])).toContain("возобновлён");
    expect((JSON.parse(await run(["status", "--json"])) as { paused: boolean }).paused).toBe(false);
    expect(await run(["status"])).toContain("аккаунт GitHub по пути проекта: personal");
  });

  test("list and report, with and without --json", async () => {
    expect(await run(["list"])).toContain("Карточек пока нет");
    expect(JSON.parse(await run(["list", "--json"]))).toEqual([]);
    expect(JSON.parse(await run(["report", "--json"]))).toMatchObject({ schema: 1, totalCards: 0, kinds: [], chains: [] });
    expect(await run(["report"])).toContain("карточек пока нет");
    const clock = new TestClock(local(12));
    await twoCards(clock, new FakeSink());
    expect((JSON.parse(await run(["list", "--json"])) as unknown[]).length).toBe(2);
    expect(await run(["report"])).toContain("issue [take/decline/later]: карточек 2");
  });

  test("poll with the intake disabled reads nothing and says why", async () => {
    await env.teardown();
    env = await setupIntakeEnv({ config: { enabled: false } });
    const result = JSON.parse(await run(["poll", "--json"])) as { outcome: string; detail: string };
    expect(result.outcome).toBe("skipped");
    expect(result.detail).toContain("выключен");
    expect(process.exitCode).toBe(0);
  });

  test("L2: a project with no config file is not polled by hand either; the refusal is one line that says how to enable it", async () => {
    // setupIntakeEnv() writes no config file: this is the default state of every project.
    const out = await run(["poll"]);
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(out).toContain("skipped");
    expect(out).toContain("intake не настроен");
    expect(out).toContain(".metaproject/data/intake/config.json");
    expect(out).toContain('"enabled": true');
    const json = JSON.parse(await run(["poll", "--json"])) as { outcome: string; cardIds: string[]; reportPath?: string };
    expect(json.outcome).toBe("skipped");
    expect(json.cardIds).toEqual([]);
    // nothing was started: no poll state, no report
    expect(json.reportPath).toBeUndefined();
    expect((await readIntakeState(env.root)).lastPollAt).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  test("L2: the status of a project with no config file says it is not configured and how to enable it", async () => {
    const text = await run(["status"]);
    expect(text).toContain("intake не настроен");
    expect(text).toContain("включён: нет");
    const status = JSON.parse(await run(["status", "--json"])) as { configured: boolean; enabled: boolean; disabledReason?: string };
    expect(status).toMatchObject({ configured: false, enabled: false });
    expect(status.disabledReason).toContain("config.json");
  });

  test("an unknown subcommand is refused", async () => {
    await run(["frobnicate"]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

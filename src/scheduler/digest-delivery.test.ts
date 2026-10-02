// Flow 389, AC6: how the digest gets to Telegram, and what happens when it does not.
//
//   - the project has a live remote session  -> the digest goes into that session's topic;
//   - the project has none                   -> it goes into the service topic "Digest";
//   - a delivery that fails is written in the run's report, and retried;
//   - a gh or model failure is a report entry AND a status line in the topic.
//
// Most cases use a scripted sink. The last group puts a REAL `RemoteHub` behind `hubSink`, over
// the fake Bot API, so the topic really is created, remembered and written to by serve's own path.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { dispatchLockPath } from "../commands/trigger-dispatch";
import { withFileLock } from "../lib/fs";
import { ensureLocksDir } from "../lib/maintenance-lock";
import { indexPath } from "../product/store";
import { BotApiError } from "../remote/types";
import { makeHarness, ManualClock, type Harness } from "../remote/remote.test-helpers";
import { readTriggerRuns, type TriggerRunRecord } from "../trigger/record";
import {
  addDigestSchedule,
  failingSummary,
  FakeGh,
  FakeSink,
  fakeSummary,
  issueJson,
  prJson,
  REPO,
  runDigest,
  setupDigestEnv,
  TestClock,
  type DigestTestEnv,
} from "./digest.test-helpers";
import { backoffMs, DELIVERY_MAX_ATTEMPTS, deliveryPath, enqueueDelivery, flushDeliveries, hubSink, readDeliveryState } from "./digest-delivery";
import { createDigestTicker } from "./digest-ticker";

let env: DigestTestEnv;
let clock: TestClock;
let name = "";
let sink: FakeSink;

beforeEach(async () => {
  env = await setupDigestEnv();
  clock = new TestClock("2026-10-02T12:00:00Z");
  sink = new FakeSink();
  name = await addDigestSchedule(env);
});

afterEach(async () => {
  await env.teardown();
});

const PR12 = { number: 12, title: "Add the retry button", updatedAt: "2026-10-01T09:00:00Z" };

function quietGh(): FakeGh {
  return new FakeGh().set("pr", prJson([PR12])).set("issue", issueJson([])).set("review", "[]").set("ci", "[]");
}

async function lastRecord(): Promise<TriggerRunRecord> {
  const read = await readTriggerRuns(env.root);
  if (read.state !== "present") throw new Error("no run record");
  return read.records.filter((r) => r.outcome !== "reserved").at(-1)!;
}

async function reportText(): Promise<string> {
  const reportPath = (await lastRecord()).agentTask?.reportPath;
  if (reportPath === undefined) throw new Error("the run wrote no report");
  return readFile(path.join(env.root, reportPath), "utf8");
}

async function run(gh: FakeGh, options: { sink?: FakeSink | null; summary?: ReturnType<typeof fakeSummary>["summarize"] } = {}): Promise<void> {
  const target = options.sink === null ? undefined : (options.sink ?? sink);
  await runDigest(env, name, { runGh: gh.run, summarize: options.summary ?? fakeSummary().summarize, now: clock.now, ...(target !== undefined ? { sink: target } : {}) });
}

describe("AC6: where the digest goes", () => {
  test("a project with no remote session gets it in the service topic Digest", async () => {
    await run(quietGh());
    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]).toMatchObject({ via: "topic", to: "Digest" });
    expect(sink.sent[0]?.text).toContain("Digest morning");
    const state = await readDeliveryState(env.root, name);
    expect(state.pending).toEqual([]);
    expect(state.last).toMatchObject({ status: "sent", target: "topic", topic: "Digest", runId: (await lastRecord()).agentTask?.runId });
    expect(await reportText()).toContain('delivered to the "Digest" topic (attempt 1)');
  });

  test("a project with a live remote session gets it in that session's topic, and not in Digest", async () => {
    sink.session = "sess-1";
    await run(quietGh());
    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]).toMatchObject({ via: "session", to: "sess-1" });
    const state = await readDeliveryState(env.root, name);
    expect(state.last).toMatchObject({ status: "sent", target: "session" });
    expect(state.last?.topic).toBeUndefined();
    expect(await reportText()).toContain("delivered to the project's remote session topic");
  });

  test("the service topic is the one the schedule names", async () => {
    name = await addDigestSchedule(env, { name: "evening", topic: "Mornings" });
    await run(quietGh());
    expect(sink.sent[0]).toMatchObject({ via: "topic", to: "Mornings" });
  });

  test("a run with no sink at all (serve is down) queues the message and sends nothing; a later flush delivers it", async () => {
    await run(quietGh(), { sink: null });
    const queued = await readDeliveryState(env.root, name);
    expect(queued.pending).toHaveLength(1);
    expect(queued.last).toBeUndefined();

    const results = await flushDeliveries(env.root, name, sink, clock.now);
    expect(results.map((r) => r.status)).toEqual(["sent"]);
    expect(sink.sent[0]?.text).toContain("Digest morning");
    // the delivery line lands in the report of the run that made the message
    expect(await reportText()).toContain("delivered to the \"Digest\" topic");
  });

  test("the same run is queued once: enqueueing it again replaces it; the queue lives under .metaproject/data", async () => {
    const item = { runId: "run-1", text: "first", topic: "Digest" };
    await enqueueDelivery(env.root, name, item, clock.now());
    await enqueueDelivery(env.root, name, { ...item, text: "second" }, clock.now());
    const state = await readDeliveryState(env.root, name);
    expect(state.pending.map((p) => p.text)).toEqual(["second"]);
    expect(path.relative(env.root, deliveryPath(env.root, name))).toBe(path.join(".metaproject", "data", "digest", name, "delivery.json"));
  });
});

describe("AC6: a failed delivery is written in the report and retried", () => {
  test("a refused send is a line in the report with the reason and the retry time, and the message stays queued", async () => {
    sink.script = [{ ok: false, reason: "Telegram said: chat not found" }];
    await run(quietGh());

    expect(sink.sent).toEqual([]);
    const state = await readDeliveryState(env.root, name);
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]?.attempts).toBe(1);
    expect(state.last).toMatchObject({ status: "failed" });
    const report = await reportText();
    expect(report).toContain('delivery to the "Digest" topic failed: Telegram said: chat not found (attempt 1, retrying after');
    // the run itself still counts as a good run: the digest was built, only the delivery failed
    expect((await lastRecord()).outcome).toBe("ok");
  });

  test("it is not retried before the backoff has passed, and is retried once it has", async () => {
    sink.script = [{ ok: false, reason: "network down" }];
    await run(quietGh());

    clock.advance(backoffMs(1) - 1000);
    expect(await flushDeliveries(env.root, name, sink, clock.now)).toEqual([]);
    expect(sink.sent).toEqual([]);

    clock.advance(2000);
    const results = await flushDeliveries(env.root, name, sink, clock.now);
    expect(results.map((r) => r.status)).toEqual(["sent"]);
    expect(sink.sent).toHaveLength(1);
    const state = await readDeliveryState(env.root, name);
    expect(state.pending).toEqual([]);
    expect(state.last?.status).toBe("sent");
    const report = await reportText();
    expect(report).toContain("failed: network down");
    expect(report).toContain('delivered to the "Digest" topic (attempt 2)');
  });

  test("the delay doubles from five minutes and stops growing at an hour", () => {
    expect([1, 2, 3, 4, 5, 6, 12].map((n) => backoffMs(n) / 60_000)).toEqual([5, 10, 20, 40, 60, 60, 60]);
  });

  test("a sink that throws is a failed attempt, not a crash of the run", async () => {
    const throwing: FakeSink = Object.assign(new FakeSink(), {
      sendToTopic: () => Promise.reject(new Error("socket hang up")),
    });
    await run(quietGh(), { sink: throwing });
    expect((await lastRecord()).outcome).toBe("ok");
    expect(await reportText()).toContain("failed: socket hang up");
    expect((await readDeliveryState(env.root, name)).pending).toHaveLength(1);
  });

  test(`after ${DELIVERY_MAX_ATTEMPTS} refused attempts it gives up, says so in the report, and stops trying`, async () => {
    sink.script = Array.from({ length: DELIVERY_MAX_ATTEMPTS + 3 }, () => ({ ok: false as const, reason: "still refused" }));
    await run(quietGh());
    for (let i = 1; i < DELIVERY_MAX_ATTEMPTS; i += 1) {
      clock.advance(61 * 60_000);
      await flushDeliveries(env.root, name, sink, clock.now);
    }
    const state = await readDeliveryState(env.root, name);
    expect(state.pending).toEqual([]);
    expect(state.last?.status).toBe("gave-up");
    expect(state.last?.detail).toContain(`gave up after ${DELIVERY_MAX_ATTEMPTS} attempts: still refused`);
    expect(await reportText()).toContain(`gave up after ${DELIVERY_MAX_ATTEMPTS} attempts`);

    clock.advance(120 * 60_000);
    expect(await flushDeliveries(env.root, name, sink, clock.now)).toEqual([]);
    expect(sink.sent).toEqual([]);
  });

  test("when Telegram did not take it yet but serve's own queue holds it, the digest does not send it a second time", async () => {
    sink.script = [{ ok: true, state: "queued" }];
    await run(quietGh());
    const state = await readDeliveryState(env.root, name);
    expect(state.pending).toEqual([]);
    expect(state.last?.status).toBe("queued");
    expect(await reportText()).toContain("the remote outbound queue holds it");
    clock.advance(2 * 60 * 60_000);
    expect(await flushDeliveries(env.root, name, sink, clock.now)).toEqual([]);
  });

  test("the serve ticker flushes a message that is waiting, so a retry needs no new run", async () => {
    sink.script = [{ ok: false, reason: "network down" }];
    await run(quietGh());
    expect(sink.sent).toEqual([]);

    const ticker = createDigestTicker({
      roots: () => [env.root],
      now: clock.now,
      fire: async () => {},
      flush: async (root, scheduleName) => {
        await flushDeliveries(root, scheduleName, sink, clock.now);
      },
    });
    await ticker.tick(); // not yet due: the backoff has not passed
    expect(sink.sent).toEqual([]);
    clock.advance(backoffMs(1) + 1000);
    await ticker.tick();
    expect(sink.sent).toHaveLength(1);
  });
});

describe("AC6: a gh or model failure is a report entry and a status line in the topic", () => {
  test("one gh source failing: the digest still goes out, says what it could not read, and the report has the entry", async () => {
    await run(quietGh().fail("ci", "HTTP 502 from api.github.com"));
    const text = sink.sent[0]?.text ?? "";
    expect(text).toContain("Could not read");
    expect(text).toContain(`ci:${REPO}`);
    expect(text).toContain("HTTP 502 from api.github.com");
    expect(await reportText()).toContain(`- ci:${REPO}: gh_run_failed failed: HTTP 502 from api.github.com`);
  });

  test("gh failing for every source stops the run: a status line goes to the topic and the report says why", async () => {
    await rmBoard();
    const gh = new FakeGh().fail("pr", "gh: not logged in").fail("issue", "gh: not logged in").fail("review", "gh: not logged in").fail("ci", "gh: not logged in");
    await run(gh);

    const record = await lastRecord();
    expect(record.outcome).toBe("failed");
    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]?.text.split("\n")[0]).toBe("Digest morning stopped — no source could be read");
    expect(sink.sent[0]?.text).toContain("gh_pr_list failed: gh: not logged in");
    expect(sink.sent[0]?.text).toContain(`Report: ${record.agentTask?.reportPath}`);
    expect(sink.sent[0]?.text).not.toContain("Needs your decision");
    const report = await reportText();
    expect(report).toContain("gh: not logged in");
    expect(report).toContain("## Delivery");
  });

  test("a model that fails does not stop the digest: the plain text goes out and the failure is named as 'model'", async () => {
    await run(quietGh());
    clock.advance(10 * 60_000);
    await run(new FakeGh().set("pr", prJson([{ ...PR12, updatedAt: "2026-10-02T11:00:00Z" }])).set("issue", "[]").set("review", "[]").set("ci", "[]"), { summary: failingSummary("model unreachable: 503") });

    expect((await lastRecord()).outcome).toBe("ok");
    const text = sink.sent[1]?.text ?? "";
    expect(text).toContain("1 change(s) since the last digest");
    expect(text).toContain("Could not read");
    expect(text).toContain("model: model unreachable: 503");
    expect(text).not.toContain("Summary (written by the model)");
    expect(await reportText()).toContain("model: model unreachable: 503");
  });

  test("a failed delivery of a failure status line is retried like any other message", async () => {
    await rmBoard();
    sink.script = [{ ok: false, reason: "network down" }];
    const gh = new FakeGh().fail("pr", "boom").fail("issue", "boom").fail("review", "boom").fail("ci", "boom");
    await run(gh);
    expect(sink.sent).toEqual([]);
    clock.advance(backoffMs(1) + 1000);
    await flushDeliveries(env.root, name, sink, clock.now);
    expect(sink.sent[0]?.text).toContain("stopped — no source could be read");
  });
});

describe("AC6: a refusal is a status line in the topic too", () => {
  async function expectOneStatusLine(fragment: string): Promise<string> {
    expect(sink.sent).toHaveLength(1);
    const text = sink.sent[0]?.text ?? "";
    expect(text.startsWith(`Digest ${name} stopped — `)).toBe(true);
    expect(text).toContain(fragment);
    expect(text.length).toBeLessThan(800);
    expect(sink.sent[0]).toMatchObject({ via: "topic", to: "Digest" });
    return text;
  }

  test("the pinned gh binary changed: the run is refused, nothing is read, and the topic is told", async () => {
    await writeFile(env.ghBin, "#!/bin/sh\necho 'a different program'\n", "utf8");
    await chmod(env.ghBin, 0o755);
    const gh = quietGh();
    await run(gh);

    const record = await lastRecord();
    expect(record.outcome).toBe("dispatch-refused");
    expect(record.agentTask?.refusal).toBe("grants-changed");
    expect(gh.calls).toHaveLength(0);
    await expectOneStatusLine("refusing to run");
    expect((await readDeliveryState(env.root, name)).last?.status).toBe("sent");
  });

  test("a second concurrent run is refused with a status line, and the first run is not disturbed", async () => {
    await ensureLocksDir(env.root);
    const gh = quietGh();
    await withFileLock(dispatchLockPath(env.root, `schedule-${name}`), () => run(gh), { timeoutMs: 1000 });

    const record = await lastRecord();
    expect(record.agentTask?.refusal).toBe("dispatch-locked");
    expect(gh.calls).toHaveLength(0);
    await expectOneStatusLine("already running");
  });

  test("an unsafe scratch directory fails the run with a status line", async () => {
    const saved = process.env["XDG_RUNTIME_DIR"];
    const runtime = path.join(env.aside, "runtime");
    await mkdir(path.join(runtime, "keryx-agent-tasks"), { recursive: true });
    await chmod(path.join(runtime, "keryx-agent-tasks"), 0o755);
    process.env["XDG_RUNTIME_DIR"] = runtime;
    try {
      const gh = quietGh();
      await run(gh);
      expect((await lastRecord()).outcome).toBe("failed");
      expect(gh.calls).toHaveLength(0);
      await expectOneStatusLine("not started");
    } finally {
      if (saved === undefined) delete process.env["XDG_RUNTIME_DIR"];
      else process.env["XDG_RUNTIME_DIR"] = saved;
    }
  });

  test("a refusal with no serve connected queues the line instead of losing it, and serve sends it on its next tick", async () => {
    await writeFile(env.ghBin, "#!/bin/sh\necho 'a different program'\n", "utf8");
    await chmod(env.ghBin, 0o755);
    await run(quietGh(), { sink: null });

    const state = await readDeliveryState(env.root, name);
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]?.text).toContain(`Digest ${name} stopped — refusing to run`);
    expect(state.pending[0]?.topic).toBe("Digest");

    await flushDeliveries(env.root, name, sink, clock.now);
    expect(sink.sent[0]?.text).toContain("stopped — refusing to run");
  });
});

describe("AC6: through serve's own Telegram path (a real hub over the fake Bot API)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness({ clock: new ManualClock() });
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const hubSinkOf = (): ReturnType<typeof hubSink> => hubSink(h.makeHub());

  test("with no session, the digest creates the topic Digest and is written into it; the next digest reuses the topic", async () => {
    const hub = h.makeHub();
    const real = hubSink(hub);
    await runDigest(env, name, { runGh: quietGh().run, summarize: fakeSummary().summarize, now: clock.now, sink: real });

    expect(h.api.topics().map((t) => t.name)).toEqual(["Digest"]);
    const thread = h.api.topics()[0]!.messageThreadId;
    expect(h.api.sentTo(thread)).toHaveLength(1);
    expect(h.api.sentTo(thread)[0]?.text).toContain("Digest morning");
    expect((await readDeliveryState(env.root, name)).last?.status).toBe("sent");

    clock.advance(10 * 60_000);
    await runDigest(env, name, { runGh: quietGh().run, summarize: fakeSummary().summarize, now: clock.now, sink: real });
    expect(h.api.topics()).toHaveLength(1);
    expect(h.api.sentTo(thread)).toHaveLength(2);
    expect(h.api.callCount("createForumTopic")).toBe(1);
  });

  test("with a live session for the project, the digest goes into that session's topic and no Digest topic is made", async () => {
    const hub = h.makeHub();
    const registered = await hub.register({ sessionId: "sess-digest-1", project: env.root, name: "keryx" });
    if (!registered.ok) throw new Error(registered.message);
    await runDigest(env, name, { runGh: quietGh().run, summarize: fakeSummary().summarize, now: clock.now, sink: hubSink(hub) });

    expect(h.api.topics().map((t) => t.name)).toEqual(["keryx"]);
    expect(h.api.sentTo(registered.threadId).some((m) => m.text.includes("Digest morning"))).toBe(true);
    expect((await readDeliveryState(env.root, name)).last).toMatchObject({ status: "sent", target: "session" });
  });

  test("a session of another project does not take the digest", async () => {
    const hub = h.makeHub();
    await hub.register({ sessionId: "sess-other", project: path.join(env.aside, "elsewhere"), name: "elsewhere" });
    const real = hubSink(hub);
    expect(real.sessionFor(env.root)).toBeUndefined();
    await runDigest(env, name, { runGh: quietGh().run, summarize: fakeSummary().summarize, now: clock.now, sink: real });
    expect(h.api.topics().map((t) => t.name).sort()).toEqual(["Digest", "elsewhere"]);
  });

  test("Telegram down: serve's outbound queue holds the message, the report says so, and it arrives when Telegram is back", async () => {
    const hub = h.makeHub();
    // the topic is created while Telegram is up; then it goes down for the digest itself
    await hub.sendToServiceTopic("Digest", "warm-up");
    h.api.setDown(true);
    await runDigest(env, name, { runGh: quietGh().run, summarize: fakeSummary().summarize, now: clock.now, sink: hubSink(hub) });

    expect((await readDeliveryState(env.root, name)).last?.status).toBe("queued");
    expect(await reportText()).toContain("the remote outbound queue holds it");
    expect(hub.outboundPending()).toBeGreaterThan(0);

    h.api.setDown(false);
    await h.clock.advance(10 * 60_000);
    await hub.flushOutbound();
    const thread = h.api.topics()[0]!.messageThreadId;
    expect(h.api.sentTo(thread).some((m) => m.text.includes("Digest morning"))).toBe(true);
    expect(hub.outboundPending()).toBe(0);
  });

  test("Telegram refusing the text for good is a refused delivery that the digest retries by itself", async () => {
    const hub = h.makeHub();
    await hub.sendToServiceTopic("Digest", "warm-up");
    h.api.failNext("sendMessage", new BotApiError("rejected", "Bad Request: chat not found", { status: 400 }));
    const real = hubSink(hub);
    await runDigest(env, name, { runGh: quietGh().run, summarize: fakeSummary().summarize, now: clock.now, sink: real });

    const first = await readDeliveryState(env.root, name);
    expect(first.last?.status).toBe("failed");
    expect(first.last?.detail).toContain("chat not found");
    expect(first.pending).toHaveLength(1);

    clock.advance(backoffMs(1) + 1000);
    await flushDeliveries(env.root, name, real, clock.now);
    const thread = h.api.topics()[0]!.messageThreadId;
    expect(h.api.sentTo(thread).some((m) => m.text.includes("Digest morning"))).toBe(true);
    expect((await readDeliveryState(env.root, name)).last?.status).toBe("sent");
  });

  test("a topic name Telegram would not accept is a refusal in the report, not an exception", async () => {
    const result = await hubSinkOf().sendToTopic("", "text");
    expect(result.ok).toBe(false);
  });
});

// ---- helpers local to this file ----------------------------------------------

async function rmBoard(): Promise<void> {
  await rm(indexPath(env.root), { force: true });
}

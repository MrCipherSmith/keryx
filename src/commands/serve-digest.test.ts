// Flow 389: how serve fires a digest.
//
// `runTriggerOnce` sets `process.exitCode = 1` for a failed run, which is right for
// `keryx trigger run` and wrong for a long-running `keryx serve`: a digest that failed is in the
// record, the report and the topic, and must not make serve exit non-zero later.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  addDigestSchedule,
  FakeGh,
  FakeSink,
  fakeSummary,
  runDigest,
  setupDigestEnv,
  TestClock,
  type DigestTestEnv,
} from "../scheduler/digest.test-helpers";
import { fireDigest } from "./serve-digest";

let env: DigestTestEnv;
let clock: TestClock;
let name = "";
let sink: FakeSink;

beforeEach(async () => {
  // No product index and every gh call failing: the run reads nothing at all and is "failed".
  env = await setupDigestEnv({ board: false });
  clock = new TestClock("2026-10-02T12:00:00Z");
  sink = new FakeSink();
  name = await addDigestSchedule(env);
});

afterEach(async () => {
  await env.teardown();
});

function downGh(): FakeGh {
  return new FakeGh().fail("pr", "HTTP 502").fail("issue", "HTTP 502").fail("review", "HTTP 502").fail("ci", "HTTP 502");
}

describe("serve fires a digest without leaving a failure exit code behind", () => {
  test("the plain trigger path does set exit code 1 for a failed digest (the premise)", async () => {
    await runDigest(env, name, { runGh: downGh().run, summarize: fakeSummary().summarize, now: clock.now, sink });
    expect(process.exitCode).toBe(1);
    expect(sink.sent[0]?.text).toContain("stopped — no source could be read");
  });

  test("fireDigest runs the same failed digest, delivers its status line, and leaves process.exitCode as it was", async () => {
    process.exitCode = 0;
    await fireDigest(env.root, name, { runGh: downGh().run, summarize: fakeSummary().summarize, now: clock.now, sink });
    expect(sink.sent[0]?.text).toContain("stopped — no source could be read");
    expect(process.exitCode).toBe(0);
  });

  test("it puts back a value that was already there, and also after an unknown schedule name", async () => {
    process.exitCode = 3;
    await fireDigest(env.root, name, { runGh: downGh().run, summarize: fakeSummary().summarize, now: clock.now, sink });
    expect(process.exitCode).toBe(3);

    process.exitCode = 0;
    await expect(fireDigest(env.root, "no-such-schedule", { runGh: downGh().run, summarize: fakeSummary().summarize, now: clock.now, sink })).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);
  });
});

// Flow 389, AC2: a run calls the granted tools and stores their answers in the run report.
//
// Open issues and PRs, reviews waiting for the operator and failed CI, for every allowed
// repository, plus the product index of the flow board. The gh is a fake that answers from
// fixtures and records the argv it was given; the summary is scripted.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readDigestBoard } from "../commands/product";
import { indexPath } from "../product/store";
import { readTriggerRuns, type TriggerRunRecord } from "../trigger/record";
import {
  addDigestSchedule,
  ciJson,
  FakeGh,
  FakeSink,
  fakeSummary,
  issueJson,
  OTHER_REPO,
  prJson,
  REPO,
  runDigest,
  setupDigestEnv,
  TestClock,
  type DigestTestEnv,
} from "./digest.test-helpers";
import { registerBoardReader, type BoardSource } from "./digest-board";
import { deliveryPath } from "./digest-delivery";

let env: DigestTestEnv;
let clock: TestClock;
let name = "";

beforeEach(async () => {
  env = await setupDigestEnv();
  clock = new TestClock("2026-10-02T12:00:00Z");
});

afterEach(async () => {
  await env.teardown();
});

async function lastRecord(): Promise<TriggerRunRecord> {
  const read = await readTriggerRuns(env.root);
  if (read.state !== "present") throw new Error(`no run record: ${read.state}`);
  const records = read.records.filter((r) => r.outcome !== "reserved");
  return records[records.length - 1]!;
}

async function reportOf(record: TriggerRunRecord): Promise<string> {
  const reportPath = record.agentTask?.reportPath;
  if (reportPath === undefined) throw new Error("the run wrote no report");
  return readFile(path.join(env.root, reportPath), "utf8");
}

function populatedGh(): FakeGh {
  return new FakeGh()
    .set("pr", prJson([{ number: 12, title: "Add the retry button", author: "alice", updatedAt: "2026-10-01T09:00:00Z" }]))
    .set("issue", issueJson([{ number: 40, title: "Crash on empty export", updatedAt: "2026-09-30T09:00:00Z" }]))
    .set("review", prJson([{ number: 15, title: "Fix the lockfile drift", author: "carol", updatedAt: "2026-10-02T08:00:00Z" }]))
    .set("ci", ciJson([{ id: 9001, title: "ci: unit tests", branch: "main", createdAt: "2026-10-02T07:00:00Z" }]));
}

describe("AC2: the run calls the four granted read-only tools for the allowed repository", () => {
  test("open PRs, open issues, reviews requested from the operator, and failed CI are each asked for, once", async () => {
    name = await addDigestSchedule(env);
    const gh = populatedGh();
    await runDigest(env, name, { runGh: gh.run, summarize: fakeSummary().summarize, now: clock.now });

    expect(gh.calls.map((c) => c.kind).sort()).toEqual(["ci", "issue", "pr", "review"]);
    expect(gh.calls.every((c) => c.repo === REPO)).toBe(true);
    const record = await lastRecord();
    expect(record.outcome).toBe("ok");
    expect(record.agentTask?.grantedCalls?.map((c) => c.tool).sort()).toEqual(["gh_issue_list", "gh_pr_list", "gh_pr_review_requested", "gh_run_failed"]);
    expect(record.agentTask?.grantedCalls?.every((c) => c.ok)).toBe(true);
  });

  test("the run report holds each answer verbatim, the calls, and the digest built from them", async () => {
    name = await addDigestSchedule(env);
    await runDigest(env, name, { runGh: populatedGh().run, summarize: fakeSummary().summarize, now: clock.now });
    const report = await reportOf(await lastRecord());

    expect(report).toContain("## Granted tool calls");
    expect(report).toContain("- gh_pr_list → ok");
    expect(report).toContain("- gh_issue_list → ok");
    expect(report).toContain("- gh_pr_review_requested → ok");
    expect(report).toContain("- gh_run_failed → ok");
    expect(report).toContain("## Raw answers");
    // each tool's own answer is stored under its source
    expect(report).toContain(`### pr:${REPO} (gh_pr_list)`);
    expect(report).toContain("Add the retry button");
    expect(report).toContain(`### issue:${REPO} (gh_issue_list)`);
    expect(report).toContain("Crash on empty export");
    expect(report).toContain(`### review:${REPO} (gh_pr_review_requested)`);
    expect(report).toContain("Fix the lockfile drift");
    expect(report).toContain(`### ci:${REPO} (gh_run_failed)`);
    expect(report).toContain("ci: unit tests");
    expect(report).toContain("- run: ");
    expect(report).toContain("- cost: $");
  });

  test("a review waiting for the operator is named in the digest that is delivered", async () => {
    name = await addDigestSchedule(env);
    const gh = populatedGh();
    const sent: string[] = [];
    await runDigest(env, name, {
      runGh: gh.run,
      summarize: fakeSummary().summarize,
      now: clock.now,
      sink: {
        sessionFor: () => undefined,
        sendToSession: async () => ({ ok: true, state: "sent" }),
        sendToTopic: async (_topic, text) => {
          sent.push(text);
          return { ok: true, state: "sent" };
        },
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Needs your decision");
    expect(sent[0]).toContain("Fix the lockfile drift");
  });

  test("the argv of every call is the catalogue's fixed, read-only argv: bound to the repository, no shell, no write verb", async () => {
    name = await addDigestSchedule(env);
    const gh = populatedGh();
    await runDigest(env, name, { runGh: gh.run, summarize: fakeSummary().summarize, now: clock.now });
    for (const call of gh.calls) {
      expect(["pr", "issue", "run"]).toContain(call.argv[0]!);
      expect(["list"]).toContain(call.argv[1]!);
      expect(call.argv[call.argv.indexOf("--repo") + 1]).toBe(REPO);
      expect(call.argv).not.toContain("api");
      expect(call.argv).not.toContain("auth");
      expect(call.bin).toBe(env.ghBin);
    }
    const review = gh.calls.find((c) => c.kind === "review")!;
    expect(review.argv).toContain("review-requested:@me");
    const ci = gh.calls.find((c) => c.kind === "ci")!;
    expect(ci.argv).toContain("failure");
  });
});

describe("AC2: every allowed repository is read, and only those", () => {
  test("two allowed repositories give eight calls; a repository that was not listed is never asked for", async () => {
    name = await addDigestSchedule(env, { repos: [REPO, OTHER_REPO] });
    const gh = populatedGh().empty(OTHER_REPO);
    await runDigest(env, name, { runGh: gh.run, summarize: fakeSummary().summarize, now: clock.now });
    expect(gh.calls).toHaveLength(8);
    expect(new Set(gh.calls.map((c) => c.repo))).toEqual(new Set([REPO, OTHER_REPO]));
    const report = await reportOf(await lastRecord());
    expect(report).toContain(`- repositories: ${REPO}, ${OTHER_REPO}`);
    expect(report).toContain(`### ci:${OTHER_REPO} (gh_run_failed)`);
  });

  test("the default digest reads MrCipherSmith/keryx alone", async () => {
    name = await addDigestSchedule(env);
    const gh = populatedGh();
    await runDigest(env, name, { runGh: gh.run, summarize: fakeSummary().summarize, now: clock.now });
    expect(new Set(gh.calls.map((c) => c.repo))).toEqual(new Set(["MrCipherSmith/keryx"]));
  });
});

describe("AC2: the flow board comes from the product index", () => {
  test("the board's chains are in the digest and the report, and the board is part of the snapshot", async () => {
    name = await addDigestSchedule(env);
    await runDigest(env, name, { runGh: populatedGh().run, summarize: fakeSummary().summarize, now: clock.now });
    const report = await reportOf(await lastRecord());
    expect(report).toContain("PR merged, flow closed, effect not checked");
    expect(report).toContain('flow 001 "Retry checkout on a stale token"');
    expect(report).toContain('flow 003 "Rename the export button"');
    expect(report).toContain('flow 005 "Bump the lockfile"');
    const snapshot = JSON.parse(await readFile(path.join(env.root, ".metaproject", "data", "digest", name, "snapshot.json"), "utf8")) as { entries: Record<string, string> };
    expect(Object.keys(snapshot.entries)).toContain("board:001");
    expect(Object.keys(snapshot.entries)).toContain("pr:MrCipherSmith/keryx#12");
  });

  test("no product index: the run says so in the report, and the GitHub part is still delivered", async () => {
    await rm(indexPath(env.root));
    name = await addDigestSchedule(env);
    await runDigest(env, name, { runGh: populatedGh().run, summarize: fakeSummary().summarize, now: clock.now });
    const record = await lastRecord();
    const report = await reportOf(record);
    expect(record.outcome).toBe("ok");
    expect(report).toContain("- board: no product index");
    expect(report).toContain("Fix the lockfile drift");
  });
});

describe("AC2: a source that fails is an entry, not the end of the run", () => {
  test("a failing CI call is written to the report, and the other three sources are still read", async () => {
    name = await addDigestSchedule(env);
    const gh = populatedGh().fail("ci", "HTTP 502 from api.github.com");
    await runDigest(env, name, { runGh: gh.run, summarize: fakeSummary().summarize, now: clock.now });
    const record = await lastRecord();
    const report = await reportOf(record);
    expect(gh.calls).toHaveLength(4);
    expect(record.outcome).toBe("ok");
    expect(report).toContain(`- ci:${REPO}: gh_run_failed failed: HTTP 502 from api.github.com`);
    expect(report).toContain("- gh_run_failed → failed");
    expect(report).toContain("Fix the lockfile drift");
  });

  test("gh answering something that is not JSON is a failure entry for that source", async () => {
    name = await addDigestSchedule(env);
    const gh = populatedGh().set("issue", "this is not json");
    await runDigest(env, name, { runGh: gh.run, summarize: fakeSummary().summarize, now: clock.now });
    expect(await reportOf(await lastRecord())).toContain(`- issue:${REPO}: gh_issue_list: gh did not answer with JSON`);
  });

  test("every gh call failing and no board is a failed run, with the reason in the record", async () => {
    await rm(indexPath(env.root));
    name = await addDigestSchedule(env);
    const gh = new FakeGh().fail("pr", "boom").fail("issue", "boom").fail("review", "boom").fail("ci", "boom");
    await runDigest(env, name, { runGh: gh.run, summarize: fakeSummary().summarize, now: clock.now });
    const record = await lastRecord();
    expect(record.outcome).toBe("failed");
    expect(record.detail).toContain("no source could be read");
  });
});

describe("review findings of flow 389", () => {
  test("L-3: a board reader that throws is a board failure entry; the GitHub half is still delivered, and it is not a crash", async () => {
    name = await addDigestSchedule(env);
    const sink = new FakeSink();
    registerBoardReader(async () => {
      throw new Error("index exploded");
    });
    try {
      await runDigest(env, name, { runGh: populatedGh().run, summarize: fakeSummary().summarize, now: clock.now, sink });
    } finally {
      registerBoardReader(readDigestBoard);
    }
    const record = await lastRecord();
    expect(record.outcome).toBe("ok");
    expect(record.detail).not.toContain("threw");
    expect(await reportOf(record)).toContain("- board: the board could not be read: index exploded");
    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]?.text).toContain("Fix the lockfile drift");
    expect(sink.sent[0]?.text).not.toContain("stopped");
  });

  test("L-5: a change is not marked as reported before its message is queued; a run whose message could not be queued reports it next time", async () => {
    name = await addDigestSchedule(env);
    const first = populatedGh();
    await runDigest(env, name, { runGh: first.run, summarize: fakeSummary().summarize, now: clock.now, sink: new FakeSink() });

    // the delivery queue cannot be written: a non-empty directory sits where delivery.json goes
    const queue = deliveryPath(env.root, name);
    await rm(queue, { force: true });
    await mkdir(queue, { recursive: true });
    await writeFile(path.join(queue, "blocker"), "x", "utf8");
    const changed = populatedGh().set("pr", prJson([{ number: 12, title: "NEWCHANGE retry button", author: "alice", updatedAt: "2026-10-02T11:00:00Z" }]));
    clock.set("2026-10-03T12:00:00Z");
    await runDigest(env, name, { runGh: changed.run, summarize: fakeSummary().summarize, now: clock.now, sink: new FakeSink() }).catch(() => {});
    await rm(queue, { recursive: true, force: true });

    const sink = new FakeSink();
    clock.set("2026-10-04T12:00:00Z");
    await runDigest(env, name, { runGh: changed.run, summarize: fakeSummary().summarize, now: clock.now, sink });
    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]?.text).toContain("NEWCHANGE");
    expect(sink.sent[0]?.text).not.toContain("nothing changed since the last digest");
  });

  test("S-1: a token in a board field never reaches the delivered message, which is scrubbed at the last hop", async () => {
    name = await addDigestSchedule(env);
    const token = "ghp_AbCdEf0123456789AbCdEf0123456789AbCd";
    const board: BoardSource = {
      state: "present",
      entries: [{ id: "900", title: `rotate the key ${token}`, status: "open", closedAt: null, verdict: "" }],
      chains: [{ id: "901", title: `closed with ${token}`, closedAt: "2026-09-30", outcome: "no criterion stated", hasCriterion: false }],
    };
    registerBoardReader(async () => board);
    const sink = new FakeSink();
    try {
      await runDigest(env, name, { runGh: populatedGh().run, summarize: fakeSummary().summarize, now: clock.now, sink });
    } finally {
      registerBoardReader(readDigestBoard);
    }
    expect(sink.sent).toHaveLength(1);
    const text = sink.sent[0]!.text;
    expect(text).toContain("closed with");
    expect(text).not.toContain(token);
    expect(text).not.toContain("ghp_AbCdEf");
    expect(text).toContain("[redacted");
  });

  test("S-3: the report says which gh account the digest asked for, and that only the gh wrapper honours it", async () => {
    name = await addDigestSchedule(env);
    await runDigest(env, name, {
      runGh: populatedGh().run,
      summarize: fakeSummary().summarize,
      now: clock.now,
      grantedEnv: { PATH: process.env["PATH"], GH_WORK_ROOT: path.dirname(env.root) },
    });
    const report = await reportOf(await lastRecord());
    expect(report).toContain("- gh account asked for: work (set through GH_ACCOUNT; only the gh wrapper honours it");
  });
});

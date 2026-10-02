// Flow 389, AC4: the snapshot a digest is compared with.
//
// A snapshot of (id, updatedAt) is kept in `.metaproject/data`. The first run is marked
// "baseline". A second run with no changes gives a digest with no items. One change gives only
// that change.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readTriggerRuns } from "../trigger/record";
import {
  addDigestSchedule,
  ciJson,
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
import { diffSnapshot, nextSnapshot, readSnapshot, snapshotPath, type DigestItem, type DigestSnapshot } from "./digest-snapshot";

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
const PR13 = { number: 13, title: "Tidy the docs", updatedAt: "2026-10-01T10:00:00Z" };

function ghWith(prs: Parameters<typeof prJson>[0], issues: Parameters<typeof issueJson>[0] = [{ number: 40, title: "Crash on empty export", updatedAt: "2026-09-30T09:00:00Z" }]): FakeGh {
  return new FakeGh().set("pr", prJson(prs)).set("issue", issueJson(issues)).set("review", "[]").set("ci", "[]");
}

async function run(gh: FakeGh, summary = fakeSummary()): Promise<{ text: string; summaryCalls: number }> {
  const before = sink.sent.length;
  await runDigest(env, name, { runGh: gh.run, summarize: summary.summarize, now: clock.now, sink });
  clock.advance(10 * 60_000);
  return { text: sink.sent[before]?.text ?? "", summaryCalls: summary.calls() };
}

async function lastDetail(): Promise<string> {
  const read = await readTriggerRuns(env.root);
  if (read.state !== "present") throw new Error("no record");
  return read.records.filter((r) => r.outcome !== "reserved").at(-1)!.detail;
}

describe("AC4: the snapshot holds (id, updatedAt) in .metaproject/data", () => {
  test("after a run the snapshot lists every item seen with its updatedAt, in a directory git ignores", async () => {
    await run(ghWith([PR12, PR13]));
    const file = snapshotPath(env.root, name);
    expect(path.relative(env.root, file)).toBe(path.join(".metaproject", "data", "digest", name, "snapshot.json"));
    const snapshot = JSON.parse(await readFile(file, "utf8")) as DigestSnapshot;
    expect(snapshot.version).toBe(1);
    expect(snapshot.entries[`pr:${REPO}#12`]).toBe("2026-10-01T09:00:00Z");
    expect(snapshot.entries[`pr:${REPO}#13`]).toBe("2026-10-01T10:00:00Z");
    expect(snapshot.entries[`issue:${REPO}#40`]).toBe("2026-09-30T09:00:00Z");
    expect(Object.keys(snapshot.entries).some((k) => k.startsWith("board:"))).toBe(true);
    expect(await readFile(path.join(env.root, ".metaproject", "data", "digest", ".gitignore"), "utf8")).toContain("*");
  });
});

describe("AC4: the first run is a baseline", () => {
  test("it says so in the digest, the report and the run record, and lists no changes", async () => {
    const summary = fakeSummary();
    const { text, summaryCalls } = await run(ghWith([PR12, PR13]), summary);
    expect(text).toContain("first run: baseline taken");
    expect(text).not.toContain("What changed");
    expect(text).not.toContain("— new");
    expect(await lastDetail()).toContain("(baseline)");
    const read = await readTriggerRuns(env.root);
    const reportPath = read.state === "present" ? read.records.at(-1)?.agentTask?.reportPath : undefined;
    expect(await readFile(path.join(env.root, reportPath!), "utf8")).toContain("- kind: baseline");
    // nothing to summarise: the model is not called at all
    expect(summaryCalls).toBe(0);
  });
});

describe("AC4: a second run with no changes gives a digest with no items", () => {
  test("the digest says nothing changed, has no change section and no PR or issue line, and costs no model call", async () => {
    await run(ghWith([PR12, PR13]));
    const summary = fakeSummary();
    const { text, summaryCalls } = await run(ghWith([PR12, PR13]), summary);

    expect(text).toContain("nothing changed since the last digest");
    expect(text).not.toContain("What changed");
    expect(text).not.toContain("Add the retry button");
    expect(text).not.toContain("Tidy the docs");
    expect(text).not.toContain("Crash on empty export");
    expect(text).not.toContain("— new");
    expect(text).not.toContain("— updated");
    expect(text).not.toContain("closed or merged");
    expect(summaryCalls).toBe(0);
    expect(await lastDetail()).toContain("(nothing changed)");
  });

  test("three runs in a row with the same data stay quiet", async () => {
    await run(ghWith([PR12, PR13]));
    await run(ghWith([PR12, PR13]));
    const { text } = await run(ghWith([PR12, PR13]));
    expect(text).toContain("nothing changed since the last digest");
  });
});

describe("AC4: one change gives only that change", () => {
  test("a PR whose updatedAt moved is the one line under What changed", async () => {
    await run(ghWith([PR12, PR13]));
    const { text } = await run(ghWith([PR12, { ...PR13, updatedAt: "2026-10-02T11:00:00Z" }]));

    expect(text).toContain("1 change(s) since the last digest");
    expect(text).toContain("What changed");
    expect(text).toContain(`PR ${REPO}#13 "Tidy the docs" by alice — updated`);
    expect(text).not.toContain("Add the retry button");
    expect(text).not.toContain("Crash on empty export");
    expect((text.match(/— updated/g) ?? []).length).toBe(1);
    expect(await lastDetail()).toContain("1 change(s)");
  });

  test("a new issue is reported as new, and only it", async () => {
    await run(ghWith([PR12]));
    const { text } = await run(ghWith([PR12], [{ number: 40, title: "Crash on empty export", updatedAt: "2026-09-30T09:00:00Z" }, { number: 41, title: "Typo in the README", updatedAt: "2026-10-02T11:30:00Z" }]));
    expect(text).toContain(`issue ${REPO}#41 "Typo in the README" by bob — new`);
    expect(text).toContain("1 change(s)");
    expect(text).not.toContain("Crash on empty export");
  });

  test("a PR that left the open list is reported as closed or merged", async () => {
    await run(ghWith([PR12, PR13]));
    const { text } = await run(ghWith([PR12]));
    expect(text).toContain(`PR ${REPO}#13 — closed or merged`);
    expect(text).toContain("1 change(s)");
  });

  test("the change is reported once; the next run, with the same data, is quiet again", async () => {
    await run(ghWith([PR12, PR13]));
    const moved = ghWith([PR12, { ...PR13, updatedAt: "2026-10-02T11:00:00Z" }]);
    await run(moved);
    const { text } = await run(ghWith([PR12, { ...PR13, updatedAt: "2026-10-02T11:00:00Z" }]));
    expect(text).toContain("nothing changed since the last digest");
  });

  test("a change runs the model summary once, above the plain text", async () => {
    await run(ghWith([PR12, PR13]));
    const summary = fakeSummary("PR 13 moved.");
    const { text, summaryCalls } = await run(ghWith([PR12, { ...PR13, updatedAt: "2026-10-02T11:00:00Z" }]), summary);
    expect(summaryCalls).toBe(1);
    expect(text.startsWith("Summary (written by the model)\nPR 13 moved.")).toBe(true);
    expect(text).toContain("What changed");
  });
});

describe("AC4: a source that could not be read is not mistaken for 'everything closed'", () => {
  test("a failed PR read reports no PR as gone, and the next good run compares with the old snapshot", async () => {
    await run(ghWith([PR12, PR13]));
    const { text } = await run(ghWith([PR12, PR13]).fail("pr", "HTTP 502"));
    expect(text).not.toContain("closed or merged");
    expect(text).toContain("Could not read");
    expect(text).toContain(`pr:${REPO}`);

    const back = await run(ghWith([PR12, PR13]));
    expect(back.text).toContain("nothing changed since the last digest");
  });

  test("a first run that could not read a source is not stored as the baseline", async () => {
    await run(ghWith([PR12]).fail("issue", "HTTP 502"));
    expect(await readSnapshot(env.root, name)).toBeUndefined();
    const { text } = await run(ghWith([PR12]));
    expect(text).toContain("first run: baseline taken");
  });
});

describe("AC4: the snapshot functions", () => {
  const item = (id: string, stamp: string): DigestItem => ({ key: `pr:${REPO}#${id}`, kind: "pr", repo: REPO, id, title: `PR ${id}`, stamp });

  test("no previous snapshot is a baseline with no added, updated or gone", () => {
    expect(diffSnapshot(undefined, [item("1", "a")], new Set())).toEqual({ baseline: true, added: [], updated: [], gone: [] });
  });

  test("added, updated and gone are told apart by the stamp", () => {
    const previous = nextSnapshot(undefined, [item("1", "a"), item("2", "b"), item("3", "c")], new Set(), "t0");
    const diff = diffSnapshot(previous, [item("1", "a"), item("2", "B"), item("4", "d")], new Set());
    expect(diff.baseline).toBe(false);
    expect(diff.added.map((i) => i.id)).toEqual(["4"]);
    expect(diff.updated.map((i) => i.id)).toEqual(["2"]);
    expect(diff.gone).toEqual([`pr:${REPO}#3`]);
  });

  test("the previous entries of a failed source are carried into the next snapshot", () => {
    const previous = nextSnapshot(undefined, [item("1", "a")], new Set(), "t0");
    const next = nextSnapshot(previous, [], new Set([`pr:${REPO}`]), "t1");
    expect(next.entries[`pr:${REPO}#1`]).toBe("a");
    expect(next.takenAt).toBe("t1");
  });

  test("CI and review entries leaving their lists are not news", () => {
    const previous: DigestSnapshot = { version: 1, takenAt: "t0", entries: { [`ci:${REPO}#9`]: "x", [`review:${REPO}#9`]: "y" } };
    expect(diffSnapshot(previous, [], new Set()).gone).toEqual([]);
  });
});

describe("AC4: a CI run that is still failing is called out", () => {
  test("a failed run seen in the previous snapshot is stuck, a new one is a change", async () => {
    const ci = (ids: number[]): FakeGh => ghWith([PR12]).set("ci", ciJson(ids.map((id) => ({ id, createdAt: "2026-10-02T07:00:00Z" }))));
    await run(ci([1]));
    const { text } = await run(ci([1, 2]));
    expect(text).toContain(`failed CI run ${REPO}#2`);
    expect(text).toContain(`failed CI run ${REPO}#1 "run 1 (main)" — still failing since the last digest`);
  });
});

// Flow 389, AC5: what the digest says.
//
// The digest names what changed, what is stuck, what needs the operator's decision, and every
// "PR merged, flow closed, effect not checked" chain in the product index. The content builder
// is pure, so most of this is data in and text out; one test runs a whole digest to show the
// chains come from the real product index.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { OpenEntry } from "../product/service";
import {
  addDigestSchedule,
  FakeGh,
  FakeSink,
  fakeSummary,
  prJson,
  REPO,
  runDigest,
  setupDigestEnv,
  TestClock,
  type DigestTestEnv,
} from "./digest.test-helpers";
import { buildDigestContent, DIGEST_STUCK_DAYS, renderDigestText, type DigestContentInput } from "./digest-content";
import { diffSnapshot, type DigestItem, type DigestSnapshot } from "./digest-snapshot";

const NOW = new Date("2026-10-02T12:00:00Z");
const HEADER = { name: "morning", at: "2026-10-02T12:00:00.000Z" };

function pr(id: number, over: Partial<DigestItem> = {}): DigestItem {
  return {
    key: `pr:${REPO}#${id}`,
    kind: "pr",
    repo: REPO,
    id: String(id),
    title: `PR ${id}`,
    url: `https://github.com/${REPO}/pull/${id}`,
    stamp: "2026-10-01T09:00:00Z",
    author: "alice",
    draft: false,
    ...over,
  };
}

function review(id: number): DigestItem {
  return { ...pr(id), key: `review:${REPO}#${id}`, kind: "review", title: `Review me ${id}` };
}

function ci(id: number): DigestItem {
  return { key: `ci:${REPO}#${id}`, kind: "ci", repo: REPO, id: String(id), title: `ci run ${id} (main)`, stamp: "2026-10-02T07:00:00Z" };
}

function chain(id: string, title: string, over: Partial<OpenEntry> = {}): OpenEntry {
  return { id, title, path: `.metaproject/flows/${id}`, closedAt: "2026-09-20T10:00:00.000Z", outcome: "error rate drops", hasCriterion: true, outcomeAuthor: "human", ...over };
}

function build(over: Partial<DigestContentInput> & { items?: readonly DigestItem[]; previous?: DigestSnapshot }): ReturnType<typeof buildDigestContent> {
  const items = over.items ?? [];
  const previous = over.previous;
  return buildDigestContent({
    items,
    diff: over.diff ?? diffSnapshot(previous, items, new Set()),
    previous,
    failures: over.failures ?? [],
    chains: over.chains ?? [],
    now: NOW,
    ...(over.stuckDays !== undefined ? { stuckDays: over.stuckDays } : {}),
  });
}

const snapshotOf = (entries: Record<string, string>): DigestSnapshot => ({ version: 1, takenAt: "2026-10-01T00:00:00Z", entries });

describe("AC5: what changed", () => {
  test("new, updated and closed-or-merged items are each named, with their author", () => {
    const previous = snapshotOf({ [`pr:${REPO}#1`]: "2026-09-30T00:00:00Z", [`pr:${REPO}#2`]: "2026-09-30T00:00:00Z", [`pr:${REPO}#3`]: "2026-09-30T00:00:00Z" });
    const content = build({ previous, items: [pr(1, { stamp: "2026-09-30T00:00:00Z" }), pr(2, { stamp: "2026-10-02T06:00:00Z", title: "Moved" }), pr(4, { title: "Brand new", author: "dave" })] });
    const text = renderDigestText(content, HEADER);

    expect(content.changeCount).toBe(3);
    expect(text).toContain("3 change(s) since the last digest");
    expect(text).toContain(`PR ${REPO}#4 "Brand new" by dave — new`);
    expect(text).toContain(`PR ${REPO}#2 "Moved" by alice — updated`);
    expect(text).toContain(`PR ${REPO}#3 — closed or merged`);
    expect(text).not.toContain(`PR ${REPO}#1 "PR 1"`);
  });

  test("a baseline reports no changes, and says why", () => {
    const content = build({ items: [pr(1)] });
    const text = renderDigestText(content, HEADER);
    expect(content.baseline).toBe(true);
    expect(content.changes).toEqual([]);
    expect(text).toContain("first run: baseline taken");
    expect(text).not.toContain("What changed");
  });

  test("a board entry that changed is named as a flow", () => {
    const board: DigestItem = { key: "board:004", kind: "board", id: "004", title: "Export the audit log", stamp: "closed|2026-10-02|" };
    const previous = snapshotOf({ "board:004": "open||" });
    const content = build({ previous, items: [board] });
    expect(renderDigestText(content, HEADER)).toContain('flow 004 "Export the audit log" — updated');
  });
});

describe("AC5: what is stuck", () => {
  test(`a PR or issue with no update for ${DIGEST_STUCK_DAYS} days is stuck, one younger is not`, () => {
    const old = pr(8, { stamp: "2026-09-24T12:00:00Z", title: "Old PR" });
    const fresh = pr(9, { stamp: "2026-09-26T12:00:00Z", title: "Fresh PR" });
    const issue: DigestItem = { key: `issue:${REPO}#7`, kind: "issue", repo: REPO, id: "7", title: "Old issue", stamp: "2026-09-10T00:00:00Z", author: "bob" };
    const content = build({ previous: snapshotOf({}), items: [old, fresh, issue] });
    const text = renderDigestText(content, HEADER);

    expect(content.stuck.map((l) => l.text)).toEqual([
      expect.stringContaining('Old PR" by alice — no update for 8 days'),
      expect.stringContaining('issue ' + REPO + '#7 "Old issue" by bob — no update for 22 days'),
    ]);
    expect(text).toContain("Stuck");
    expect(text).not.toContain("Fresh PR\" by alice — no update");
  });

  test("the limit is the one given, so a stricter caller can ask for fewer days", () => {
    const content = build({ previous: snapshotOf({}), items: [pr(8, { stamp: "2026-09-30T12:00:00Z" })], stuckDays: 2 });
    expect(content.stuck).toHaveLength(1);
  });

  test("a CI failure that was already in the last snapshot is stuck; a first-time failure is not", () => {
    const previous = snapshotOf({ [`ci:${REPO}#1`]: "2026-10-02T07:00:00Z" });
    const content = build({ previous, items: [ci(1), ci(2)] });
    expect(content.stuck.map((l) => l.text)).toEqual([expect.stringContaining(`failed CI run ${REPO}#1 "ci run 1 (main)" — still failing since the last digest`)]);
    expect(content.changes.map((l) => l.text)).toEqual([expect.stringContaining(`failed CI run ${REPO}#2`)]);
  });

  test("with nothing stuck the section says so", () => {
    expect(renderDigestText(build({ previous: snapshotOf({}), items: [pr(1)] }), HEADER)).toContain("nothing is stuck");
  });
});

describe("AC5: what needs the operator's decision", () => {
  test("a review requested from the operator is named", () => {
    const content = build({ previous: snapshotOf({}), items: [review(15)] });
    expect(content.decisions.map((l) => l.text)).toEqual([expect.stringContaining('Review me 15" by alice — your review is requested')]);
  });

  test("an approved, non-draft PR waits for the operator to merge it; a draft or a not-approved one does not", () => {
    const content = build({
      previous: snapshotOf({}),
      items: [
        pr(20, { reviewDecision: "APPROVED", title: "Ready" }),
        pr(21, { reviewDecision: "APPROVED", draft: true, title: "Draft" }),
        pr(22, { reviewDecision: "CHANGES_REQUESTED", title: "Needs work" }),
        pr(23, { reviewDecision: "", title: "Unreviewed" }),
      ],
    });
    expect(content.decisions.map((l) => l.text)).toEqual([expect.stringContaining('Ready" by alice — approved, waiting for you to merge')]);
  });

  test("nothing waiting is stated, not left blank", () => {
    expect(renderDigestText(build({ previous: snapshotOf({}), items: [] }), HEADER)).toContain("nothing waits for you");
  });

  test("a PR that is both a decision and a change is listed once, under the decision", () => {
    const previous = snapshotOf({ [`pr:${REPO}#20`]: "2026-09-30T00:00:00Z" });
    const content = build({ previous, items: [pr(20, { reviewDecision: "APPROVED", stamp: "2026-10-02T06:00:00Z" })] });
    expect(content.decisions).toHaveLength(1);
    expect(content.changes).toHaveLength(0);
    expect(content.changeCount).toBe(1);
  });
});

describe("AC5: every 'PR merged, flow closed, effect not checked' chain is named", () => {
  const chains = [chain("001", "Retry checkout on a stale token"), chain("003", "Rename the export button", { hasCriterion: false, outcome: "not measured — no instrument stated", closedAt: null })];

  test("each chain from the product index is a line with its flow, closing date and what to check", () => {
    const content = build({ previous: snapshotOf({}), items: [], chains });
    const text = renderDigestText(content, HEADER);
    expect(text).toContain("PR merged, flow closed, effect not checked");
    expect(text).toContain('flow 001 "Retry checkout on a stale token" — PR merged, flow closed 2026-09-20, effect not checked (to check: error rate drops)');
    expect(text).toContain('flow 003 "Rename the export button" — PR merged, flow closed, effect not checked (no outcome criterion stated)');
    expect(content.chains).toHaveLength(2);
  });

  test("they are listed on a quiet run and on a baseline, because they stay open until the effect is checked", () => {
    const quiet = build({ previous: snapshotOf({}), items: [], chains });
    const baseline = build({ items: [], chains });
    expect(quiet.quiet).toBe(true);
    expect(baseline.baseline).toBe(true);
    expect(renderDigestText(quiet, HEADER)).toContain("flow 001");
    expect(renderDigestText(baseline, HEADER)).toContain("flow 001");
  });

  test("with none, the section says none", () => {
    expect(renderDigestText(build({ previous: snapshotOf({}), items: [] }), HEADER)).toMatch(/PR merged, flow closed, effect not checked\n- none/);
  });
});

describe("AC5: what could not be read is named too", () => {
  test("a failure goes in a section of its own, above the rest", () => {
    const content = build({ previous: snapshotOf({}), items: [], failures: [{ source: `ci:${REPO}`, detail: "gh_run_failed failed: HTTP 502" }] });
    const text = renderDigestText(content, HEADER);
    expect(text).toContain(`Could not read\n- ci:${REPO}: gh_run_failed failed: HTTP 502`);
    expect(text.indexOf("Could not read")).toBeLessThan(text.indexOf("Needs your decision"));
  });

  test("the sections come in a fixed order and the header names the digest and the time", () => {
    const text = renderDigestText(build({ previous: snapshotOf({}), items: [pr(1, { stamp: "2026-10-02T11:00:00Z" })] }), HEADER);
    expect(text.startsWith("Digest morning — 2026-10-02 12:00 UTC")).toBe(true);
    const at = ["What changed", "Needs your decision", "Stuck", "PR merged, flow closed, effect not checked"].map((s) => text.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});

describe("AC5: the chains are the product index's, end to end", () => {
  let env: DigestTestEnv;
  beforeEach(async () => {
    env = await setupDigestEnv();
  });
  afterEach(async () => {
    await env.teardown();
  });

  test("a whole run names the three closed, unchecked flows of the board, and not the observed one or the open ones", async () => {
    const name = await addDigestSchedule(env);
    const sink = new FakeSink();
    const gh = new FakeGh().set("pr", prJson([{ number: 12, updatedAt: "2026-10-01T09:00:00Z" }])).empty();
    await runDigest(env, name, { runGh: gh.run, summarize: fakeSummary().summarize, now: new TestClock("2026-10-02T12:00:00Z").now, sink });

    const text = sink.sent[0]?.text ?? "";
    expect(text).toContain('flow 001 "Retry checkout on a stale token"');
    expect(text).toContain('flow 003 "Rename the export button"');
    expect(text).toContain('flow 005 "Bump the lockfile"');
    expect(text).not.toContain('flow 002 "Cache the price list"');
    expect(text).not.toContain('flow 004 "Export the audit log"');
    expect(text).toContain("PR merged, flow closed 2026-01-16, effect not checked");
  });
});

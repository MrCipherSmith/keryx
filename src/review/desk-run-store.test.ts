import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeskRunStore, scheduledRunOutcomes } from "./desk-run-store";
import type { DeskFinish } from "./desk-run-types";

const key = {
  repo: "org/repo",
  repositoryId: "gid",
  viewer: "user",
  number: 12,
};
const other = { ...key, viewer: "colleague" };
const revision = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };
const next = { ...revision, headSha: "c".repeat(40) };
let directory: string;
let store: DeskRunStore;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "keryx-review-attempt-"));
  store = new DeskRunStore(directory);
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
function started(pid = process.pid) {
  store.request("/project", key, revision);
  const a = store.queued(key)!;
  a.pid = pid;
  a.run.state = "running";
  store.save(a);
  return a;
}
const finish: DeskFinish = {
  state: "completed",
  phase: "Complete",
  reason: "Package complete",
  result: {
    reviewed: revision,
    coverage: "complete",
    verdict: "REQUEST_CHANGES",
    report: "Blocking finding",
    findings: { blocker: 1, major: 0, minor: 0, info: 0 },
  },
};

test("another worktree sees the same active ID; a duplicate never removes a different waiting revision", () => {
  const active = started();
  const otherWindow = new DeskRunStore(directory);
  try {
    otherWindow.atomic(() => otherWindow.request("/worktree-b", key, next));
    otherWindow.atomic(() => otherWindow.request("/worktree-b", key, revision));
    expect(store.active(key)?.run.id).toBe(active.run.id);
    expect(store.queued(key)?.run.headSha).toBe(next.headSha);
    expect(store.history(key).runs).toHaveLength(2);
    otherWindow.atomic(() =>
      otherWindow.request("/worktree-b", key, {
        ...next,
        headSha: "d".repeat(40),
      }),
    );
    expect(store.history(key).runs.map((r) => r.state)).toEqual(["queued", "skipped", "running"]);
  } finally {
    otherWindow.close();
  }
});
test("account switch isolates private histories, queues and cancellation", () => {
  started();
  store.request("/a", key, next);
  store.request("/b", other, revision);
  const privateId = store.queued(key)!.run.id;
  expect(store.queued(other)?.run.id).not.toBe(privateId);
  expect(store.history(other).runs).toHaveLength(1);
  expect(() => store.cancel(other, privateId)).toThrow("access:");
  expect(store.history({ ...key, repositoryId: "other-gid" }).runs).toEqual([]);
});
test("cancellation and repeat retain history, and successful reuse compares both ends", () => {
  const a = started();
  store.cancel(key, a.run.id);
  expect(store.active(key)?.run.state).toBe("cancelling");
  store.end(a, { ...finish, state: "cancelled", result: null });
  store.request("/b", key, revision);
  const retry = store.queued(key)!;
  expect(retry.run.id).not.toBe(a.run.id);
  store.end(retry, finish);
  store.request("/b", key, revision);
  expect(store.history(key).runs).toHaveLength(2);
  store.request("/b", key, { ...revision, baseSha: "f".repeat(40) });
  expect(store.history(key).runs).toHaveLength(3);

});
test("dead worker reconciles durable result and protects surviving child before permitting retry", () => {
  const a = started(2_000_000_000);
  const dir = store.directory(a.run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "child.json"), JSON.stringify({ pid: process.pid }));
  store.reconcile(key, () => null);
  expect(store.active(key)?.run.id).toBe(a.run.id);
  rmSync(path.join(dir, "child.json"));
  store.reconcile(key, () => finish);
  expect(store.active(key)).toBeUndefined();
  expect(store.history(key).runs[0]?.result?.verdict).toBe("REQUEST_CHANGES");
});
test("interruption records a reason, while unstarted cancellation can never dispatch", () => {
  started(2_000_000_000);
  store.reconcile(key, () => null);
  expect(store.history(key).runs[0]?.state).toBe("failed");
  store.request("/project", key, next);
  store.cancel(key, store.queued(key)!.run.id);
  expect(store.queued(key)).toBeUndefined();
});

test("polling defers large reports while single-attempt details remain scoped and usable", () => {
  const attempt = started();
  const report = "review evidence\n".repeat(38000);
  store.end(attempt, { ...finish, result: { ...finish.result!, report } });
  expect(store.history(key).runs[0]?.result).toMatchObject({ report: "", reportDeferred: true });
  expect(store.history(key, attempt.run.id).runs[0]?.result?.report).toContain(
    "Preview truncated. Full result:",
  );
  expect(() => store.history(other, attempt.run.id)).toThrow("access:");
});

const scheduled = {
  project: "/project",
  ruleId: "rule1",
  ruleName: "Team review",
  attemptKey: "event1",
  event: "review_requested" as const,
  recipient: "org/team",
  requireGreen: true,
  author: "",
  assignee: "",
  budgetMinutes: 3,
  budgetTokens: 900,
};
test("scheduled and manual requests share an attempt and a spent range needs explicit manual retry", () => {
  const id = store.request("/project", key, revision, scheduled);
  expect(store.request("/other-worktree", key, revision)).toBe(id);
  const attempt = store.queued(key)!;
  expect(attempt.run).toMatchObject({ source: "scheduled", schedule: scheduled });
  store.end(attempt, { state: "budget", phase: "budget", reason: "limit", result: null });
  expect(store.request("/project", key, revision, { ...scheduled, attemptKey: "another-event" })).toBe(id);
  expect(store.request("/project", key, revision)).not.toBe(id);
});

test("a scheduled range never displaces pending manual work or queues without fresh authorization", () => {
  const active = started();
  expect(store.request("/project", key, revision, scheduled)).toBe(active.run.id);
  expect(store.request("/project", key, next, scheduled)).toBeNull();
  expect(store.queued(key)).toBeUndefined();
  const manual = store.request("/project", key, next);
  expect(store.request("/project", key, { ...next, headSha: "e".repeat(40) }, scheduled)).toBeNull();
  expect(store.queued(key)?.run.id).toBe(manual!);
});

test("automatic retries are capped even when every preflight proves it never spawned a model", () => {
  const ids: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    store.request("/project", key, revision, scheduled);
    const a = store.queued(key)!;
    expect(a.run.preflightAttempt).toBe(attempt);
    ids.push(a.run.id);
    expect(scheduledRunOutcomes([a.run.id], directory).retryable.size).toBe(0);
    store.end(a, {
      state: "blocked",
      phase: "Preflight",
      reason: "Waiting for CI",
      result: null,
      retryableBeforeSpend: true,
    });
    expect(!!store.byId(a.run.id)?.run.retryableBeforeSpend).toBe(attempt < 3);
  }
  store.request("/project", key, revision, scheduled);
  expect(store.queued(key)).toBeUndefined();
  expect(store.history(key).runs).toHaveLength(3);
  const outcomes = scheduledRunOutcomes(ids, directory);
  expect(outcomes.retryable).toEqual(new Set(ids.slice(0, 2)));
  expect(outcomes.terminal).toEqual(new Set(ids.slice(2)));
});

test("board reads compact progress for this account's active range", () => {
  const attempt = started();
  attempt.run.reviewerProgress = { planned: 4, finished: 2, wave: 1, sessions: [] };
  store.save(attempt);
  const board = (viewer: string, headSha: string): import("./board-types").ReviewBoardSnapshot => ({
    version: 1, repo: key.repo, repositories: [key.repo], repositoryId: key.repositoryId, viewer,
    fetchedAt: new Date().toISOString(), warnings: [],
    cards: [{ number: key.number, title: "Review me", url: "", state: "open", draft: false, author: "test",
      assignees: [], reviewers: [], decision: null, ci: "passed", headSha, baseSha: revision.baseSha, updatedAt: "" }],
  });
  const current = board(key.viewer, revision.headSha), changed = board(key.viewer, next.headSha), colleague = board(other.viewer, revision.headSha);
  for (const snapshot of [current, changed, colleague]) store.attachBadges(snapshot);
  expect(current.cards[0]?.localReview).toEqual({ active: true, ready: false, progress: { planned: 4, finished: 2, wave: 1 } });
  expect(changed.cards[0]?.localReview?.progress).toBeUndefined();
  expect(colleague.cards[0]?.localReview).toBeUndefined();
});

test("a multi-chunk scoped badge query agrees with history on ready, stale and queued revisions", async () => {
  const { localBadge } = await import("./board-badges");
  const attempt = started();
  store.end(attempt, finish);
  store.request("/fixture", key, next);
  const timeline = store.history(key).runs;
  const rows: import("./board-badges").BadgeCard[] = Array.from({length:202}, (_, i) => ({ number:i+100, ...revision }));
  rows.push({number:key.number, ...revision});
  store.attachBadges({ ...key, cards:rows });
  expect(rows.at(-1)?.localReview).toEqual(localBadge(timeline, revision));
  expect(rows.at(-1)?.localReview).toEqual({active:true,ready:true});
  expect(rows.slice(0,202).every(c => c.localReview === undefined)).toBe(true);
  const changed = [{number:key.number, ...next}] as import("./board-badges").BadgeCard[];
  store.attachBadges({ ...key, cards:changed });
  expect(changed[0]?.localReview).toEqual(localBadge(timeline, next));
  expect(changed[0]?.localReview).toEqual({active:true,ready:false});
});

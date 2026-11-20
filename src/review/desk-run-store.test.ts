import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readProcessIdentity } from "../lib/hub-machine/process-identity";
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
    expect(otherWindow.atomic(() => otherWindow.request("/worktree-b", key, revision))).toBe(active.run.id);
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
test("dead worker reconciles durable result and protects surviving child before permitting retry", async () => {
  const a = started(2_000_000_000);
  a.run.reviewerProgress = { planned: 3, finished: 1, wave: 2, sessions: [
    { id: "first", reviewer: "review-style", wave: 1, state: "completed" },
    { id: "active", reviewer: "review-logic", wave: 2, state: "running" },
    { id: "later", reviewer: "review-logic", wave: 3, state: "planned" },
  ] };
  store.save(a);
  const dir = store.directory(a.run.id);
  mkdirSync(path.join(dir, "checkout", ".git"), { recursive: true });
  mkdirSync(path.join(dir, "package"));
  writeFileSync(path.join(dir, "package", "report.md"), "Archived review");
  writeFileSync(path.join(dir, "execution-result.json"), "{}");
  writeFileSync(path.join(dir, "child.json"), JSON.stringify({ pid: process.pid }));
  await store.reconcile(key, () => null);
  expect(store.active(key)?.run.id).toBe(a.run.id);
  expect(existsSync(path.join(dir, "checkout", ".git"))).toBe(true);
  writeFileSync(path.join(dir, "child.json"), JSON.stringify({ pid: 2_000_000_000 }));
  await store.reconcile(key, () => finish);
  expect(store.active(key)).toBeUndefined();
  expect(existsSync(path.join(dir, "checkout"))).toBe(false);
  expect(existsSync(path.join(dir, "child.json"))).toBe(false);
  expect(existsSync(path.join(dir, "package", "report.md"))).toBe(true);
  expect(existsSync(path.join(dir, "execution-result.json"))).toBe(true);
  expect(store.history(key).runs[0]?.result?.verdict).toBe("REQUEST_CHANGES");
  expect(store.history(key).runs[0]?.reviewerProgress).toMatchObject({ finished: 1, wave: 1, sessions: [
    { state: "completed" }, { state: "unknown" }, { state: "unknown" },
  ] });
});

test("orphan settlement preserves an unarchived review package after the last checkpoint", async () => {
  const startedRun = started(2_000_000_000);
  const checkout = path.join(store.directory(startedRun.run.id), "checkout");
  const packagePath = path.join(checkout, ".metaproject", "reviews", "after-checkpoint");
  mkdirSync(packagePath, { recursive: true });
  const raw = path.join(packagePath, "report.md");
  writeFileSync(raw, "Observed reviewer evidence");
  let recoveryRead = false;
  await store.reconcile(other, () => { recoveryRead = true; return null; });
  expect(recoveryRead).toBe(false);
  expect(store.byId(startedRun.run.id)?.run.state).toBe("running");
  await store.reconcile(key, () => null);
  expect(store.active(key)).toBeUndefined();
  expect(store.byId(startedRun.run.id)?.run.state).toBe("failed");
  expect(existsSync(raw)).toBe(true);
});

test.each(["queued", "already finished"] as const)(
  "a stale validation cannot replace a newer admission when it is %s",
  async state => {
    const active = started();
    const late = { ...next, headSha: "d".repeat(40) };
    const release = Promise.withResolvers<void>();
    const secondWindow = new DeskRunStore(directory);
    try {
      const beforeValidation = store.latestAdmission(key);
      const firstWindow = release.promise.then(() =>
        store.atomic(() => store.requestManual("/first-window", key, next, beforeValidation)));
      const latest = secondWindow.atomic(() =>
        secondWindow.requestManual("/other-worktree", key, late, secondWindow.latestAdmission(key)));
      expect(latest).toBeString();
      const queued = secondWindow.queued(key)!;
      if (state === "already finished") {
        secondWindow.atomic(() => {
          secondWindow.end(active, finish);
          secondWindow.end(queued, finish);
        });
      }
      release.resolve();
      await expect(firstWindow).rejects.toThrow("Another review was requested during validation");
      expect(store.latestAdmission(key)).toBe(latest);
      expect(store.byId(queued.run.id)?.run.state).toBe(state === "queued" ? "queued" : "completed");
      if (state === "queued") {
        expect(store.atomic(() => store.requestManual("/first-window", key, late, beforeValidation))).toBe(latest);
      }
    } finally { secondWindow.close(); }
  },
);

test.skipIf(process.platform === "win32")("a different process instance cannot hold a dead worker or child slot", async () => {
  const unrelated = Bun.spawn(["/bin/sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    const live = readProcessIdentity(unrelated.pid)!;
    const old = { ...live, pgid: unrelated.pid, startedAt: live.startedAt + ":previous-instance" };
    const id = store.request("/project", key, revision, scheduled)!;
    const a = store.byId(id)!;
    a.run.state = "running";
    a.pid = unrelated.pid;
    a.workerIdentity = live;
    store.save(a);
    const link = { runId: id, project: "/project" };
    expect(store.scheduledOwnerExited(key, link)).toBe(false);
    await store.reconcile(key, () => finish, link);
    expect(store.active(key)?.run.id).toBe(id);
    expect(store.history(key).runs[0]).not.toHaveProperty("workerIdentity");

    a.workerIdentity = old;
    store.save(a);
    const dir = store.directory(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "child.json"), JSON.stringify({ pid: unrelated.pid, identity: old }));
    expect(store.scheduledOwnerExited(key, link)).toBe(true);
    await store.reconcile(key, () => finish, link);
    expect(store.byId(id)?.run.state).toBe("completed");
    expect(readProcessIdentity(unrelated.pid)).toEqual(live);
  } finally { unrelated.kill(); await unrelated.exited; }
});

test("a late reconciler preserves a successor that started while its predecessor was being evaluated", async () => {
  const old = started(2_000_000_000);
  const delayed = Promise.withResolvers<DeskFinish>();
  const slow = store.reconcile(key, () => delayed.promise);
  await store.reconcile(key, () => finish);
  store.request("/project", key, next);
  const successor = store.queued(key)!;
  successor.pid = process.pid;
  successor.run.state = "running";
  store.save(successor);
  delayed.resolve({ ...finish, state: "failed" });
  await slow;
  expect(store.active(key)?.run.id).toBe(successor.run.id);
  expect(store.byId(old.run.id)?.run.state).toBe("completed");
});

test("previously persisted terminal checkpoints display no live reviewer sessions", () => {
  const attempt = started();
  attempt.run.state = "failed";
  attempt.run.reviewerProgress = { planned: 1, finished: 0, wave: 1, sessions: [
    { id: "old", reviewer: "review-logic", state: "failed", wave: 1 },
    { id: "retry", reviewer: "review-logic", state: "running", wave: 1 },
  ] };
  store.save(attempt);
  expect(store.history(key).runs[0]?.reviewerProgress).toMatchObject({
    finished: 0, wave: null, sessions: [{ state: "failed" }, { state: "unknown" }],
  });
});

test("interruption records a reason, while unstarted cancellation can never dispatch", async () => {
  started(2_000_000_000);
  await store.reconcile(key, () => null);
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
test("scheduled workers share four local slots and reuse an existing attempt at capacity", () => {
  const keys = Array.from({ length: 6 }, (_, index) => ({ ...key, number: 100 + index }));
  const ids = keys.slice(0, 4).map((target, index) =>
    store.atomic(() => store.request("/project", target, revision, { ...scheduled, attemptKey: `event-${index}` })));
  expect(new Set(ids).size).toBe(4);
  expect(store.atomic(() => store.request("/project", keys[0]!, revision, scheduled))).toBe(ids[0]!);
  const manualId = store.request("/project", keys[5]!, revision)!;
  store.end(store.byId(manualId)!, finish);
  expect(store.atomic(() => store.requestAttempt("/project", keys[5]!, revision, scheduled))).toEqual({
    id: manualId,
    reused: true,
  });
  expect(() => store.atomic(() => store.request("/project", keys[4]!, revision, scheduled))).toThrow("watcher will try again");
  const first = store.byId(ids[0]!)!;
  store.atomic(() => store.end(first, { state: "cancelled", phase: "stop", reason: "fixture", result: null }));
  expect(store.atomic(() => store.request("/project", keys[4]!, revision, scheduled))).not.toBeNull();
});

test("dead scheduled owners do not reserve capacity even before their history is reconciled", () => {
  for (let index = 0; index < 4; index++) {
    const target = { ...key, number: 50 + index };
    const id = store.request("/project", target, revision, scheduled)!;
    const attempt = store.byId(id)!;
    attempt.run.state = "running";
    attempt.pid = index === 0 ? 2_000_000_000 : process.pid;
    store.save(attempt);
  }
  expect(store.atomic(() => store.request("/project", key, revision, scheduled))).not.toBeNull();
});

test("manual admission reuses the exact latest completed revision when validation overlapped", () => {
  const observed = store.latestAdmission(key);
  const id = store.request("/project", key, revision)!;
  store.end(store.byId(id)!, finish);
  expect(store.atomic(() => store.requestManual("/project", key, revision, observed))).toBe(id);
  expect(() => store.atomic(() => store.requestManual("/project", key, next, observed))).toThrow("stale:");
});

test("scheduled and manual requests share an attempt and a spent range needs explicit manual retry", () => {
  const id = store.request("/project", key, revision, scheduled);
  expect(store.request("/other-worktree", key, revision)).toBe(id);
  const attempt = store.queued(key)!;
  expect(attempt.run).toMatchObject({ source: "scheduled", schedule: scheduled });
  store.end(attempt, { state: "budget", phase: "budget", reason: "limit", result: null });
  expect(store.request("/project", key, revision, { ...scheduled, attemptKey: "another-event" })).toBe(id);
  expect(store.request("/project", key, revision)).not.toBe(id);
});

test("a previously superseded revision with no spend can be scheduled if it returns", () => {
  const active = started();
  const displaced = store.request("/project", key, next)!;
  const latest = store.request("/project", key, { ...next, headSha: "e".repeat(40) })!;
  expect(store.byId(displaced)?.run).toMatchObject({ state: "skipped", phase: "Superseded", startedAt: null });
  store.end(active, { state: "completed", phase: "Complete", reason: "test", result: finish.result });
  store.cancel(key, latest);
  const later = store.requestAttempt("/project", key, next, scheduled);
  expect(later).toMatchObject({ reused: false });
  expect(later?.id).not.toBe(displaced);
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

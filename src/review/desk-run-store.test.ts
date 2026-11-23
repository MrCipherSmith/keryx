import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readProcessIdentity } from "../lib/hub-machine/process-identity";
import { deskOptionsKey, type DeskReviewOptions } from "./desk-run-options";
import { DeskRunStore, scheduledRunOutcomes } from "./desk-run-store";
import type { DeskFinish } from "./desk-run-types";
import { applyDeskLifecycle } from "./desk-run-lifecycle";

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

test("continuing a stopped review preserves its history and keeps private guidance on the new attempt", () => {
  const old = started();
  store.end(old, { ...finish, state: "partial", result: null });
  expect(() => store.continuationSource(other, old.run.id)).toThrow("access:");
  const nextId = store.atomic(() => store.requestContinuation("/project", key, old.run.id, "Review related PR #21"))!;
  expect(nextId).not.toBe(old.run.id);
  expect(store.byId(old.run.id)?.run.state).toBe("partial");
  expect(store.byId(nextId)?.run).toMatchObject({
    ...revision, source: "manual", state: "queued",
    continuation: { previousId: old.run.id, guidance: "Review related PR #21" },
  });
  expect(store.history(key, nextId).runs[0]?.continuation).toEqual({ previousId: old.run.id });
  expect(() => store.requestContinuation("/project", key, old.run.id)).toThrow("stale:");
});

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

test("another viewer reclaims the dead shared slot while only its original viewer can recover the result", async () => {
  const previous = started(2_000_000_000);
  const evidence = path.join(store.directory(previous.run.id), "checkout", ".metaproject", "reviews", "unarchived");
  mkdirSync(evidence, { recursive: true });
  const successor = store.atomic(() => store.request("/project", other, revision))!;
  expect(successor).not.toBe(previous.run.id);
  expect(store.active(key)).toBeUndefined();
  expect(store.history(other).runs.map(run => run.id)).toEqual([successor]);
  const newAttempt = store.byId(successor)!;
  newAttempt.pid = process.pid;
  newAttempt.run.state = "running";
  store.save(newAttempt);
  let reads = 0;
  await store.reconcile(other, () => { reads++; return finish; });
  expect(reads).toBe(0);
  await store.reconcile(key, () => { reads++; return finish; });
  expect(reads).toBe(1);
  expect(store.history(key).runs[0]?.result?.verdict).toBe("REQUEST_CHANGES");
  expect(store.active(other)?.run.id).toBe(successor);
  expect(existsSync(evidence)).toBe(true);
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
  expect(current.cards[0]?.localReview).toEqual({ active: true, ready: false, runState: "running", progress: { planned: 4, finished: 2, wave: 1 } });
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
  expect(rows.at(-1)?.localReview).toEqual({active:true,ready:true,runState:"other-revision"});
  expect(rows.slice(0,202).every(c => c.localReview === undefined)).toBe(true);
  const changed = [{number:key.number, ...next}] as import("./board-badges").BadgeCard[];
  store.attachBadges({ ...key, cards:changed });
  expect(changed[0]?.localReview).toEqual(localBadge(timeline, next));
  expect(changed[0]?.localReview).toEqual({active:true,ready:false,runState:"queued"});
});

test("terminal board progress uses the latest matching attempt and restores legacy successful assignments without counting retries twice", async () => {
  const { localBadge } = await import("./board-badges");
  const a = started();
  a.run.reviewerProgress = { planned: 3, wave: 2, finished: 2, sessions: [
    { id: "old", reviewer: "review-logic", wave: 1, state: "failed" },
    { id: "retried", reviewer: "review-logic", wave: 1, state: "completed" },
    { id: "stopped", reviewer: "review-logic", wave: 2, state: "cancelled" },
    { id: "later", reviewer: "review-logic", wave: 3, state: "planned" },
  ] };
  store.end(a, { state: "partial", phase: "Stopped", reason: "", result: null });
  const badge = () => {
    const cards: import("./board-badges").BadgeCard[] = [{ number: key.number, ...revision }];
    store.attachBadges({ ...key, cards });
    expect(cards[0]!.localReview).toEqual(localBadge(store.history(key).runs, revision));
    return cards[0]!.localReview;
  };
  expect(badge()).toMatchObject({ runState: "partial", progress: { planned: 3, completed: 1, finished: 2 } });
  const retry = started();
  store.end(retry, finish);
  expect(badge()).toMatchObject({ active: false, ready: true, runState: "completed" });
});

test("a finished review of an earlier head reaches the board as outdated until a run covers the new head", async () => {
  const { localBadge } = await import("./board-badges");
  const badge = (range = next) => {
    const cards: import("./board-badges").BadgeCard[] = [{ number: key.number, ...range }];
    store.attachBadges({ ...key, cards });
    expect(cards[0]?.localReview).toEqual(localBadge(store.history(key).runs, range));
    return cards[0]?.localReview;
  };
  const finishAt = (range: typeof revision, state: DeskFinish["state"]) => {
    store.request("/project", key, range);
    const a = store.queued(key)!;
    store.end(a, { ...finish, state, result: { ...finish.result!, reviewed: range } });
    return a;
  };
  finishAt({ ...revision, headSha: "d".repeat(40) }, "partial");
  finishAt(revision, "completed");
  const archived = finishAt({ ...revision, headSha: "e".repeat(40) }, "budget");
  archived.run.decision = { action: "archive", reason: "", at: "" };
  store.save(archived);
  expect(badge()).toEqual({ active: false, ready: false, outdated: { headSha: revision.headSha, state: "completed" } });
  expect(badge(revision)).toMatchObject({ active: false, ready: true, runState: "completed" });
  expect(badge(revision)?.outdated).toBeUndefined();
  // Another account's history stays out.
  const colleague: import("./board-badges").BadgeCard[] = [{ number: key.number, ...next }];
  store.attachBadges({ ...other, cards: colleague });
  expect(colleague[0]?.localReview).toBeUndefined();
  // An active run on the new head takes precedence; once it fails, the current-range run still wins.
  store.request("/project", key, next);
  expect(badge()).toEqual({ active: true, ready: false, runState: "queued" });
  const current = store.queued(key)!;
  store.end(current, { ...finish, state: "failed", result: null });
  expect(badge()).toEqual({ active: false, ready: false, runState: "failed" });
});

test("the outdated lookup ignores newer finished runs of another PR, another viewer, hidden runs and runs without a result", async () => {
  const { localBadge } = await import("./board-badges");
  const finishFor = (k: typeof key, head: string, state: DeskFinish["state"] = "completed", recorded = true) => {
    const range = { ...revision, headSha: head.repeat(40) };
    store.request("/project", k, range);
    const a = store.queued(k)!;
    store.end(a, { ...finish, state, result: recorded ? { ...finish.result!, reviewed: range } : null });
    return a;
  };
  const wanted = finishFor(key, "b");
  // Each of these is newer than the wanted run and would win the lookup if its own predicate were dropped.
  finishFor({ ...key, number: key.number + 1 }, "d");
  finishFor(other, "e");
  const deleted = finishFor(key, "f");
  deleted.run.decision = { action: "delete", reason: "", at: "" };
  store.save(deleted);
  const imported = finishFor(key, "1");
  imported.run.source = "existing";
  store.save(imported);
  finishFor(key, "2", "completed", false);
  const cards: import("./board-badges").BadgeCard[] = [{ number: key.number, ...next }];
  store.attachBadges({ ...key, cards });
  expect(cards[0]?.localReview).toEqual({ active: false, ready: false, outdated: { headSha: "b".repeat(40), state: "completed" } });
  expect(cards[0]?.localReview).toEqual(localBadge(store.history(key).runs, next));
  expect(store.byId(wanted.run.id)?.run.state).toBe("completed");
});

test("each term of the outdated lookup is pinned by its own fixture", async () => {
  const { localBadge } = await import("./board-badges");
  const run = (k: typeof key, requested: typeof revision, state: DeskFinish["state"], reviewed: typeof revision | null) => {
    store.request("/project", k, requested);
    store.end(store.queued(k)!, { ...finish, state, result: reviewed ? { ...finish.result!, reviewed } : null });
  };
  const badge = (k: typeof key, range: typeof revision) => {
    const cards: import("./board-badges").BadgeCard[] = [{ number: k.number, ...range }];
    store.attachBadges({ ...k, cards });
    expect(cards[0]?.localReview).toEqual(localBadge(store.history(k).runs, range));
    return cards[0]?.localReview;
  };
  const d = { ...revision, headSha: "d".repeat(40) };
  // `requested`: a failed or cancelled run on the card's range wins over an older finished run of another range.
  run(key, revision, "completed", revision);
  run(key, next, "failed", null);
  expect(badge(key, next)).toEqual({ active: false, ready: false, runState: "failed" });
  run(key, next, "cancelled", null);
  expect(badge(key, next)).toEqual({ active: false, ready: false, runState: "cancelled" });
  // Finished-state filter: a newer failed run with a recorded result is not the outdated candidate.
  const filtered = { ...key, number: key.number + 1 };
  run(filtered, revision, "completed", revision);
  run(filtered, d, "failed", d);
  expect(badge(filtered, next)).toEqual({ active: false, ready: false, outdated: { headSha: revision.headSha, state: "completed" } });
  // `reviewed` without `requested`: requested on one range, reviewed the card's range; a newer finished run of a third range must not displace it.
  const reviewed = { ...key, number: key.number + 2 };
  run(reviewed, revision, "completed", next);
  run(reviewed, d, "completed", d);
  expect(badge(reviewed, next)).toEqual({ active: false, ready: true });
  // Repository predicate: a newer finished run of the same number and viewer in another repository does not win.
  const sameNumber = { ...key, number: key.number + 3 }, elsewhere = { ...sameNumber, repositoryId: "other-gid" };
  run(sameNumber, revision, "completed", revision);
  run(elsewhere, d, "completed", d);
  expect(badge(sameNumber, next)).toEqual({ active: false, ready: false, outdated: { headSha: revision.headSha, state: "completed" } });
});

test("in one batch, an active run or a reviewed range suppresses the outdated badge only for its own card", async () => {
  const { localBadge } = await import("./board-badges");
  const ranOn = (k: typeof key, range: typeof revision) => {
    store.request("/project", k, range);
    store.end(store.queued(k)!, { ...finish, result: { ...finish.result!, reviewed: range } });
  };
  const busy = { ...key, number: key.number + 1 }, done = { ...key, number: key.number + 2 };
  for (const k of [key, busy, done]) ranOn(k, revision);
  store.request("/project", busy, next);
  ranOn(done, next);
  const cards: import("./board-badges").BadgeCard[] = [key, busy, done].map(({ number }) => ({ number, ...next }));
  store.attachBadges({ ...key, cards });
  expect(cards.map(card => card.localReview)).toEqual([
    { active: false, ready: false, outdated: { headSha: revision.headSha, state: "completed" } },
    { active: true, ready: false, runState: "queued" },
    { active: false, ready: true, runState: "completed", publicationPending: true },
  ]);
  for (const [i, k] of [key, busy, done].entries()) expect(cards[i]?.localReview).toEqual(localBadge(store.history(k).runs, next));
});

test("a new queued revision shows its own starting state while an earlier revision is still running", () => {
  started();
  store.request("/fixture", key, next);
  const cards: import("./board-badges").BadgeCard[] = [{ number: key.number, ...next }];
  store.attachBadges({ ...key, cards });
  expect(cards[0]?.localReview).toMatchObject({ active: true, runState: "queued" });
});

test("question and activity badges follow the account, pinned range, answer and cancellation", () => {
  const { run } = started();
  const badge = (viewer = key.viewer, range = revision) => {
    const cards: import("./board-badges").BadgeCard[] = [{ number: key.number, ...range }];
    store.attachBadges({ ...key, viewer, cards });
    return cards[0]?.localReview;
  };
  expect(badge()?.lastActivityAt).toBeUndefined();
  const logDir = path.join(store.directory(run.id), "run");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(path.join(logDir, "events.ndjson"), "{}\n");
  const at = store.history(key).runs[0]?.lastActivityAt;
  expect(at).toBeString();
  const ask = { id: "q", question: "Which scope?", options: [], allowFreeform: true };
  store.openQuestion(run.id, ask);
  expect(badge()).toMatchObject({ awaitingAnswer: true, lastActivityAt: at });
  expect(JSON.stringify(badge())).not.toContain(ask.question);
  expect(badge(key.viewer, next)).toEqual({ active: true, ready: false, runState: "other-revision" });
  expect(badge(other.viewer)).toBeUndefined();
  store.answerQuestion(key, run.id, ask.id, "Diff");
  expect(badge()?.awaitingAnswer).toBeUndefined();
  store.openQuestion(run.id, { ...ask, id: "q2" });
  store.cancel(key, run.id);
  expect(badge()).toEqual({ active: true, ready: false, runState: "cancelling" });
});

test("a legacy read-only store without review_questions still provides board progress", async () => {
  const { Database } = await import("bun:sqlite");
  started();
  const db = new Database(path.join(directory, "runs.sqlite"));
  db.run("DROP TABLE review_questions");
  db.close();
  const old = new DeskRunStore(directory, true);
  try {
    const cards: import("./board-badges").BadgeCard[] = [{ number: key.number, ...revision }];
    old.attachBadges({ ...key, cards });
    expect(cards[0]?.localReview).toEqual({ active: true, ready: false, runState: "running" });
  } finally { old.close(); }
});

test("concurrent reviewer questions retain separate replies and interoperate with a running pre-upgrade coordinator", async () => {
  const { Database } = await import("bun:sqlite");
  const { run } = started();
  const legacy = new Database(path.join(directory, "runs.sqlite"));
  // Emulate the coordinator connection already open when a new Desktop upgrades the DB.
  legacy.exec("DROP TRIGGER clear_stopped_reviewer_questions; DROP TABLE reviewer_questions");
  const coordinator = { id: "c", question: "Choose review scope", options: [], allowFreeform: true };
  legacy.run("INSERT INTO review_questions (run_id,question_id,question) VALUES (?,?,?)", [run.id, coordinator.id, JSON.stringify(coordinator)]);
  const updated = new DeskRunStore(directory);
  try {
    const alpha = { ...coordinator, id: "a", reviewerSessionId: "first", reviewer: "review-alpha", wave: 2 };
    const beta = { ...coordinator, id: "b", reviewerSessionId: "second", reviewer: "review-beta", wave: 2 };
    updated.openQuestion(run.id, alpha);
    updated.openQuestion(run.id, beta);
    expect(updated.pendingQuestions(run.id)).toEqual([coordinator, alpha, beta]);
    expect(updated.pendingQuestion(run.id)).toEqual(coordinator);
    expect(() => updated.openQuestion(run.id, { ...beta, id: alpha.id })).toThrow("stale");
    expect(() => updated.answerQuestion(other, run.id, beta.id, "leak")).toThrow("stale");
    updated.answerQuestion(key, run.id, beta.id, "beta reply");
    expect(updated.questionAnswer(run.id, beta.id)).toBe("beta reply");
    expect(updated.questionAnswer(run.id, alpha.id)).toBeNull();
    expect(() => updated.answerQuestion(key, run.id, beta.id, "changed")).toThrow("stale");
    updated.clearQuestion(run.id, beta.id);
    expect(updated.pendingQuestions(run.id)).toEqual([coordinator, alpha]);
    updated.answerQuestion(key, run.id, coordinator.id, "diff");
    expect(legacy.query("SELECT answer FROM review_questions WHERE run_id=? AND question_id=?").get(run.id, coordinator.id)).toEqual({answer:"diff"});
    legacy.run("DELETE FROM review_questions WHERE run_id=?", [run.id]);
    expect(updated.pendingQuestion(run.id)).toEqual(alpha);
    const cards: import("./board-badges").BadgeCard[] = [{ number: key.number, ...revision }];
    updated.attachBadges({ ...key, cards });
    expect(cards[0]?.localReview?.awaitingAnswer).toBe(true);
    expect(updated.hasPendingQuestion(run.id)).toBe(true);
    // The old worker can stop without knowing about the new table.
    legacy.run("UPDATE runs SET state='cancelled' WHERE id=?", [run.id]);
    expect(updated.pendingQuestions(run.id)).toEqual([]);
    expect(updated.questionAnswer(run.id, alpha.id)).toBeUndefined();
    expect(legacy.query("SELECT 1 FROM reviewer_questions WHERE run_id=?").get(run.id)).toBeNull();
    expect(() => updated.answerQuestion(key, run.id, alpha.id, "late")).toThrow("stale");
  } finally {
    updated.close();
    legacy.close();
  }
});

test("a coordinator context request does not replace a pending decision", () => {
  const { run } = started();
  const decision = { id: "decision", question: "Approve the expanded plan?", options: [], allowFreeform: true };
  const context = { ...decision, id: "context", question: "Which backend revision?", reviewContext: true as const };
  store.openQuestion(run.id, decision);
  store.openQuestion(run.id, context);
  expect(store.pendingQuestions(run.id)).toEqual([decision, context]);
  store.answerQuestion(key, run.id, context.id, "012ab34");
  expect(store.questionAnswer(run.id, context.id)).toBe("012ab34");
  expect(store.pendingQuestions(run.id)).toEqual([decision]);
});

test("aborting a reviewer waiting for its operator leaves the other live session intact", async () => {
  const { ASK_USER_CANCEL } = await import("../harness/tool/builtin/ask-user-tool");
  const { askDesktopOperator } = await import("./desk-questions");
  const { run } = started();
  const controller = new AbortController();
  const question = { question: "Which files?", allowFreeform: true, options: [] };
  const response = askDesktopOperator(run.id, question, { reviewerSessionId: "session-a", reviewer: "review-alpha", wave: 1 },
    controller.signal, new DeskRunStore(directory));
  const otherResponse = askDesktopOperator(run.id, question, { reviewerSessionId: "session-b", reviewer: "review-beta", wave: 2 },
    undefined, new DeskRunStore(directory));
  try {
    const [first, second] = store.pendingQuestions(run.id);
    expect(first?.reviewerSessionId).toBe("session-a");
    expect(second?.reviewerSessionId).toBe("session-b");
    controller.abort();
    expect(await response).toBe(ASK_USER_CANCEL);
    expect(store.pendingQuestions(run.id)).toEqual([second!]);
    store.answerQuestion(key, run.id, second!.id, "Only the diff");
    expect(await otherResponse).toEqual({ kind: "own", text: "Only the diff" });
    expect(store.hasPendingQuestion(run.id)).toBe(false);
  } finally {
    controller.abort();
    store.cancel(key, run.id);
    await Promise.allSettled([response, otherResponse]);
  }
});

test("same revision reuses only the matching settings before and after completion", () => {
  const manual = { modelPools: { strong: [], middle: [], light: [] }, adaptive: true, mode: "manual" } as const;
  const options = { ...manual, modelPools: { strong: [], middle: [], light: [] } };
  const first = store.requestManual("/a", key, revision, null, options);
  expect(first).toBeString();
  expect(store.requestManual("/b", key, revision, null, options)).toBe(first);
  store.end(store.queued(key)!, finish);
  expect(store.requestManual("/b", key, revision, store.latestAdmission(key), options)).toBe(first);
  const different = { ...options, maxWaves: 1 };
  const second = store.requestManual("/a", key, revision, store.latestAdmission(key), different);
  expect(second).not.toBe(first);
  expect(store.requestManual("/a", key, revision, store.latestAdmission(key), options)).toBe(first);
  expect(store.queued(key)?.run.id).toBe(second!);
  expect(store.queued(key)?.run.options).toEqual(different);
  expect(store.request("/a", key, revision, scheduled)).toBe(second);
  store.end(store.queued(key)!, finish);
  expect(store.request("/a", key, revision, scheduled)).toBe(second);
});

test("manual review identity includes resolved default model pools", () => {
  const options: DeskReviewOptions = { mode: "manual", adaptive: true, modelPools: { strong: [], middle: [], light: [] } };
  const effective = (model: string) => deskOptionsKey({
    ...options, modelPools: { ...options.modelPools, strong: [{ provider: "openai", model }] },
  });
  const firstKey = effective("first-model");
  const secondKey = effective("second-model");
  const first = store.requestManual("/project", key, revision, null, options, firstKey);
  expect(store.requestManual("/project", key, revision, null, options, firstKey)).toBe(first);
  expect(() => store.requestManual("/project", key, revision, null, options, secondKey)).toThrow("stale:");
  store.end(store.queued(key)!, finish);
  expect(store.requestManual("/project", key, revision, store.latestAdmission(key), options, firstKey)).toBe(first);
  const second = store.requestManual("/project", key, revision, store.latestAdmission(key), options, secondKey);
  expect(second).not.toBe(first);
  expect(store.queued(key)?.run.effectiveOptionsKey).toBe(secondKey);
});

test("operator decisions preserve partial evidence until explicit deletion", async () => {
  const attempt = started();
  const id = attempt.run.id;
  const decide = (action: "close" | "archive" | "restore" | "delete", subject = key) =>
    applyDeskLifecycle(store, "/project", subject, { action: "decide", id, decision: action, reason: "Operator recorded an outcome" }, undefined);
  await expect(decide("delete")).rejects.toThrow("Stop the running review");
  store.end(attempt, { ...finish, state: "partial", result: { ...finish.result!, coverage: "partial" } });
  mkdirSync(store.directory(id), { recursive: true });
  const artifact = path.join(store.directory(id), "report.md");
  writeFileSync(artifact, "Review evidence");
  await expect(decide("delete", other)).rejects.toThrow("unavailable");
  await decide("close");
  expect(store.history(key).runs[0]?.closure).toBe("closed");
  expect(store.history(key).runs[0]?.result?.coverage).toBe("partial");
  await decide("archive");
  expect(store.history(key).runs[0]?.decision?.action).toBe("archive");
  expect(existsSync(artifact)).toBe(true);
  await decide("restore");
  expect(store.history(key).runs[0]?.closure).toBe("closed");
  await decide("delete");
  expect(store.history(key).runs).toEqual([]);
  expect(store.byId(id)?.run.decision?.action).toBe("delete");
  expect(existsSync(artifact)).toBe(false);
});

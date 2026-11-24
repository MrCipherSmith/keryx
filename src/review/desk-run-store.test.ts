import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readProcessIdentity } from "../lib/hub-machine/process-identity";
import { deskOptionsKey, type DeskReviewOptions } from "./desk-run-options";
import { PUBLICATION_RECEIPT, PUBLICATION_SKIPPED } from "./desk-publication-types";
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
test("reopening a PR keeps its original conversation and respects project and viewer boundaries", () => {
  const sessionId = "7e3d06ec-76b0-4a08-8110-188a51944032";
  const id = store.atomic(() => store.requestManual("/project", key, revision, null, undefined, undefined, sessionId));
  const retry = store.atomic(() => store.requestManual("/project", key, revision, id, undefined, undefined, "another-session"));
  expect(retry).toBe(id);
  expect(store.sessionAttempts("/project", sessionId, key.viewer.toUpperCase()).map(({ run }) => run.id)).toEqual([id!]);
  expect(store.sessionAttempts("/other", sessionId, key.viewer)).toEqual([]);
  expect(store.sessionAttempts("/project", sessionId, other.viewer)).toEqual([]);
  expect(store.sessionAttempts("/project", "another-session", key.viewer)).toEqual([]);
  const snapshot = { repositoryId: key.repositoryId, viewer: key.viewer, cards: [{ number: key.number, ...revision }] };
  store.attachBadges(snapshot);
  expect(snapshot.cards[0]).toMatchObject({ localReview: { runId: id, sessionId } });
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
  expect(badge()).toEqual({ active: false, ready: false, outdated: { headSha: revision.headSha, state: "completed", round: 2 } });
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
  expect(cards[0]?.localReview).toEqual({ active: false, ready: false, outdated: { headSha: "b".repeat(40), state: "completed", round: 1 } });
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
  expect(badge(filtered, next)).toEqual({ active: false, ready: false, outdated: { headSha: revision.headSha, state: "completed", round: 1 } });
  // `reviewed` without `requested`: requested on one range, reviewed the card's range; a newer finished run of a third range must not displace it.
  const reviewed = { ...key, number: key.number + 2 };
  run(reviewed, revision, "completed", next);
  run(reviewed, d, "completed", d);
  expect(badge(reviewed, next)).toEqual({ active: false, ready: true });
  // Repository predicate: a newer finished run of the same number and viewer in another repository does not win.
  const sameNumber = { ...key, number: key.number + 3 }, elsewhere = { ...sameNumber, repositoryId: "other-gid" };
  run(sameNumber, revision, "completed", revision);
  run(elsewhere, d, "completed", d);
  expect(badge(sameNumber, next)).toEqual({ active: false, ready: false, outdated: { headSha: revision.headSha, state: "completed", round: 1 } });
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
    { active: false, ready: false, outdated: { headSha: revision.headSha, state: "completed", round: 1 } },
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

// main's runs.sqlite schema before Reviews (a5d1ab236), copied verbatim with its constants expanded.
const MAIN_DDL = `CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, repo TEXT NOT NULL, pr INTEGER NOT NULL, viewer TEXT COLLATE NOCASE NOT NULL,
      state TEXT NOT NULL, pid INTEGER, cwd TEXT NOT NULL, request TEXT NOT NULL, details TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_questions (
      run_id TEXT PRIMARY KEY, question_id TEXT NOT NULL, question TEXT NOT NULL, answer TEXT
    );
    CREATE TABLE IF NOT EXISTS reviewer_questions (
      run_id TEXT NOT NULL, question_id TEXT NOT NULL, question TEXT NOT NULL, answer TEXT,
      PRIMARY KEY(run_id, question_id)
    );
    CREATE TRIGGER IF NOT EXISTS clear_stopped_reviewer_questions AFTER UPDATE OF state ON runs
      WHEN OLD.state='running' AND NEW.state!='running' BEGIN
        DELETE FROM reviewer_questions WHERE run_id=NEW.id;
      END;
    CREATE TABLE IF NOT EXISTS history_scans (
      cwd TEXT NOT NULL, repo TEXT NOT NULL, pr INTEGER NOT NULL, viewer TEXT COLLATE NOCASE NOT NULL,
      scanned INTEGER NOT NULL, PRIMARY KEY(cwd,repo,pr,viewer)
    );
    CREATE INDEX IF NOT EXISTS review_history ON runs(repo, viewer, pr);
    CREATE INDEX IF NOT EXISTS active_scheduled ON runs(id) WHERE state IN ('queued','running','cancelling') AND json_extract(details,'$.source')='scheduled';
    CREATE UNIQUE INDEX IF NOT EXISTS active_pr ON runs(repo, pr) WHERE state IN ('running', 'cancelling');
    CREATE UNIQUE INDEX IF NOT EXISTS next_pr_for_viewer ON runs(repo, pr, viewer) WHERE state='queued';`;

const range = (head: string) => ({ baseSha: "a".repeat(40), headSha: head.repeat(40) });
type Placement = { id: string; review: string; round: number; previous: string | null };

/** Two PRs, two viewers with a case variant, three ranges on one PR in shuffled insert order. */
function writeMainFixture(file: string) {
  const db = new Database(file);
  db.exec(MAIN_DDL);
  const row = (id: string, viewer: string, pr: number, head: string, state: string, second: number, extra: Record<string, unknown> = {}) => {
    const reviewed = ["completed", "partial"].includes(state) ? range(head) : null;
    db.run("INSERT INTO runs (id,repo,pr,viewer,state,pid,cwd,request,details) VALUES (?,?,?,?,?,?,?,?,?)", [
      id, "gid", pr, viewer, state, null, "/project", JSON.stringify({ ...key, viewer, number: pr }),
      JSON.stringify({ id, source: "manual", ...range(head), state, phase: state, reason: "", startedAt: null, finishedAt: null,
        createdAt: `2026-01-01T00:00:0${second}.000Z`,
        result: reviewed && { reviewed, verdict: null, coverage: "complete", findings: { blocker: 0, major: 0, minor: 0, info: 0 }, report: "" },
        ...extra }),
    ]);
  };
  const decision = (action: string) => ({ decision: { action, reason: "", at: "" } });
  row("a5", "user", 12, "3", "completed", 5, { source: "existing" });
  row("c1", "colleague", 12, "1", "completed", 1);
  row("a1", "user", 12, "1", "completed", 1);
  row("a8", "user", 12, "5", "queued", 8);
  row("a3", "user", 12, "2", "partial", 3, decision("archive"));
  row("p1", "user", 13, "1", "failed", 2);
  row("a2", "User", 12, "1", "failed", 2);
  row("a7", "user", 12, "4", "running", 7);
  row("a4", "user", 12, "2", "completed", 4, { continuation: { previousId: "a3" } });
  row("a6", "user", 12, "3", "cancelled", 6, decision("delete"));
  db.close();
}

function placements(file: string) {
  const db = new Database(file, { readonly: true });
  try {
    return {
      runs: db.query<Placement, []>("SELECT id, review_id AS review, round, previous_run_id AS previous FROM runs ORDER BY id").all(),
      reviews: db.query<{ id: string; repo: string; pr: number; viewer: string }, []>("SELECT id, repo, pr, viewer FROM reviews ORDER BY id").all(),
      orphans: db.query<{ n: number }, []>("SELECT count(*) AS n FROM runs WHERE review_id IS NULL OR review_id NOT IN (SELECT id FROM reviews)").get()?.n,
    };
  } finally { db.close(); }
}

test("opening a copy of main's database migrates it in place into Reviews and rounds, once", async () => {
  const { localBadge } = await import("./board-badges");
  const fixture = mkdtempSync(path.join(tmpdir(), "keryx-review-main-"));
  const unmigrated = mkdtempSync(path.join(tmpdir(), "keryx-review-copy-"));
  try {
    writeMainFixture(path.join(fixture, "runs.sqlite"));
    copyFileSync(path.join(fixture, "runs.sqlite"), path.join(unmigrated, "runs.sqlite"));

    // The read-only path keeps working on the unmigrated copy and never migrates it.
    const reader = new DeskRunStore(unmigrated, true);
    try {
      const cards: import("./board-badges").BadgeCard[] = [{ number: 12, ...range("4") }];
      reader.attachBadges({ repositoryId: "gid", viewer: "user", cards });
      expect(cards[0]?.localReview).toEqual({ active: true, ready: false, runState: "running" });
      const colleague: import("./board-badges").BadgeCard[] = [{ number: 12, ...range("2") }];
      reader.attachBadges({ repositoryId: "gid", viewer: "colleague", cards: colleague });
      expect(colleague[0]?.localReview).toEqual({ active: false, ready: false, outdated: { headSha: range("1").headSha, state: "completed" } });
      expect(reader.activeReviewNumbers({ repositoryId: "gid", viewer: "USER" })).toEqual([12]);
      expect(reader.byId("a4")?.run).not.toHaveProperty("round");
      expect(reader.history({ ...key, repositoryId: "gid" }).runs.map(run => run.round)).toEqual(Array(7).fill(undefined));
    } finally { reader.close(); }
    const raw = new Database(path.join(unmigrated, "runs.sqlite"), { readonly: true });
    try {
      expect(raw.query("SELECT name FROM pragma_table_info('runs') WHERE name='review_id'").get()).toBeNull();
      expect(raw.query("SELECT name FROM sqlite_schema WHERE name='reviews'").get()).toBeNull();
    } finally { raw.close(); }

    const file = path.join(fixture, "runs.sqlite");
    new DeskRunStore(fixture).close();
    const first = placements(file);
    expect(first.runs).toHaveLength(10);
    expect(first.orphans).toBe(0);
    expect(first.reviews).toHaveLength(3);
    const reviewOf = (id: string) => first.runs.find(run => run.id === id)?.review;
    const user = reviewOf("a1");
    expect(first.reviews.filter(review => review.pr === 12 && review.viewer.toLowerCase() === "user").map(r => r.id)).toEqual([user!]);
    expect(new Set(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"].map(reviewOf))).toEqual(new Set([user]));
    expect(new Set([user, reviewOf("c1"), reviewOf("p1")]).size).toBe(3);
    expect(Object.fromEntries(first.runs.map(({ id, round, previous }) => [id, [round, previous]]))).toEqual({
      a1: [1, null], a2: [1, "a1"], // a retry on the first range, recorded under the case-variant viewer
      a3: [2, "a2"], a4: [2, "a3"], // a continuation joins its predecessor's round
      a5: [3, "a4"], a6: [3, "a5"], a7: [4, "a6"], a8: [5, "a7"],
      c1: [1, null], p1: [1, null],
    });

    const reopened = new DeskRunStore(fixture);
    try {
      expect(placements(file)).toEqual(first);
      const history = reopened.history({ ...key, repositoryId: "gid" }).runs;
      expect(history.map(run => [run.id, run.round, run.previousRunId])).toEqual([
        ["a8", 5, "a7"], ["a7", 4, "a6"], ["a5", 3, "a4"], ["a4", 2, "a3"], ["a3", 2, "a2"], ["a2", 1, "a1"], ["a1", 1, null],
      ]);
      expect(new Set(history.map(run => run.reviewId))).toEqual(new Set([user]));
      const colleague: import("./board-badges").BadgeCard[] = [{ number: 12, ...range("2") }];
      reopened.attachBadges({ repositoryId: "gid", viewer: "colleague", cards: colleague });
      expect(colleague[0]?.localReview).toEqual({ active: false, ready: false, outdated: { headSha: range("1").headSha, state: "completed", round: 1 } });
      expect(colleague[0]?.localReview).toEqual(localBadge(reopened.history({ ...other, repositoryId: "gid" }).runs, range("2")));
    } finally { reopened.close(); }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(unmigrated, { recursive: true, force: true });
  }
});

test("one PR with three historical runs is one Review with rounds", () => {
  const ids = ["1", "2", "3"].map(head => {
    const id = store.request("/project", key, range(head))!;
    store.end(store.byId(id)!, { ...finish, result: { ...finish.result!, reviewed: range(head) } });
    return id;
  });
  const runs = store.history(key).runs;
  expect(new Set(runs.map(run => run.reviewId)).size).toBe(1);
  expect(runs[0]?.reviewId).toBeString();
  expect(runs.map(run => [run.id, run.round, run.previousRunId])).toEqual([
    [ids[2], 3, ids[1]], [ids[1], 2, ids[0]], [ids[0], 1, null],
  ]);
});

test("a new attempt is assigned its Review and round when it is recorded: start, retry, continuation and new head", () => {
  const place = (id: string) => {
    const run = store.byId(id)?.run;
    return [run?.reviewId, run?.round, run?.previousRunId];
  };
  const first = store.request("/project", key, revision)!;
  const review = store.byId(first)?.run.reviewId;
  expect(review).toBeString();
  expect(place(first)).toEqual([review, 1, null]);
  store.end(store.byId(first)!, { ...finish, state: "failed", result: null });

  const retry = store.atomic(() => store.request("/project", key, revision))!;
  expect(place(retry)).toEqual([review, 1, first]);
  const retried = store.byId(retry)!;
  store.end(retried, { ...finish, state: "partial", result: null });

  // An imported package on the same range joins the round; projected fields it carries are ignored.
  store.recordExisting("/project", key, [{ ...retried.run, id: "imported", source: "existing", reviewId: "forged", round: 9, previousRunId: "x" }]);
  expect(place("imported")).toEqual([review, 1, retry]);

  // A continuation links to the attempt it continues, not to the newest attempt of the round.
  const continued = store.atomic(() => store.requestContinuation("/project", key, retry))!;
  expect(place(continued)).toEqual([review, 1, retry]);
  store.end(store.byId(continued)!, finish);

  const moved = store.atomic(() => store.request("/project", key, next))!;
  expect(place(moved)).toEqual([review, 2, continued]);
  store.end(store.byId(moved)!, finish);

  // The account is part of the key, case-insensitively.
  const upper = store.request("/project", { ...key, viewer: "USER" }, { ...next, headSha: "d".repeat(40) })!;
  expect(place(upper)).toEqual([review, 3, moved]);
  const colleague = store.request("/project", other, revision)!;
  expect(store.byId(colleague)?.run.reviewId).not.toBe(review);
  expect(place(colleague).slice(1)).toEqual([1, null]);

  // The projection is read from the columns and never written back into details.
  const saved = store.byId(moved)!;
  saved.run.reason = "saved again";
  store.save(saved);
  expect(place(moved)).toEqual([review, 2, continued]);
  const db = new Database(path.join(directory, "runs.sqlite"), { readonly: true });
  try {
    const details = db.query<{ details: string }, []>("SELECT details FROM runs").all().map(row => JSON.parse(row.details) as object);
    expect(details).toHaveLength(7);
    for (const stored of details) for (const field of ["reviewId", "round", "previousRunId"]) expect(stored).not.toHaveProperty(field);
  } finally { db.close(); }
});

const placeOf = (id: string) => {
  const run = store.byId(id)?.run;
  return [run?.round, run?.previousRunId];
};

test("a return to an earlier range (A, B, A) opens the next round; a retry joins only the current highest round", () => {
  const a = store.request("/project", key, revision)!;
  store.end(store.byId(a)!, { ...finish, state: "partial" });
  const b = store.atomic(() => store.request("/project", key, next))!;
  store.end(store.byId(b)!, { ...finish, result: { ...finish.result!, reviewed: next } });
  const back = store.atomic(() => store.request("/project", key, revision))!;
  expect(placeOf(back)).toEqual([3, b]);
  store.end(store.byId(back)!, { ...finish, state: "failed", result: null });
  const retry = store.atomic(() => store.request("/project", key, revision))!;
  expect(placeOf(retry)).toEqual([3, back]);
  const row = store.reviewRows("gid", "user")[0]!;
  expect(row.attempts.map(attempt => [attempt.id, attempt.round])).toEqual([[a, 1], [b, 2], [back, 3], [retry, 3]]);
});

test("a queued request superseded before it started keeps no round: the next request takes its round and links past it", () => {
  const running = started();
  const queued = store.atomic(() => store.request("/project", key, next))!;
  expect(placeOf(queued)).toEqual([2, running.run.id]);
  const third = { ...revision, headSha: "d".repeat(40) };
  const latest = store.atomic(() => store.request("/project", key, third))!;
  expect(store.byId(queued)?.run).toMatchObject({ state: "skipped", phase: "Superseded" });
  expect(placeOf(latest)).toEqual([2, running.run.id]);
  // The never-started request is not an attempt of the Review.
  expect(store.reviewRows("gid", "user")[0]!.attempts.map(attempt => attempt.id)).toEqual([running.run.id, latest]);
});

test("history imported later is numbered when it is recorded, even when it is older than placed rounds (known limitation)", () => {
  const desktop = store.request("/project", key, revision)!;
  store.end(store.byId(desktop)!, finish);
  const older = { ...store.byId(desktop)!.run, id: "older-package", source: "existing" as const, ...next,
    createdAt: "2020-01-01T00:00:00.000Z", result: { ...finish.result!, reviewed: next } };
  store.recordExisting("/project", key, [older]);
  expect(placeOf("older-package")).toEqual([2, desktop]);
});

test("reviewRows reads a publication outcome for every finished reviewed attempt and keeps archived attempts flagged", () => {
  const finished = (rev: typeof revision, state: DeskFinish["state"], coverage: "complete" | "partial" = "complete") => {
    const id = store.atomic(() => store.request("/project", key, rev))!;
    store.end(store.byId(id)!, { ...finish, state, result: { ...finish.result!, reviewed: rev, coverage } });
    return id;
  };
  const published = finished(revision, "partial", "partial");
  mkdirSync(store.directory(published), { recursive: true });
  writeFileSync(path.join(store.directory(published), PUBLICATION_RECEIPT), JSON.stringify({ url: "https://github.com/org/repo/pull/12#r" }));
  const skipped = finished(next, "budget", "partial");
  mkdirSync(store.directory(skipped), { recursive: true });
  writeFileSync(path.join(store.directory(skipped), PUBLICATION_SKIPPED), "");
  const undecided = finished({ ...revision, headSha: "d".repeat(40) }, "partial", "partial");
  const pending = finished({ ...revision, headSha: "e".repeat(40) }, "completed");
  const archived = finished({ ...revision, headSha: "f".repeat(40) }, "completed");
  const a = store.byId(archived)!;
  a.run.decision = { action: "archive", reason: "noise", at: "2026-11-20T00:00:00Z" };
  store.save(a);
  const deleted = finished({ ...revision, headSha: "9".repeat(40) }, "completed");
  const d = store.byId(deleted)!;
  d.run.decision = { action: "delete", reason: "noise", at: "2026-11-20T00:00:00Z" };
  store.save(d);
  const attempts = store.reviewRows("gid", "user")[0]!.attempts;
  expect(attempts.map(attempt => [attempt.id, attempt.publication, attempt.archived])).toEqual([
    [published, "published", false], [skipped, "skipped", false], [undecided, null, false], [pending, "pending", false], [archived, null, true],
  ]);
  // The attempt history reads the same outcome.
  expect(store.history(key).runs.find(run => run.id === published)?.publication).toBe("published");
});

test("a Review whose attempts are all archived is still listed; an interrupted attempt reads as failed", () => {
  const id = store.request("/project", key, revision)!;
  store.end(store.byId(id)!, finish);
  const a = store.byId(id)!;
  a.run.decision = { action: "archive", reason: "noise", at: "2026-11-20T00:00:00Z" };
  store.save(a);
  const interrupted = store.request("/project", { ...key, number: 13 }, revision)!;
  const db = new Database(path.join(directory, "runs.sqlite"));
  try { db.run("UPDATE runs SET state='recoverable' WHERE id=?", [interrupted]); } finally { db.close(); }
  const rows = store.reviewRows("gid", "user");
  expect(rows.map(row => [row.number, row.attempts.map(attempt => [attempt.id, attempt.archived, attempt.state])])).toEqual([
    [13, [[interrupted, false, "failed"]]], [12, [[id, true, "completed"]]],
  ]);
});

test("T16 B6: roundPlacements answers the placement rules from the same rows as history, without reports", () => {
  const first = started();
  store.end(first, finish);
  const second = store.request("/project", key, next)!;
  store.end(store.byId(second)!, { state: "failed", phase: "Failed", reason: "x", result: null });
  const archived = store.byId(first.run.id)!;
  archived.run.decision = { action: "archive", reason: "r", at: "2026-11-24T01:00:00.000Z" };
  store.save(archived);
  const third = store.request("/project", key, { ...revision, headSha: "d".repeat(40) })!;
  const deleted = store.byId(third)!;
  deleted.run.decision = { action: "delete", reason: "r", at: "2026-11-24T01:00:00.000Z" };
  store.save(deleted);
  store.request("/project", other, revision);

  const placements = store.roundPlacements(key);
  const history = store.history(key).runs;
  expect(placements.map((item) => item.id)).toEqual(history.map((run) => run.id));
  expect(placements.map((item) => item.id)).not.toContain(third);
  for (const [index, item] of placements.entries()) {
    const run = history[index]!;
    expect(item).toEqual({ id: run.id, source: run.source, state: run.state, baseSha: run.baseSha, headSha: run.headSha,
      reviewId: run.reviewId, round: run.round, ...(run.decision && { decision: { action: run.decision.action } }),
      result: run.result?.reviewed ? { reviewed: true } : null });
    expect(Object.keys(item)).not.toContain("report");
  }
  expect(placements.find((item) => item.id === first.run.id)).toMatchObject({ decision: { action: "archive" }, result: { reviewed: true } });
  expect(placements.find((item) => item.id === second)).toMatchObject({ state: "failed", result: null, round: 2 });
});

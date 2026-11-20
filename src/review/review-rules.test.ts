import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewBoardSnapshot, ReviewCard } from "./board-types";
import { configureWatcher, pauseWatcher, pollWatcher } from "./watcher";
import { applyReviewRuleAction } from "./review-rules";
import type { ReviewRule, ReviewRuleAction } from "./review-rule-types";
import type { DispatchReviewRule } from "./review-rule-dispatch";

const key = { repo: "team/repo", repositoryId: "R", viewer: "who" };
let project: string, previous: string | undefined;
beforeEach(() => {
  previous = process.env.KERYX_DATA_DIR;
  project = mkdtempSync(join(tmpdir(), "keryx-rule-test-"));
  process.env.KERYX_DATA_DIR = project;
  configureWatcher(project, key, 5);
});
afterEach(() => {
  if (previous === undefined) delete process.env.KERYX_DATA_DIR;
  else process.env.KERYX_DATA_DIR = previous;
  rmSync(project, { recursive: true, force: true });
});
const rule = (overrides: Partial<ReviewRule> = {}): ReviewRule => ({
  id: "r",
  name: "Team checks",
  enabled: true,
  event: "review_requested",
  author: "",
  assignee: "",
  reviewer: "team/ui",
  requireGreen: true,
  budgetMinutes: 5,
  budgetTokens: 50000,
  ...overrides,
});
const card = (overrides: Partial<ReviewCard> = {}): ReviewCard => ({
  number: 2,
  title: "Test",
  url: "",
  state: "open",
  draft: false,
  author: "Me",
  assignees: ["one"],
  reviewers: [],
  decision: null,
  ci: "pending",
  headSha: "sha-1",
  baseSha: "base",
  updatedAt: "time",
  ...overrides,
});
const board = (...cards: ReviewCard[]): ReviewBoardSnapshot => ({
  version: 1,
  ...key,
  repositories: [key.repo],
  fetchedAt: "now",
  cards,
  warnings: [],
});
const action = (a: ReviewRuleAction) => applyReviewRuleAction(project, key, a);
const status = () => action({ kind: "status", number: 2 });
const tick = (
  b: ReviewBoardSnapshot,
  dispatch: DispatchReviewRule = () => {
    throw new Error("unexpected dispatch");
  },
) => pollWatcher(project, key, { fetch: async () => b, dispatch });
const requested = (o: Partial<ReviewCard> = {}) => card({ reviewers: ["Team/ui"], ...o });

test("a request waits for green CI on its latest SHA, survives an incomplete poll, and overlapping rules submit once", async () => {
  action({ kind: "save", rule: rule() });
  action({ kind: "save", rule: rule({ id: "s", name: "Same event" }) });
  await tick(board(card()));
  await tick(board(requested()));
  expect(status().activity.map((a) => a.state)).toEqual(["waiting", "waiting"]);
  await tick({ ...board(), warnings: ["partial"] });
  expect(status().activity.map((a) => a.state)).toEqual(["waiting", "waiting"]);
  await tick(board(requested({ headSha: "sha-2" })));
  expect(
    status()
      .activity.filter((a) => a.state === "waiting")
      .map((a) => a.headSha),
  ).toEqual(["sha-2", "sha-2"]);
  const attempts: string[] = [];
  const start: DispatchReviewRule = async (_cwd, k, rev, s, allow) =>
    allow(() => {
      attempts.push([k.number, rev.headSha, s.event, s.recipient, s.budgetTokens].join("/"));
      return { id: "run-1" };
    });
  await tick(board(requested({ headSha: "sha-2", ci: "passed" })), start);
  await tick(board(requested({ headSha: "sha-2", ci: "passed" })), start);
  expect(attempts).toEqual(["2/sha-2/review_requested/Team/ui/50000"]);
  expect(status().activity.filter((a) => a.runId === "run-1")).toHaveLength(2);
});

test("enabling a rule or changing a PR mode baselines only that rule/PR; manual, author and assignee filter independently", async () => {
  const push = rule({
    id: "push",
    event: "push",
    reviewer: "",
    requireGreen: false,
    author: "ME",
    assignee: "ONE",
  });
  action({ kind: "save", rule: push });
  await tick(board(card()));
  const attempts: string[] = [];
  const start: DispatchReviewRule = async (_cwd, k, r, s, allow) =>
    allow(() => {
      attempts.push(k.number + ":" + s.ruleId + ":" + r.headSha);
      return { id: String(attempts.length) };
    });
  action({ kind: "mode", number: 2, choice: { mode: "manual" } });
  await tick(board(card({ headSha: "two" })), start);
  action({ kind: "mode", number: 2, choice: { mode: "auto", ruleId: "push" } });
  await tick(board(card({ headSha: "three" })), start);
  await tick(board(card({ headSha: "four", assignees: [] })), start);
  await tick(board(card({ headSha: "five" })), start);
  action({ kind: "save", rule: { ...push, enabled: false } });
  await tick(board(card({ headSha: "six" })), start);
  action({ kind: "save", rule: push });
  await tick(board(card({ headSha: "seven" })), start);
  await tick(board(card({ headSha: "eight" })), start);
  expect(attempts).toEqual(["2:push:five", "2:push:eight"]);
  expect(status().choice).toEqual({ mode: "auto", ruleId: "push" });
  action({ kind: "delete", id: "push" });
  expect(status().choice).toEqual({ mode: "auto", ruleId: "push" });
  expect(() => action({ kind: "mode", number: 2, choice: { mode: "auto", ruleId: "missing" } })).toThrow(
    "enabled",
  );
});

test("request withdrawal and close remove pending items; repeated request acquires a new candidate", async () => {
  action({ kind: "save", rule: rule() });
  await tick(board(card()));
  await tick(board(requested()));
  expect(status().activity).toMatchObject([{ state: "waiting" }]);
  await tick(board(card({ ci: "passed" })));
  const [withdrawn] = status().activity;
  expect(withdrawn).toMatchObject({ state: "skipped", reason: "Team checks: Rule conditions no longer match" });
  await tick(board(requested()));
  expect(status().activity).toEqual([
    expect.objectContaining({ state: "waiting", headSha: "sha-1" }), withdrawn,
  ]);
  await tick(board());
  expect(status().activity).toEqual([
    expect.objectContaining({ state: "skipped", headSha: "sha-1", reason: "Team checks: PR is no longer open" }), withdrawn,
  ]);
});

test("pause, manual mode or deleting a rule fences enqueue after policy changed during preflight", async () => {
  for (const change of ["pause", "manual", "delete"]) {
    configureWatcher(project, key, 1);
    action({ kind: "save", rule: rule({ enabled: true, requireGreen: false }) });
    action({ kind: "mode", number: 2, choice: { mode: "project" } });
    await tick(board(card()));
    let started = false;
    await tick(board(requested()), async (_cwd, _k, _r, _s, allow) => {
      if (change === "pause") pauseWatcher(project, key);
      if (change === "manual") action({ kind: "mode", number: 2, choice: { mode: "manual" } });
      if (change === "delete") action({ kind: "delete", id: "r" });
      return allow(() => {
        started = true;
        return { id: "forbidden" };
      });
    });
    expect(started).toBe(false);
    expect(status().activity[0]?.state).toBe("skipped");
  }
});

test("another active revision defers the outbox; replay uses the same durable attempt key", async () => {
  action({ kind: "save", rule: rule({ requireGreen: false }) });
  await tick(board(card()));
  const ids: string[] = [];
  const start: DispatchReviewRule = async (_cwd, _k, _r, s, allow) =>
    allow(() => {
      ids.push(s.attemptKey);
      return ids.length === 1 ? null : { id: "ok" };
    });
  await tick(board(requested()), start);
  expect(status().activity[0]?.reason).toContain("earlier");
  await tick(board(requested()), start);
  expect(ids[0]).toBe(ids[1]);
  expect(status().activity[0]?.runId).toBe("ok");
});

test("a poll started before an enabling edit cannot establish its baseline", async () => {
  await tick(board(card()));
  let finish!: (result: ReviewBoardSnapshot) => void;
  const old = pollWatcher(project, key, {
    fetch: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  action({ kind: "save", rule: rule({ requireGreen: false }) });
  finish(board(card()));
  await old;
  let calls = 0;
  const start: DispatchReviewRule = async (_p, _k, _r, _s, allow) => allow(() => ({ id: String(++calls) }));
  await tick(board(requested({ reviewRequestIds: { "team/ui": "old" } })), start);
  expect(calls).toBe(0);
  await tick(board(requested({ reviewRequestIds: { "team/ui": "new" } })), start);
  expect(calls).toBe(1);
});

test("a scheduled worker must still hold permission at spend time after its desk-run ID was linked", async () => {
  action({ kind: "save", rule: rule({ requireGreen: false }) });
  await tick(board(card()));
  let spend!: <T>(work: () => T) => T;
  await tick(board(requested()), async (_p, _k, _r, _s, allow) => {
    spend = allow;
    return allow(() => ({ id: "linked" }));
  });
  expect(status().activity[0]?.runId).toBe("linked");
  expect(spend(() => 1)).toBe(1);
  const snapshot = board(requested());
  await tick({ ...snapshot, warnings: ["unavailable"] });
  expect(() => spend(() => 1)).toThrow("complete");
  await tick(snapshot);
  action({ kind: "mode", number: 2, choice: { mode: "manual" } });
  expect(() => spend(() => 1)).toThrow("enabled");
  expect(applyReviewRuleAction(project, { ...key, viewer: "other" }, { kind: "status" }).activity).toEqual(
    [],
  );
});

test("overlapping rule names retain their own trigger; a zero-spend guard refusal can hand off to a remaining rule", async () => {
  action({ kind: "save", rule: rule({ id: "a", name: "Push rule", event: "push", requireGreen: false }) });
  action({ kind: "save", rule: rule({ id: "b", name: "Request rule", requireGreen: false }) });
  await tick(board(card()));
  const current = board(requested({ headSha: "new" }));
  const attempts: string[] = [];
  const start: DispatchReviewRule = async (_cwd, _k, _r, s, allow) =>
    allow(() => {
      attempts.push(s.ruleName);
      return { id: "attempt-" + attempts.length, state: "running", source: "scheduled", reused: false };
    });
  await tick(current, start);
  const entries = status().activity;
  expect(entries.map((row) => row.state).sort()).toEqual(["linked", "started"]);
  expect(entries.find((row) => row.reason.includes("Push rule"))?.reason).toContain("new head commit");
  expect(entries.find((row) => row.reason.includes("Request rule"))?.reason).toContain(
    "review requested from Team/ui",
  );
  action({ kind: "delete", id: attempts[0] === "Push rule" ? "a" : "b" });
  await pollWatcher(project, key, {
    fetch: async () => current,
    dispatch: start,
    outcomes: () => ({ retryable: new Set(["attempt-1"]), terminal: new Set() }),
  });
  expect(new Set(attempts)).toEqual(new Set(["Push rule", "Request rule"]));
  expect(status().activity.filter((row) => row.runId === "attempt-2")).toHaveLength(1);
});

test("a previous failed or cancelled manual attempt is linked and never presented as a new launch", async () => {
  action({ kind: "save", rule: rule({ requireGreen: false }) });
  await tick(board(card()));
  await tick(board(requested()), async () => ({
    id: "previous",
    source: "manual",
    state: "cancelled",
    reused: true,
  }));
  const [entry] = status().activity;
  expect(entry).toMatchObject({ state: "linked", runId: "previous" });
  expect(entry?.reason).toContain("manual review (cancelled)");
});

for (const tokens of [null, 250000, 500000]) {
  test(`a scheduled run keeps its saved token limit (${tokens ?? "unlimited"}) through the spawn fence`, async () => {
    action({ kind: "save", rule: rule({ requireGreen: false, budgetTokens: tokens }) });
    expect(status().rules[0]?.budgetTokens).toBe(tokens);
    await tick(board(card()));
    let received: number | null | undefined;
    await tick(board(requested()), async (_cwd, _key, _revision, schedule, authorize) =>
      authorize(() => {
        received = schedule.budgetTokens;
        return { id: "run" };
      }));
    expect(received).toBe(tokens);
  });
}

test("authorization refuses an uncapped spawn for a rule with an explicit token budget", async () => {
  action({ kind: "save", rule: rule({ requireGreen: false, budgetTokens: 250000 }) });
  await tick(board(card()));
  let spent = false;
  await tick(board(requested()), async (_cwd, _key, _revision, schedule, authorize) => {
    schedule.budgetTokens = null;
    return authorize(() => { spent = true; return { id: "wrong-budget" }; });
  });
  expect(spent).toBe(false);
  expect(status().activity[0]?.runId).toBeUndefined();
  expect(status().activity[0]?.reason).toContain("rule conditions changed");
});

test("saving an older editor cannot restore a deleted rule or overwrite a newer budget", () => {
  const original = rule();
  const changed = rule({ budgetTokens: 100 });
  const apply = (action: ReviewRuleAction) => applyReviewRuleAction(project, key, action);
  apply({ kind: "save", rule: original, expected: null });
  apply({ kind: "save", rule: changed, expected: original });
  expect(() => apply({ kind: "save", rule: original, expected: original })).toThrow("conflict");
  expect(() => apply({ kind: "delete", id: original.id, expected: original })).toThrow("conflict");
  expect(apply({ kind: "status" }).rules).toEqual([changed]);
  apply({ kind: "delete", id: original.id, expected: changed });
  expect(() => apply({ kind: "save", rule: changed, expected: changed })).toThrow("conflict");
  expect(apply({ kind: "status" }).rules).toEqual([]);
});

for (const checkpoint of [true, false]) {
  test(`an unchanged authorized poll settles an orphaned scheduled run ${checkpoint ? "from the durable finish" : "as interrupted"} without resubmitting`, async () => {
    const { DeskRunStore } = await import("./desk-run-store");
    const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    const store = new DeskRunStore();
    let runId = "", submissions = 0;
    const current = board(requested());
    const submit: DispatchReviewRule = async (_cwd, target, revision, schedule, authorize) => authorize(() => {
      submissions++;
      const recorded = store.requestAttempt(project, target, revision, schedule)!;
      runId = recorded.id;
      const attempt = store.byId(runId)!;
      attempt.pid = child.pid;
      attempt.run.state = "running";
      store.save(attempt);
      const directory = store.directory(runId);
      mkdirSync(directory, {recursive:true});
      if (checkpoint) writeFileSync(join(directory,"execution-result.json"), JSON.stringify({
        outcome:"complete", coverage:"complete", verdict:"APPROVE", findings:{blocker:0,major:0,minor:0,info:0},
        checkedBase:revision.baseSha, checkedHead:revision.headSha, reason:"Stored final verdict", report:"Fixture result",
      }));
      return {id:runId,source:"scheduled",state:"running",reused:false};
    });
    try {
      action({ kind: "save", rule: rule({requireGreen:false}) });
      await tick(board(card()), submit);
      await tick(current, submit);
      expect(store.byId(runId)?.run.state).toBe("running");
      expect((await tick({...current,viewer:"changed"}, submit)).lastError).toContain("access:");
      expect(store.byId(runId)?.run.state).toBe("running");
      // An incomplete observation cannot authorize recovery either.
      await tick({...current,warnings:["Partial observation"]}, submit);
      expect(store.byId(runId)?.run.state).toBe("running");
      if (checkpoint) {
        const marker = join(store.directory(runId), "child.json");
        writeFileSync(marker, "{");
        const accepted = await tick({ ...current, cards: [...current.cards, card({ number: 99 })] }, submit);
        expect(accepted.lastError).toContain("could not be recovered");
        expect(accepted.events).toContainEqual(expect.objectContaining({ kind: "opened", number: 99 }));
        expect(store.byId(runId)?.run.state).toBe("running");
        rmSync(marker);
      }
      if (!checkpoint) action({ kind: "mode", number: current.cards[0]!.number, choice: { mode: "manual" } });
      await tick(current, submit);
      const ended = store.byId(runId)!.run;
      expect(ended.state).toBe(checkpoint ? "completed" : "failed");
      if (checkpoint) expect(ended.result?.verdict).toBe("APPROVE");
      else expect(ended.phase).toBe("Interrupted");
      expect(ended.retryableBeforeSpend).not.toBe(true);
      await tick(current, submit);
      expect(submissions).toBe(1);
      expect(status().activity[0]?.runId).toBe(runId);
    } finally { store.close(); }
  });
}

test("watcher orphan recovery refuses links to another project, viewer, repository, PR, or attempt", async () => {
  const { DeskRunStore } = await import("./desk-run-store");
  const { reconcileLinkedScheduledRuns } = await import("./desk-run-service");
  const store = new DeskRunStore();
  const child = Bun.spawn([process.execPath, "-e", ""], {stdout:"ignore",stderr:"ignore"});
  await child.exited;
  try {
    action({kind:"save",rule:rule({requireGreen:false})});
    await tick(board(card()));
    let id = "", number = 0;
    await tick(board(requested()), async (_cwd, target, revision, schedule, authorize) => authorize(() => {
      number = target.number;
      id = store.requestAttempt(project,target,revision,schedule)!.id;
      const a = store.byId(id)!;
      a.pid = child.pid; a.run.state = "running"; store.save(a);
      return {id,source:"scheduled",state:"running",reused:false};
    }));
    const links = [{number,runId:id}];
    const visible = new Set([number, number+1]);
    await reconcileLinkedScheduledRuns(project+"/elsewhere", key, links, visible);
    await reconcileLinkedScheduledRuns(project, {...key,viewer:"other"}, links, visible);
    await reconcileLinkedScheduledRuns(project, {...key,repositoryId:"other"}, links, visible);
    await reconcileLinkedScheduledRuns(project, key, [{number:number+1,runId:id}], visible);
    await reconcileLinkedScheduledRuns(project, key, [{number,runId:"other"}], visible);
    expect(store.byId(id)?.run.state).toBe("running");
    const checked: number[][] = [];
    await reconcileLinkedScheduledRuns(project, key, links, new Set(), async numbers => { checked.push(numbers); return new Set(); });
    expect(store.byId(id)?.run.state).toBe("running");
    await reconcileLinkedScheduledRuns(project, key, links, new Set(), async numbers => { checked.push(numbers); return new Set(numbers); });
    expect(checked).toEqual([[number],[number]]);
    expect(store.byId(id)?.run.state).toBe("failed");
  } finally { store.close(); }
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ReviewRule, ReviewRuleAction, ReviewRuleSnapshot } from "../../../../src/review/review-rule-types";
import type { reviewRules } from "../platform/reviewRules";
import type { reviewWatcher, ReviewWatcherAction, ReviewWatcherSnapshot } from "../platform/reviewWatcher";
import type { reviewRun } from "../platform/reviewRuns";
import type { Root } from "react-dom/client";
import type { fetchReviewBoard, fetchReviewDetail, fetchReviewRepositories } from "../platform/review";
import { registerDom, unregisterDom } from "../test/dom";
import type { ReviewBoardSnapshot, ReviewCard } from "./types";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let ReviewBoard: typeof import("./ReviewBoard").ReviewBoard;
let renderKey = 0;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  ReviewBoard = (await import("./ReviewBoard")).ReviewBoard;
  host = document.createElement("div");
  document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const pr: ReviewCard = {
  number: 101, title: "Update from colleague", state: "open", draft: false, url: "https://github.com/org/repo/pull/101",
  author: "lee", assignees: [], reviewers: ["org/team"], ci: "passed", decision: "REVIEW_REQUIRED",
  updatedAt: "2026-11-10T01:00:00Z", headSha: "b", baseSha: "a",
};

function snapshot(cards: ReviewCard[], warnings: string[] = []): ReviewBoardSnapshot {
  return { version: 1, repo: "org/repo", repositories: ["org/repo"], repositoryId: "repo1", viewer: "ann", fetchedAt: pr.updatedAt, cards, warnings };
}

const watcherOff: ReviewWatcherSnapshot = { version: 1, state: "disabled", installed: false, intervalMinutes: 5,
  lastAttemptAt: null, lastSuccessAt: null, lastError: null, events: [] };
const watcherDisabled = async () => watcherOff;

function render(load: typeof fetchReviewBoard, cwd = "/project", key = ++renderKey, listRepositories: typeof fetchReviewRepositories = async () => [], loadDetail?: typeof fetchReviewDetail, runCommand?: typeof reviewRun, watcherCommand: typeof reviewWatcher = watcherDisabled, rulesCommand?: typeof reviewRules) {
  return act(async () => { root.render(createElement(ReviewBoard, { key, cwd, flows: [], onOpenFlow: () => {}, load, listRepositories, loadDetail, runCommand, watcherCommand, rulesCommand })); });
}

const click = (el: HTMLElement) => act(async () => { el.click(); });
function button(label: string) {
  const el = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
  if (!el) throw new Error("Missing button " + label);
  return el;
}
function option(group: string, name: string) {
  const fieldset = Array.from(host.querySelectorAll("fieldset")).find((f) => f.querySelector("legend")?.textContent === group);
  const label = Array.from(fieldset?.querySelectorAll("label") ?? []).find((l) => l.textContent === name);
  if (!label) throw new Error("Missing filter " + group + "/" + name);
  return label.querySelector("input")!;
}

test("shows unassigned colleagues and drafts; board and list share author, team, decision and CI filters", async () => {
  const cards: ReviewCard[] = [
    pr,
    { ...pr, number: 102, author: "bob" },
    { ...pr, number: 103, reviewers: ["org/other"] },
    { ...pr, number: 104, decision: "APPROVED" },
    { ...pr, number: 105, ci: "failed" },
    { ...pr, number: 106, title: "Draft from author", draft: true, author: "bob", reviewers: [], decision: null, ci: "none" },
  ];
  await render(async () => snapshot(cards));
  expect(host.querySelectorAll(".review-card")).toHaveLength(cards.length);
  await click(button("Filters"));
  await click(option("Author", "lee"));
  await click(option("Review requested from", "org/team"));
  await click(option("GitHub review decision", "Review required"));
  await click(option("Checks on head commit", "CI passed"));
  await click(button("Apply filters"));
  expect(Array.from(host.querySelectorAll(".review-card .flow-id"), id => id.textContent)).toEqual(["#101"]);
  await click(button("List"));
  expect(Array.from(host.querySelectorAll("tbody .flow-id"), id => id.textContent)).toEqual(["#101"]);
  await click(button("Clear filters"));
  expect(host.querySelectorAll("tbody tr")).toHaveLength(cards.length);
});

test("refresh failure preserves last available snapshot, access loss hides its cards and identity", async () => {
  let reason = "";
  await render(async () => {
    if (reason) throw new Error(reason);
    return snapshot([pr], ["Some checks unavailable"]);
  });
  expect(host.textContent).toContain("Partial sync");
  reason = "unavailable: GitHub timed out";
  await click(button("Refresh pull requests"));
  expect(host.textContent).toContain("Last available snapshot");
  expect(host.textContent).toContain(pr.title);
  reason = "access: Sign in with gh";
  await click(button("Try again"));
  expect(host.textContent).not.toContain(pr.title);
  expect(host.textContent).not.toContain("Signed in as ann");
  expect(host.textContent).toContain("Sign in with gh");
  expect(host.textContent).not.toContain("No open pull requests");
});

test("a pending retry keeps the previously failed snapshot labeled stale until success", async () => {
  let calls = 0;
  let complete!: (value: ReviewBoardSnapshot) => void;
  await render(async () => {
    if (++calls === 1) return snapshot([pr]);
    if (calls === 2) throw new Error("unavailable: GitHub timed out");
    return new Promise(resolve => { complete = resolve; });
  });
  await click(button("Refresh pull requests"));
  await click(button("Try again"));
  expect(host.textContent).toContain("Last available snapshot");
  expect(host.textContent).toContain(pr.title);
  await act(async () => complete(snapshot([pr])));
  expect(host.textContent).toContain("Synced");
  expect(host.textContent).not.toContain("Last available snapshot");
});

test("a late response for the previous project cannot replace the current one", async () => {
  let finish!: (snapshot: ReviewBoardSnapshot) => void;
  const old = new Promise<ReviewBoardSnapshot>((resolve) => { finish = resolve; });
  const load: typeof fetchReviewBoard = (cwd) => cwd === "/old" ? old : Promise.resolve(snapshot([{ ...pr, title: "Current project PR" }]));
  const key = ++renderKey;
  await render(load, "/old", key);
  await render(load, "/new", key);
  await act(async () => { finish(snapshot([pr])); });
  expect(host.textContent).toContain("Current project PR");
  expect(host.textContent).not.toContain(pr.title);
});

test("can select the connected upstream when the default repository is inaccessible", async () => {
  const load: typeof fetchReviewBoard = async (_cwd, _state, repo) => {
    if (!repo) throw new Error("access: No access to default origin");
    return { ...snapshot([pr]), repo, repositories: ["mine/fork", "org/repo"] };
  };
  await render(load, "/fork", ++renderKey, async () => ["mine/fork", "org/repo"]);
  const selector = host.querySelector<HTMLSelectElement>('select[aria-label="Base repository"]')!;
  await act(async () => {
    selector.value = "org/repo";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.textContent).toContain(pr.title);
  expect(host.textContent).not.toContain("No access to default origin");
});

test("a denied detail read evicts the private board and invalidates an in-flight list refresh", async () => {
  let finish!: (value: ReviewBoardSnapshot) => void;
  let calls = 0;
  const load: typeof fetchReviewBoard = async () => {
    if (++calls === 1) return snapshot([pr]);
    return new Promise((resolve) => { finish = resolve; });
  };
  await render(load, "/private", ++renderKey, async () => [], async () => { throw new Error("access: Permission revoked"); });
  await click(button("Refresh pull requests"));
  await click(host.querySelector<HTMLButtonElement>(".review-card")!);
  expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  expect(host.textContent).toContain("Permission revoked");
  expect(host.textContent).not.toContain("Signed in as ann");
  expect(host.textContent).not.toContain(pr.title);
  await act(async () => { finish(snapshot([pr])); });
  expect(host.textContent).not.toContain(pr.title);
  expect(host.textContent).toContain("Permission revoked");
});

test("a changed GitHub account closes a filter dialog and removes the previous account's PR data", async () => {
  let finish!: (value: ReviewBoardSnapshot) => void;
  let calls = 0;
  await render(async () => {
    if (++calls === 1) return snapshot([pr]);
    return new Promise((resolve) => { finish = resolve; });
  });
  await click(button("Refresh pull requests"));
  await click(button("Filters"));
  expect(host.textContent).toContain("Filter pull requests");
  await act(async () => { finish({ ...snapshot([]), viewer: "new-account" }); });
  expect(host.textContent).not.toContain("Filter pull requests");
  expect(host.textContent).not.toContain(pr.title);
  expect(host.textContent).toContain("Signed in as new-account");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Search pull requests");
});

test("historical states are requested lazily and a merged pull request appears in Done", async () => {
  const scopes: string[] = [];
  const merged: ReviewCard = { ...pr, number: 301, state: "merged", title: "Merged colleague PR" };
  await render(async (_cwd, state) => {
    scopes.push(state);
    return snapshot(state === "open" ? [pr] : [pr, merged]);
  });
  await click(button("Filters"));
  await click(option("PR state", "Open"));
  await click(option("PR state", "Draft"));
  await click(option("PR state", "Merged"));
  await click(button("Apply filters"));
  expect(scopes).toEqual(["open", "merged"]);
  expect(host.querySelectorAll(".review-card")).toHaveLength(1);
  expect(host.querySelector('section[aria-label="Done"]')!.textContent).toContain("Merged colleague PR");
  expect(host.textContent).not.toContain(pr.title);
});

test("a board refresh started before a local launch preserves the live lane after the drawer closes", async () => {
  let finish!: (s: ReviewBoardSnapshot) => void;
  let calls = 0;
  const load: typeof fetchReviewBoard = async () => ++calls === 1 ? snapshot([pr]) : new Promise(resolve => { finish = resolve; });
  const loadDetail: typeof fetchReviewDetail = async () => ({ version: 1, repositoryId: "repo1", viewer: "ann",
    number: pr.number, headSha: pr.headSha, fetchedAt: pr.updatedAt, threads: [], reviews: [], comments: [], checks: [], warnings: [] });
  let finishLaunch!: () => void;
  const runCommand: typeof reviewRun = async (_cwd, _key, action) => {
    if (action.kind !== "status") await new Promise<void>(resolve => { finishLaunch = resolve; });
    return { version: 1, runs: action.kind === "status" ? [] : [{
    id: "1", state: "running", phase: "Reading", reviewerProgress: { wave: 3, planned: 4, finished: 2, sessions: [] }, baseSha: pr.baseSha, headSha: pr.headSha, source: "manual", reason: "",
    createdAt: pr.updatedAt, startedAt: pr.updatedAt, finishedAt: null, result: null,
  }] }; };
  await render(load, "/project", ++renderKey, undefined, loadDetail, runCommand);
  await click(button("Refresh pull requests"));
  await click(host.querySelector<HTMLButtonElement>(".review-card")!);
  await click(button("Start review"));
  await click(button("Close details"));
  await act(async () => finishLaunch());
  await act(async () => finish(snapshot([pr])));
  const tile = host.querySelector('section[aria-label="In review"] .review-card')!;
  expect(tile.textContent).toContain(pr.title);
  expect(tile.textContent).toContain("Wave 3");
  expect(tile.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("2");
  await click(button("List"));
  expect(host.querySelector("tbody")?.textContent).toContain("2 of 4 reviewers finished");
});

test("Review controls the schedule for the base repository and displays persisted PR activity", async () => {
  let state = watcherOff;
  const actions: ReviewWatcherAction[] = [];
  const watcher: typeof reviewWatcher = async (cwd, target, action) => {
    expect(cwd).toBe("/project");
    if (!target) return watcherOff;
    expect(target).toEqual({ repo: "org/repo", repositoryId: "repo1", viewer: "ann" });
    actions.push(action);
    if (action.kind === "enable") state = { ...state, state: "enabled", installed: true, intervalMinutes: action.intervalMinutes };
    if (action.kind === "pause") return { ...state, state: "paused", installed: false, events: [], historyAvailable: false };
    if (action.kind === "resume") state = { ...state, state: "enabled", installed: true, lastSuccessAt: null, lastError: null };
    return state;
  };
  let reads = 0;
  await render(async () => {
    reads++;
    return snapshot([{ ...pr, title: `Snapshot ${reads}` }]);
  }, "/project", ++renderKey, undefined, undefined, undefined, watcher);
  const refresh = button("Refresh pull requests");
  expect(refresh.textContent).toContain("Refresh");
  await click(refresh);
  expect(reads).toBe(2);
  expect(host.textContent).toContain("Snapshot 2");
  expect(actions.every(action => action.kind === "status")).toBe(true);
  await click(button("PR watcher · Off"));
  const changeMinutes = (n: string) => act(async () => {
    const input = host.querySelector<HTMLInputElement>('input[type="number"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, n);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await changeMinutes("0");
  expect(button("Enable watcher").disabled).toBe(true);
  await changeMinutes("7");
  await click(button("Enable watcher"));
  expect(actions.at(-1)).toEqual({ kind: "enable", intervalMinutes: 7 });
  expect(host.textContent).toContain("Every 7 minutes");
  expect(host.textContent).toContain("first complete poll");
  const at = "2026-11-19T02:15:00Z";
  state = { ...state, lastSuccessAt: at, lastAttemptAt: at, lastError: "Connection timed out",
    events: [{ kind: "push", at, number: 101, description: "New commits", headSha: "e" }] };
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain("#101 New commits");
  expect(host.querySelectorAll('time[datetime="' + at + '"]')).toHaveLength(3);
  expect(host.textContent).toContain("Connection timed out");
  await click(button("Pause watcher"));
  expect(host.textContent).toContain("fresh baseline");
  expect(host.textContent).toContain("Reconnect to GitHub to view PR activity.");
  expect(host.textContent).not.toContain("No changes recorded yet.");
  await click(button("Resume watcher"));
  expect(actions.at(-1)).toEqual({ kind: "resume" });
  await click(button("Close"));
  expect(button("PR watcher · Watching").disabled).toBe(false);
});

test("an access refusal while enabling the watcher evicts the private board", async () => {
  const watcher: typeof reviewWatcher = async (_cwd, _target, action) => {
    if (action.kind === "enable") throw new Error("access: GitHub access was revoked.");
    return watcherOff;
  };
  await render(async () => snapshot([pr]), "/project", ++renderKey, undefined, undefined, undefined, watcher);
  expect(host.textContent).toContain(pr.title);
  await click(button("PR watcher · Off"));
  await click(button("Enable watcher"));
  expect(host.textContent).toContain("GitHub access was revoked");
  expect(host.textContent).not.toContain(pr.title);
});

test("an offline board exposes the unique local pause control without revealing cached events or enabling schedules", async () => {
  const calls: string[] = [];
  await render(async () => { throw new Error("unavailable: No network"); }, "/project", ++renderKey, undefined, undefined, undefined,
    async (_cwd, target, action) => {
      expect(target).toBeNull();
      calls.push(action.kind);
      return { ...watcherOff, state: action.kind === "pause" ? "paused" : "enabled", installed: action.kind !== "pause",
        lastError: "Private repo name", events: [{ kind: "push", at: pr.updatedAt, number: 123, description: "Private commit", headSha: "f" }] };
    });
  await click(host.querySelector<HTMLButtonElement>('button[aria-label^="PR watcher"]')!);
  expect(host.textContent).not.toContain("Private");
  expect(host.textContent).not.toContain("Enable watcher");
  await click(button("Pause watcher"));
  expect(calls.at(-1)).toBe("pause");
  expect(host.textContent).not.toContain("Resume watcher");
});

test("a stale watcher read cannot undo a pause and changing account clears private watcher history", async () => {
  let account = "ann";
  let delay = false;
  let finish!: (s: ReviewWatcherSnapshot) => void;
  const enabled: ReviewWatcherSnapshot = { ...watcherOff, state: "enabled", installed: true,
    events: [{ kind: "push", at: pr.updatedAt, number: 101, description: "Ann's private event", headSha: "f" }] };
  await render(async () => ({ ...snapshot([pr]), viewer: account }), "/project", ++renderKey, undefined, undefined, undefined,
    async (_cwd, target, action) => {
      if (target?.viewer === "new-viewer") return watcherOff;
      if (action.kind === "pause") return { ...enabled, state: "paused", installed: false };
      if (delay) return new Promise(resolve => { finish = resolve; });
      return enabled;
    });
  await click(button("PR watcher · Watching"));
  delay = true;
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await click(button("Pause watcher"));
  await act(async () => finish(enabled));
  expect(button("Resume watcher").disabled).toBe(false);
  expect(host.textContent).toContain("Ann's private event");
  account = "new-viewer";
  await click(button("Close"));
  await click(button("Refresh pull requests"));
  await click(button("PR watcher · Off"));
  expect(host.textContent).not.toContain("Ann's private event");
});

const automationRule: ReviewRule = { id: "rule-1", name: "Team changes", enabled: true, event: "review_requested", author: "",
  assignee: "", reviewer: "org/team", requireGreen: true, budgetMinutes: 15, budgetTokens: 50000 };

function rulesBackend(rules: ReviewRule[]) {
  let state: ReviewRuleSnapshot = { version: 1, choice: { mode: "project" }, rules, activity: [] };
  const actions: ReviewRuleAction[] = [];
  const command: typeof reviewRules = async (_cwd, key, action) => {
    expect(key).toEqual({ repo: "org/repo", repositoryId: "repo1", viewer: "ann" });
    actions.push(action);
    if (action.kind === "save") state = { ...state, rules: [...state.rules.filter(r => r.id !== action.rule.id), action.rule] };
    if (action.kind === "delete") state = { ...state, rules: state.rules.filter(r => r.id !== action.id) };
    if (action.kind === "mode") state = { ...state, choice: action.choice };
    return state;
  };
  return { actions, command };
}

test("project rule previews its scope and budgets, can be disabled, edited and deleted", async () => {
  const backend = rulesBackend([]);
  await render(async () => snapshot([pr]), "/project", ++renderKey, undefined, undefined, undefined, watcherDisabled, backend.command);
  await click(button("Review rules"));
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(document.activeElement).toBe(dialog);
  dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(button("Close"));
  await click(button("New rule"));
  const field = (text: string) => Array.from(host.querySelectorAll("form label")).find(x => x.firstChild?.textContent === text)!.querySelector("input")!;
  const fill = (text: string, value: string) => act(async () => {
    const input = field(text);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(field("Token limit (optional)").value).toBe("");
  expect(field("Token limit (optional)").required).toBe(false);
  await fill("Rule name", "   ");
  await click(button("Save rule"));
  const name = field("Rule name");
  expect(document.activeElement).toBe(name);
  expect(name.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById(name.getAttribute("aria-describedby")!)?.textContent).toBe("Enter a rule name.");
  expect(backend.actions.some(action => action.kind === "save")).toBe(false);
  await fill("Rule name", automationRule.name);
  expect(name.hasAttribute("aria-invalid")).toBe(false);
  await click(button("Save rule"));
  expect(backend.actions.at(-1)).toMatchObject({ kind: "save", rule: { budgetTokens: null } });
  await click(button("Edit"));
  await fill("Requested reviewer", "org/team");
  await fill("Time limit (minutes)", "15");
  await fill("Token limit (optional)", "300000");
  expect(field("Token limit (optional)").checkValidity()).toBe(true);
  await fill("Token limit (optional)", "50000");
  expect(host.querySelector('[aria-label="Rule preview"]')?.textContent).toContain("org/team once CI passes for that commit");
  await click(button("Save rule"));
  const creation = backend.actions.at(-1);
  expect(creation?.kind).toBe("save");
  if (creation?.kind !== "save") throw new Error("rule save missing");
  expect(creation.rule.id.length).toBeGreaterThan(0);
  expect(creation.rule).toEqual({ ...automationRule, id: creation.rule.id });
  await click(button("Disable"));
  expect(backend.actions.at(-1)).toMatchObject({ kind: "save", rule: { enabled: false } });
  await click(button("Edit"));
  expect(field("Token limit (optional)").value).toBe("50000");
  await fill("Token limit (optional)", "");
  await fill("PR author", "jo");
  await click(button("Save rule"));
  expect(backend.actions.at(-1)).toMatchObject({ kind: "save", rule: { author: "jo", enabled: false, budgetTokens: null } });
  expect(host.textContent).toContain("No token limit");
  await click(button("Delete")); await click(button("Confirm delete"));
  expect(backend.actions.at(-1)?.kind).toBe("delete");
  expect(host.textContent).toContain("No automatic review rules");
});

test("PR mode pins an enabled rule, preserves manual launch and scopes its history to the open card", async () => {
  const backend = rulesBackend([automationRule]);
  const command: typeof reviewRules = async (...args) => ({ ...await backend.command(...args), activity: [
    { number: 101, at: pr.updatedAt, headSha: pr.headSha, reason: "Team changes is waiting for green CI", state: "waiting" },
    { number: 102, at: pr.updatedAt, headSha: pr.headSha, reason: "Unrelated PR reason", state: "ready" },
    { number: 101, at: pr.updatedAt, headSha: pr.headSha, reason: "Team changes linked to an earlier manual attempt", state: "linked", runId: "manual-run-id" },
  ]});
  const detail: typeof fetchReviewDetail = async () => ({ version: 1, number: pr.number, repo: "org/repo", viewer: "ann",
    repositoryId: "repo1", headSha: pr.headSha, fetchedAt: pr.updatedAt, comments: [], threads: [], reviews: [], checks: [], warnings: [] });
  await render(async () => snapshot([pr]), "/project", ++renderKey, undefined, detail, async () => ({ version: 1, runs: [] }), watcherDisabled, command);
  await click(host.querySelector<HTMLElement>(".review-card")!); await click(button("Automation"));
  const select = host.querySelector<HTMLSelectElement>(".pr-automation select")!;
  expect(select.value).toBe("project");
  expect(host.textContent).toContain("Team changes is waiting for green CI");
  expect(host.textContent).not.toContain("Unrelated PR reason");
  const linked = Array.from(host.querySelectorAll(".automation-history li")).find(row => row.textContent?.includes("earlier manual attempt"));
  expect(linked?.querySelector("strong")?.textContent).toBe("Linked");
  expect(linked?.textContent).toContain("Run manual-r");
  for (const value of ["auto/rule-1", "manual", "project"]) {
    await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await click(button("Save mode"));
    expect(backend.actions.at(-1)).toEqual({ kind: "mode", number: 101, choice: value === "auto/rule-1" ? { mode: "auto", ruleId: "rule-1" } : { mode: value } });
    expect(button("Start review").disabled).toBe(false);
  }
});

test("a rules dialog pending for a previous account cannot expose that account's rules or change repository state", async () => {
  let resolveRules!: (s: ReviewRuleSnapshot) => void;
  const old = () => new Promise<ReviewRuleSnapshot>(resolve => { resolveRules = resolve; });
  const board = snapshot([pr]);
  const load: typeof fetchReviewBoard = async () => ({ ...board });
  await render(load, "/project", ++renderKey, undefined, undefined, undefined, watcherDisabled, old);
  await click(button("Review rules"));
  expect(host.querySelector('[aria-label="Loading rules"]')).not.toBeNull();
  board.viewer = "other";
  await click(button("Refresh pull requests"));
  await act(async () => resolveRules({ version: 1, rules: [{ ...automationRule, name: "Previous account secret rule" }], choice: { mode: "project" }, activity: [] }));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.textContent).not.toContain("Previous account secret rule");
});

test("project tabs restore the selected repository and last snapshot after a disconnect, and evict on denied access", async () => {
  const key = ++renderKey;
  let problem = "";
  const load: typeof fetchReviewBoard = async (_cwd, _state, repo) => {
    if (problem) throw new Error(problem);
    return { ...snapshot([{ ...pr, title: repo === "org/upstream" ? "Upstream card" : "Fork card" }]), repo: repo ?? "org/fork", repositories: ["org/fork","org/upstream"] };
  };
  const show = (active: boolean) => act(async () => root.render(createElement(ReviewBoard, {
    key, cwd: "/project", flows: [], onOpenFlow: () => {}, active, load, watcherCommand: watcherDisabled, listRepositories: async () => [],
  })));
  await show(true);
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Base repository"]')!;
  await act(async () => { select.value = "org/upstream"; select.dispatchEvent(new Event("change", {bubbles: true})); });
  expect(host.textContent).toContain("Upstream card");
  await show(false);
  expect(host.textContent).not.toContain("Upstream card");
  problem = "unavailable: The dev bridge connection closed.";
  await show(true);
  expect(host.textContent).toContain("Upstream card");
  expect(host.textContent).toContain("Last available snapshot");
  expect(host.textContent).not.toContain("Fork card");
  problem = "access: Grant revoked";
  await click(button("Refresh pull requests"));
  await show(false);
  problem = "unavailable: offline";
  await show(true);
  expect(host.textContent).not.toContain("Upstream card");
});

test("a missing author has a named filter and consistent reason in board and list", async () => {
  await render(async () => snapshot([pr, {...pr, author:"", number:1002, title:"From a deleted account"}]));
  await click(button("Filters"));
  await click(option("Author","Unknown author"));
  await click(button("Apply filters"));
  expect(host.textContent).toContain("Author · Unknown author");
  expect(host.querySelectorAll(".review-card")).toHaveLength(1);
  expect(host.querySelector(".review-card")!.textContent).toContain("Unknown author");
  await click(button("List"));
  expect(host.querySelector("tbody")!.textContent).toContain("Unknown author");
});

test("marking a new addressed reply locally clears its board and list reason", async () => {
  const card = { ...pr, reviewers: [], decision: null, addressedReplyIds: ["reply-addr-test"] };
  const data = { version: 1 as const, viewer:"ann", repositoryId:"repo1", number:card.number,
    fetchedAt:pr.updatedAt, headSha:pr.headSha, comments:[{id:"reply-addr-test",author:"bob",own:false,body:"@ann ready",url:"",createdAt:pr.updatedAt}], reviews:[],threads:[],checks:[],warnings:[] };
  await render(async () => snapshot([card]), "/project", ++renderKey, undefined, async () => data, async () => ({version:1,runs:[]}));
  expect(host.querySelector('[aria-label="Needs attention"]')!.textContent).toContain("New reply to you");
  await click(host.querySelector<HTMLElement>(".review-card")!);
  await click(button("Mark 1 as read"));
  await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
  await click(button("Close details"));
  expect(host.querySelector('[aria-label="Open"]')!.textContent).toContain(pr.title);
  await click(button("List"));
  expect(host.querySelector("tbody")!.textContent).not.toContain("New reply to you");
});

test("an offline return from merged history restores only the earlier open query for this viewer", async () => {
  let offline = false;
  await render(async (_cwd, scope) => {
    if (offline) throw new Error("unavailable: network");
    return snapshot(scope === "open" ? [pr] : [{ ...pr, number: 203, state:"merged", title:"Old merged history" }]);
  });
  await click(button("Filters"));
  await click(option("PR state", "Open")); await click(option("PR state", "Draft")); await click(option("PR state","Merged"));
  await click(button("Apply filters"));
  expect(host.textContent).toContain("Old merged history");
  offline = true;
  await click(button("Clear filters"));
  expect(host.textContent).toContain("Last available snapshot");
  expect(host.textContent).toContain(pr.title);
  expect(host.textContent).not.toContain("Old merged history");
});

test("a refreshed-away drawer remains closed even if the same PR later returns", async () => {
  let cards = [pr];
  await render(async () => snapshot(cards), "/project", ++renderKey, undefined, async () => ({
    version: 1, viewer:"ann", repositoryId:"repo1", number: pr.number, headSha:pr.headSha, fetchedAt:pr.updatedAt,
    comments:[],reviews:[],threads:[],checks:[],warnings:[],
  }), async () => ({ version:1, runs:[] }));
  await click(host.querySelector<HTMLElement>(".review-card")!);
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  cards = [];
  await click(button("Refresh pull requests"));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  cards = [pr];
  await click(button("Refresh pull requests"));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

test("clearing filters preserves the independently entered search", async () => {
  await render(async () => snapshot([pr, { ...pr, number:102, title:"Another change" }]));
  const input = host.querySelector<HTMLInputElement>('[aria-label="Search pull requests"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "colleague");
    input.dispatchEvent(new Event("input", { bubbles:true }));
  });
  await click(button("Filters"));
  await click(option("Author","lee"));
  await click(button("Apply filters"));
  await click(button("Clear filters"));
  expect(input.value).toBe("colleague");
  expect(host.querySelectorAll(".review-card")).toHaveLength(1);
});

test("one board tick updates every active PR from scoped badges and access denial clears the board", async () => {
  const clock: Window = window;
  const schedule = clock.setTimeout;
  let tick: (() => unknown) | undefined;
  clock.setTimeout = (fn, ms, ...args) => {
    if (ms !== 6000 || typeof fn !== "function") return schedule.call(window, fn, ms, ...args);
    tick = () => fn(...args); return -77;
  };
  const live = (number: number) => ({ ...pr, number, localReview: {active:true, ready:false} });
  const cards = [live(101), live(102), { ...pr, number: 103 }];
  let polls = 0;
  try {
    await act(async () => { root.render(createElement(ReviewBoard, {
      key: ++renderKey, cwd: "/project", flows: [], onOpenFlow() {}, load: async () => snapshot(cards),
      watcherCommand: watcherDisabled,
      loadBadges: async (_cwd, key, subjects) => {
        polls++;
        expect(key).toEqual({ repo:"org/repo", viewer:"ann", repositoryId:"repo1" });
        if (polls > 1) throw Error("access: Repository access revoked.");
        expect(subjects.map(c => c.number)).toEqual([101,102]);
        return {version:1, ...key, cards:[
          {...subjects[0]!,localReview:{active:false,ready:true}},
          {...subjects[1]!,localReview:{active:true,ready:false,progress:{wave:2,planned:5,finished:3}}},
        ]};
      },
    })); });
    expect(typeof tick).toBe("function");
    await act(async () => { await tick!(); });
    expect(polls).toBe(1);
    expect(host.querySelector('[aria-label="Needs attention"]')!.textContent).toContain("#101");
    expect(host.querySelector('[aria-label="In review"]')!.textContent).toContain("#102");
    expect(host.textContent).toContain("3 of 5");
    await act(async () => { await tick!(); });
    expect(host.textContent).toContain("Repository access revoked");
    expect(host.textContent).not.toContain(pr.title);
  } finally { clock.setTimeout = schedule; }
});

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { ReviewRule, ReviewRuleAction, ReviewRuleSnapshot } from "../../../../src/review/review-rule-types";
import type { reviewRules } from "../platform/reviewRules";
import type { reviewWatcher, ReviewWatcherAction, ReviewWatcherSnapshot } from "../platform/reviewWatcher";
import type { reviewRun } from "../platform/reviewRuns";
import type { Root } from "react-dom/client";
import type { fetchReviewBoard, fetchReviewDetail, fetchReviewRepositories } from "../platform/review";
import { registerDom, unregisterDom } from "../test/dom";
import { readReviewFilters, reviewFilterKey, saveReviewFilters } from "./reviewFilterStorage";
import { markRepliesRead } from "./reviewReadState";
import { EMPTY_FILTERS, type Filters } from "./model";
import type { ReviewBoardSnapshot, ReviewCard } from "./types";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let ReviewBoard: typeof import("./ReviewBoard").ReviewBoard;
let badgesEqual: typeof import("./ReviewBoard").badgesEqual;
let renderKey = 0;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  // Imported after registerDom: DOMPurify reads the DOM globals at load time.
  ({ ReviewBoard, badgesEqual } = await import("./ReviewBoard"));
  host = document.createElement("div");
  document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
});

beforeEach(() => { localStorage.clear(); });

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
  const el = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
  if (!el) throw new Error("Missing button " + label);
  return el;
}
function option(group: string, name: string) {
  const fieldset = Array.from(document.body.querySelectorAll("fieldset")).find((f) => f.querySelector("legend")?.textContent === group);
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
  expect(document.body.querySelectorAll(".review-card")).toHaveLength(cards.length);
  await click(button("Filters"));
  await click(option("Author", "lee"));
  await click(option("Review requested from", "org/team"));
  await click(option("GitHub review decision", "Review required"));
  await click(option("Checks on head commit", "CI passed"));
  await click(button("Apply filters"));
  expect(Array.from(document.body.querySelectorAll(".review-card .flow-id"), id => id.textContent)).toEqual(["#101"]);
  await click(button("List"));
  expect(Array.from(document.body.querySelectorAll("tbody .flow-id"), id => id.textContent)).toEqual(["#101"]);
  await click(button("Clear filters"));
  expect(document.body.querySelectorAll("tbody tr")).toHaveLength(cards.length);
});

test("refresh failure preserves last available snapshot, access loss hides its cards and identity", async () => {
  let reason = "";
  await render(async () => {
    if (reason) throw new Error(reason);
    return snapshot([pr], ["Some checks unavailable"]);
  });
  expect(document.body.textContent).toContain("Partial sync");
  reason = "unavailable: GitHub timed out";
  await click(button("Refresh pull requests"));
  expect(document.body.textContent).toContain("Last available snapshot");
  expect(document.body.textContent).toContain(pr.title);
  reason = "access: Sign in with gh";
  await click(button("Try again"));
  expect(document.body.textContent).not.toContain(pr.title);
  expect(document.body.textContent).not.toContain("Signed in as ann");
  expect(document.body.textContent).toContain("Sign in with gh");
  expect(document.body.textContent).not.toContain("No open pull requests");
});

test("partial sync can be dismissed, reopened, and shown again for a new issue", async () => {
  let warnings = ["Some replies unavailable"];
  await render(async () => snapshot([pr], warnings));
  await click(button("Hide sync details"));
  expect(document.activeElement).toBe(button("Sync details"));
  expect(button("Sync details").getAttribute("aria-expanded")).toBe("false");
  await click(button("Refresh pull requests"));
  expect(document.body.textContent).not.toContain(warnings[0]!);
  await click(button("Sync details"));
  expect(document.body.textContent).toContain(warnings[0]!);
  await click(button("Hide sync details"));
  warnings = ["Some checks unavailable"];
  await click(button("Refresh pull requests"));
  expect(document.body.textContent).toContain(warnings[0]!);
  await click(button("Hide sync details"));
  warnings = [];
  await click(button("Refresh pull requests"));
  expect(document.body.textContent).toContain("Synced");
  warnings = ["Some checks unavailable"];
  await click(button("Refresh pull requests"));
  expect(document.body.textContent).toContain(warnings[0]!);
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
  expect(document.body.textContent).toContain("Last available snapshot");
  expect(document.body.textContent).toContain(pr.title);
  await act(async () => complete(snapshot([pr])));
  expect(document.body.textContent).toContain("Synced");
  expect(document.body.textContent).not.toContain("Last available snapshot");
});

test("a late response for the previous project cannot replace the current one", async () => {
  let finish!: (snapshot: ReviewBoardSnapshot) => void;
  const old = new Promise<ReviewBoardSnapshot>((resolve) => { finish = resolve; });
  const load: typeof fetchReviewBoard = (cwd) => cwd === "/old" ? old : Promise.resolve(snapshot([{ ...pr, title: "Current project PR" }]));
  const key = ++renderKey;
  await render(load, "/old", key);
  await render(load, "/new", key);
  await act(async () => { finish(snapshot([pr])); });
  expect(document.body.textContent).toContain("Current project PR");
  expect(document.body.textContent).not.toContain(pr.title);
});

test("can select the connected upstream when the default repository is inaccessible", async () => {
  const load: typeof fetchReviewBoard = async (_cwd, _state, repo) => {
    if (!repo) throw new Error("access: No access to default origin");
    return { ...snapshot([pr]), repo, repositories: ["mine/fork", "org/repo"] };
  };
  await render(load, "/fork", ++renderKey, async () => ["mine/fork", "org/repo"]);
  const selector = document.body.querySelector<HTMLSelectElement>('select[aria-label="Base repository"]')!;
  await act(async () => {
    selector.value = "org/repo";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.body.textContent).toContain(pr.title);
  expect(document.body.textContent).not.toContain("No access to default origin");
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
  await click(document.body.querySelector<HTMLButtonElement>(".review-card")!);
  expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  expect(document.body.textContent).toContain("Permission revoked");
  expect(document.body.textContent).not.toContain("Signed in as ann");
  expect(document.body.textContent).not.toContain(pr.title);
  await act(async () => { finish(snapshot([pr])); });
  expect(document.body.textContent).not.toContain(pr.title);
  expect(document.body.textContent).toContain("Permission revoked");
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
  expect(document.body.textContent).toContain("Filter pull requests");
  await act(async () => { finish({ ...snapshot([]), viewer: "new-account" }); });
  expect(document.body.textContent).not.toContain("Filter pull requests");
  expect(document.body.textContent).not.toContain(pr.title);
  expect(document.body.textContent).toContain("Signed in as new-account");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Search pull requests");
});

test("a changed GitHub account returns focus to search from the portaled PR watcher and Review rules dialogs", async () => {
  for (const opener of ["PR watcher · Off", "Review rules"]) {
    let finish!: (value: ReviewBoardSnapshot) => void;
    let calls = 0;
    await render(async () => {
      if (++calls === 1) return snapshot([pr]);
      return new Promise((resolve) => { finish = resolve; });
    }, "/project", ++renderKey, async () => [], undefined, undefined, async () => watcherOff,
    async () => ({ version: 1, rules: [], activity: [], subscriptions: [] }) as unknown as ReviewRuleSnapshot);
    await click(button("Refresh pull requests"));
    await click(button(opener));
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    await act(async () => { dialog.querySelector<HTMLElement>("button")!.focus(); });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => { finish({ ...snapshot([]), viewer: "new-account-" + opener.length }); });
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search pull requests");
  }
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
  expect(document.body.querySelectorAll(".review-card")).toHaveLength(1);
  expect(document.body.querySelector('section[aria-label="Done"]')!.textContent).toContain("Merged colleague PR");
  expect(document.body.textContent).not.toContain(pr.title);
});

test("the period filters the GitHub request and is saved for the repository", async () => {
  const cutoffs: (string | undefined)[] = [];
  await render(async (_cwd, _state, _repo, _signal, _viewer, since) => {
    cutoffs.push(since);
    return snapshot([pr]);
  });
  await click(button("Filters"));
  const period = document.body.querySelector<HTMLSelectElement>('[aria-label="PR updated within"]')!;
  await act(async () => {
    period.value = "7";
    period.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const expected = Date.now() - 7 * 86_400_000;
  await click(button("Apply filters"));
  expect(cutoffs[0]).toBeUndefined();
  expect(Math.abs(Date.parse(cutoffs.at(-1)!) - expected) < 5_000).toBe(true);
  expect(readReviewFilters(reviewFilterKey("/project", "repo1", "ann")).updatedWithin).toBe(7);
  expect(document.body.textContent).toContain("Updated · Last 7 days");
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
    id: "1", state: "running", phase: "Reading", reviewerProgress: { wave: 3, planned: 4, finished: 2, completed: 2, sessions: [] }, baseSha: pr.baseSha, headSha: pr.headSha, source: "manual", reason: "",
    createdAt: pr.updatedAt, startedAt: pr.updatedAt, finishedAt: null, result: null,
  }] }; };
  await render(load, "/project", ++renderKey, undefined, loadDetail, runCommand);
  await click(button("Refresh pull requests"));
  await click(document.body.querySelector<HTMLButtonElement>(".review-card")!);
  await click(button("Start review"));
  await click(button("Close details"));
  await act(async () => finishLaunch());
  await act(async () => finish(snapshot([pr])));
  const tile = document.body.querySelector('section[aria-label="In review"] .review-card')!;
  expect(tile.textContent).toContain(pr.title);
  expect(tile.textContent).toContain("Wave 3");
  expect(tile.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("50");
  await click(button("List"));
  expect(document.body.querySelector("tbody")?.textContent).toContain("2 of 4 assignments completed");
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
  expect(document.body.textContent).toContain("Snapshot 2");
  expect(actions.every(action => action.kind === "status")).toBe(true);
  await click(button("PR watcher · Off"));
  const changeMinutes = (n: string) => act(async () => {
    const input = document.body.querySelector<HTMLInputElement>('input[type="number"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, n);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await changeMinutes("0");
  expect(button("Enable watcher").disabled).toBe(true);
  await changeMinutes("7");
  await click(button("Enable watcher"));
  expect(actions.at(-1)).toEqual({ kind: "enable", intervalMinutes: 7 });
  expect(document.body.textContent).toContain("Every 7 minutes");
  expect(document.body.textContent).toContain("first complete poll");
  const at = "2026-11-19T02:15:00Z";
  state = { ...state, lastSuccessAt: at, lastAttemptAt: at, lastError: "Connection timed out",
    events: [{ kind: "push", at, number: 101, description: "New commits", headSha: "e" }] };
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("#101 New commits");
  expect(document.body.querySelectorAll('time[datetime="' + at + '"]')).toHaveLength(3);
  expect(document.body.textContent).toContain("Connection timed out");
  state = { ...state, lastError: null, recoveryWarning: "One earlier review could not be recovered." };
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(button("PR watcher · Watching").disabled).toBe(false);
  expect(document.body.textContent).toContain("One earlier review could not be recovered.");
  await click(button("Pause watcher"));
  expect(document.body.textContent).toContain("fresh baseline");
  expect(document.body.textContent).toContain("Reconnect to GitHub to view PR activity.");
  expect(document.body.textContent).not.toContain("No changes recorded yet.");
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
  expect(document.body.textContent).toContain(pr.title);
  await click(button("PR watcher · Off"));
  await click(button("Enable watcher"));
  expect(document.body.textContent).toContain("GitHub access was revoked");
  expect(document.body.textContent).not.toContain(pr.title);
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
  await click(document.body.querySelector<HTMLButtonElement>('button[aria-label^="PR watcher"]')!);
  expect(document.body.textContent).not.toContain("Private");
  expect(document.body.textContent).not.toContain("Enable watcher");
  await click(button("Pause watcher"));
  expect(calls.at(-1)).toBe("pause");
  expect(document.body.textContent).not.toContain("Resume watcher");
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
  expect(document.body.textContent).toContain("Ann's private event");
  account = "new-viewer";
  await click(button("Close"));
  await click(button("Refresh pull requests"));
  await click(button("PR watcher · Off"));
  expect(document.body.textContent).not.toContain("Ann's private event");
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

test("toolbar dialogs render under document.body so the board's containment cannot trap their scrim", async () => {
  const backend = rulesBackend([]);
  await render(async () => snapshot([pr]), "/project", ++renderKey, undefined, undefined, undefined, watcherDisabled, backend.command);
  const trapped = (dialog: Element | null) => !dialog || dialog.closest(".review-board") !== null || dialog.closest(".overlay")?.parentElement !== document.body;
  await click(button("Review rules"));
  expect(trapped(document.body.querySelector('[role="dialog"]'))).toBe(false);
  expect(document.body.querySelector('.review-board [role="dialog"]')).toBeNull();
  await click(button("Close"));
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  await click(button("PR watcher · Off"));
  expect(trapped(document.body.querySelector('[role="dialog"]'))).toBe(false);
  expect(document.body.querySelector('.review-board [role="dialog"]')).toBeNull();
  expect(button("PR watcher · Off").getAttribute("title")).toBe("PR watcher · Off");
});

test("project rule previews its scope and budgets, can be disabled, edited and deleted", async () => {
  const backend = rulesBackend([]);
  await render(async () => snapshot([pr]), "/project", ++renderKey, undefined, undefined, undefined, watcherDisabled, backend.command);
  await click(button("Review rules"));
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(document.activeElement).toBe(dialog);
  dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(button("Close"));
  await click(button("New rule"));
  const field = (text: string) => Array.from(document.body.querySelectorAll("form label")).find(x => x.firstChild?.textContent === text)!.querySelector("input")!;
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
  expect(document.body.querySelector('[aria-label="Rule preview"]')?.textContent).toContain("org/team once CI passes for that commit");
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
  expect(document.body.textContent).toContain("No token limit");
  await click(button("Delete")); await click(button("Confirm delete"));
  expect(backend.actions.at(-1)?.kind).toBe("delete");
  expect(document.body.textContent).toContain("No automatic review rules");
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
  await click(document.body.querySelector<HTMLElement>(".review-card")!); await click(button("Automation"));
  const select = document.body.querySelector<HTMLSelectElement>(".pr-automation select")!;
  expect(select.value).toBe("project");
  expect(document.body.textContent).toContain("Team changes is waiting for green CI");
  expect(document.body.textContent).not.toContain("Unrelated PR reason");
  const linked = Array.from(document.body.querySelectorAll(".automation-history li")).find(row => row.textContent?.includes("earlier manual attempt"));
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
  expect(document.body.querySelector('[aria-label="Loading rules"]')).not.toBeNull();
  board.viewer = "other";
  await click(button("Refresh pull requests"));
  await act(async () => resolveRules({ version: 1, rules: [{ ...automationRule, name: "Previous account secret rule" }], choice: { mode: "project" }, activity: [] }));
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).not.toContain("Previous account secret rule");
});

test("project tabs reuse prefetched cards until refresh and evict them on denied access", async () => {
  const key = ++renderKey;
  let problem = "";
  let reads = 0;
  const load: typeof fetchReviewBoard = async (_cwd, _state, repo) => {
    reads++;
    if (problem) throw new Error(problem);
    return { ...snapshot([{ ...pr, title: repo === "org/upstream" ? "Upstream card" : "Fork card" }]), repo: repo ?? "org/fork", repositories: ["org/fork","org/upstream"] };
  };
  const show = (active: boolean) => act(async () => root.render(createElement(ReviewBoard, {
    key, cwd: "/project", flows: [], onOpenFlow: () => {}, active, load, watcherCommand: watcherDisabled, listRepositories: async () => [],
  })));
  await show(false);
  expect(reads).toBe(1);
  await show(true);
  expect(reads).toBe(1);
  const select = document.body.querySelector<HTMLSelectElement>('select[aria-label="Base repository"]')!;
  await act(async () => { select.value = "org/upstream"; select.dispatchEvent(new Event("change", {bubbles: true})); });
  expect(document.body.textContent).toContain("Upstream card");
  await show(false);
  expect(document.body.textContent).not.toContain("Upstream card");
  problem = "unavailable: The dev bridge connection closed.";
  await show(true);
  expect(document.body.textContent).toContain("Upstream card");
  expect(reads).toBe(2);
  await click(button("Refresh pull requests"));
  expect(reads).toBe(3);
  expect(document.body.textContent).toContain("Last available snapshot");
  expect(document.body.textContent).not.toContain("Fork card");
  problem = "access: Grant revoked";
  await click(button("Refresh pull requests"));
  await show(false);
  problem = "unavailable: offline";
  await show(true);
  expect(document.body.textContent).not.toContain("Upstream card");
});

test("successful watcher ticks refresh cached cards in the background once per tick", async () => {
  const key = ++renderKey;
  let reads = 0;
  let state: ReviewWatcherSnapshot = { ...watcherOff, state: "enabled", installed: true };
  const watch = async () => state;
  const load = async () => snapshot([{ ...pr, title: "Card revision " + ++reads }]);
  const show = (active: boolean) => act(async () => root.render(createElement(ReviewBoard, {
    key, cwd: "/project", flows: [], onOpenFlow() {}, active, load, watcherCommand: watch,
  })));
  const readStatus = () => act(async () => { window.dispatchEvent(new Event("focus")); });
  await show(false);
  expect(reads).toBe(1);
  state = { ...state, lastSuccessAt: "2026-11-20T12:00:00Z" };
  await readStatus();
  await readStatus();
  expect(reads).toBe(2);
  await show(true);
  expect(document.body.textContent).toContain("Card revision 2");
  state = { ...state, state: "paused", lastSuccessAt: "2026-11-20T12:05:00Z" };
  await readStatus();
  expect(reads).toBe(2);
  await click(button("Refresh pull requests"));
  expect(document.body.textContent).toContain("Card revision 3");
});

test("a missing author has a named filter and consistent reason in board and list", async () => {
  await render(async () => snapshot([pr, {...pr, author:"", number:1002, title:"From a deleted account"}]));
  await click(button("Filters"));
  await click(option("Author","Unknown author"));
  await click(button("Apply filters"));
  expect(document.body.textContent).toContain("Author · Unknown author");
  expect(document.body.querySelectorAll(".review-card")).toHaveLength(1);
  expect(document.body.querySelector(".review-card")!.textContent).toContain("Unknown author");
  await click(button("List"));
  expect(document.body.querySelector("tbody")!.textContent).toContain("Unknown author");
});

test("marking a new addressed reply locally clears its board and list reason", async () => {
  const card = { ...pr, reviewers: [], decision: null, addressedReplyIds: ["reply-addr-test"] };
  const data = { version: 1 as const, viewer:"ann", repositoryId:"repo1", number:card.number,
    fetchedAt:pr.updatedAt, headSha:pr.headSha, comments:[{id:"reply-addr-test",author:"bob",own:false,body:"@ann ready",url:"",createdAt:pr.updatedAt}], reviews:[],threads:[],checks:[],warnings:[] };
  await render(async () => snapshot([card]), "/project", ++renderKey, undefined, async () => data, async () => ({version:1,runs:[]}));
  expect(document.body.querySelector('[aria-label="Needs attention"]')!.textContent).toContain("New reply to you");
  await click(document.body.querySelector<HTMLElement>(".review-card")!);
  await click(button("Mark 1 as read"));
  await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
  await click(button("Close details"));
  expect(document.body.querySelector('[aria-label="Open"]')!.textContent).toContain(pr.title);
  await click(button("List"));
  expect(document.body.querySelector("tbody")!.textContent).not.toContain("New reply to you");
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
  expect(document.body.textContent).toContain("Old merged history");
  offline = true;
  await click(button("Clear filters"));
  expect(document.body.textContent).toContain("Last available snapshot");
  expect(document.body.textContent).toContain(pr.title);
  expect(document.body.textContent).not.toContain("Old merged history");
});

test("details can be resized and stay closed if a removed PR later returns", async () => {
  let cards = [pr];
  await render(async () => snapshot(cards), "/project", ++renderKey, undefined, async () => ({
    version: 1, viewer:"ann", repositoryId:"repo1", number: pr.number, headSha:pr.headSha, fetchedAt:pr.updatedAt,
    comments:[],reviews:[],threads:[],checks:[],warnings:[],
  }), async () => ({ version:1, runs:[] }));
  await click(document.body.querySelector<HTMLElement>(".review-card")!);
  const panel = document.body.querySelector<HTMLElement>(".review-detail-panel")!;
  expect(panel.tagName).toBe("ASIDE");
  const divider = document.body.querySelector<HTMLElement>('[aria-label="Resize pull request details"]')!;
  await act(async () => { divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  expect(panel.style.width).toBe("528px");
  cards = [];
  await click(button("Refresh pull requests"));
  expect(document.body.querySelector(".review-detail-panel")).toBeNull();
  cards = [pr];
  await click(button("Refresh pull requests"));
  expect(document.body.querySelector(".review-detail-panel")).toBeNull();
});

test("clearing filters preserves the independently entered search", async () => {
  await render(async () => snapshot([pr, { ...pr, number:102, title:"Another change" }]));
  const input = document.body.querySelector<HTMLInputElement>('[aria-label="Search pull requests"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "colleague");
    input.dispatchEvent(new Event("input", { bubbles:true }));
  });
  await click(button("Filters"));
  await click(option("Author","lee"));
  await click(button("Apply filters"));
  await click(button("Clear filters"));
  expect(input.value).toBe("colleague");
  expect(document.body.querySelectorAll(".review-card")).toHaveLength(1);
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
          {...subjects[1]!,localReview:{active:true,ready:false,progress:{wave:2,planned:5,finished:3,completed:3}}},
        ]};
      },
    })); });
    expect(typeof tick).toBe("function");
    await act(async () => { await tick!(); });
    expect(polls).toBe(1);
    expect(document.body.querySelector('[aria-label="Needs attention"]')!.textContent).toContain("#101");
    expect(document.body.querySelector('[aria-label="In review"]')!.textContent).toContain("#102");
    expect(document.body.textContent).toContain("3 of 5");
    await act(async () => { await tick!(); });
    expect(document.body.textContent).toContain("Repository access revoked");
    expect(document.body.textContent).not.toContain(pr.title);
  } finally { clock.setTimeout = schedule; }
});

test("board and list expose GitHub state and pending requests separately and run the clicked revision", async () => {
  const other = { ...pr, number: 105, decision: "CHANGES_REQUESTED" as const, headSha: "other-head" };
  const starts: number[] = [];
  const run: typeof reviewRun = async (_cwd, target, action) => {
    if (action.kind === "start") {
      expect(target.viewer).toBe("ann");
      expect(target.repositoryId).toBe("repo1");
      expect(action.headSha).toBe(other.headSha);
      starts.push(target.number);
    }
    return { version: 1, runs: [] };
  };
  await render(async () => snapshot([pr, other]), "/project", ++renderKey, undefined, async (_cwd, _repo, number) => ({
    version: 1, viewer: "ann", repositoryId: "repo1", number, headSha: other.headSha,
    fetchedAt: pr.updatedAt, comments: [], reviews: [], threads: [], checks: [], warnings: [],
  }), run);
  for (const mode of ["Board", "List"]) {
    await click(button(mode));
    const tags = [...document.body.querySelectorAll(".review-tags")].find(node => node.textContent?.includes("Changes requested"));
    expect(Array.from(tags!.children, child => child.textContent)).toEqual(["Open", "Changes requested", "Review requested"]);
    await click(button("Run review for #105"));
    expect(button("Keryx review").getAttribute("aria-pressed")).toBe("true");
    expect(starts).toHaveLength(mode === "Board" ? 1 : 2);
    await click(button("Close details"));
  }
  expect(starts).toEqual([105, 105]);
});

test("an outdated review shows its short SHA and a Review again action that starts a review in board and list", async () => {
  const outdated = { ...pr, localReview: { active: false, ready: false, outdated: { headSha: "abcdef0123456", state: "completed" as const } } };
  for (const mode of ["Board", "List"]) {
    const calls: string[] = [];
    await render(async () => snapshot([outdated]), "/project", ++renderKey,
      undefined, async () => ({ version: 1, viewer: "ann", repositoryId: "repo1", number: pr.number,
        headSha: pr.headSha, fetchedAt: pr.updatedAt, comments: [], reviews: [], threads: [], checks: [], warnings: [] }),
      async (_cwd, _key, action) => { calls.push(action.kind); return { version: 1, runs: [] }; });
    await click(button(mode));
    expect(document.body.textContent).toContain("Outdated review · abcdef0");
    await click(button("Review again for #101"));
    expect(calls).toContain("start");
  }
});

test("an outdated review shows as a secondary line under the attention reason in board and list", async () => {
  const stale = { ...pr, localReview: { active: false, ready: false, outdated: { headSha: "abcdef0123456", state: "completed" as const } } };
  await render(async () => snapshot([stale]));
  for (const mode of ["Board", "List"]) {
    await click(button(mode));
    expect(document.body.textContent).toContain("Review requested");
    expect(document.body.querySelector(".review-note")?.textContent).toBe("Outdated review · abcdef0");
  }
});

test("a merged card with an outdated review shows its state as the reason and the outdated text as the note, in board and list", async () => {
  const merged: ReviewCard = { ...pr, number: 301, state: "merged", localReview: { active: false, ready: false, outdated: { headSha: "abcdef0123456", state: "completed" } } };
  await render(async (_cwd, state) => snapshot(state === "open" ? [] : [merged]));
  await click(button("Filters"));
  await click(option("PR state", "Open"));
  await click(option("PR state", "Draft"));
  await click(option("PR state", "Merged"));
  await click(button("Apply filters"));
  for (const mode of ["Board", "List"]) {
    await click(button(mode));
    expect(document.body.querySelector(".review-reason, .review-table td[title] > span:first-child")?.textContent).toBe("Merged");
    const notes = document.body.querySelectorAll(".review-note");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.textContent).toBe("Outdated review · abcdef0");
  }
});

test("an open card with no attention reason shows the outdated text once, as the reason, with no note, in board and list", async () => {
  const quiet = { ...pr, reviewers: [], decision: null, localReview: { active: false, ready: false, outdated: { headSha: "abcdef0123456", state: "completed" as const } } };
  await render(async () => snapshot([quiet]));
  for (const mode of ["Board", "List"]) {
    await click(button(mode));
    expect(document.body.querySelector(".review-note")).toBeNull();
    expect(document.body.textContent!.split("Outdated review · abcdef0")).toHaveLength(2);
    expect(document.body.querySelector(mode === "Board" ? ".review-reason" : ".review-table td[title] > span:first-child")?.textContent).toBe("Outdated review · abcdef0");
  }
});

test("a badge whose only change is the outdated review counts as changed", () => {
  const base = { active: false, ready: false };
  const a = { ...base, outdated: { headSha: "aaa", state: "completed" as const } };
  expect(badgesEqual(a, { ...a, outdated: { headSha: "aaa", state: "completed" } })).toBe(true);
  expect(badgesEqual(a, { ...a, outdated: { headSha: "bbb", state: "completed" } })).toBe(false);
  expect(badgesEqual(a, { ...a, outdated: { headSha: "aaa", state: "partial" } })).toBe(false);
  expect(badgesEqual(a, base)).toBe(false);
  expect(badgesEqual(base, a)).toBe(false);
});

test("opening a running review from its badge action only reads the run", async () => {
  const calls: string[] = [];
  await render(async () => snapshot([{ ...pr, localReview: { active: true, ready: false } }]), "/project", ++renderKey,
    undefined, async () => ({ version: 1, viewer: "ann", repositoryId: "repo1", number: pr.number,
      headSha: pr.headSha, fetchedAt: pr.updatedAt, comments: [], reviews: [], threads: [], checks: [], warnings: [] }),
    async (_cwd, _key, action) => { calls.push(action.kind); return { version: 1, runs: [] }; });
  await click(button("View review for #101"));
  expect(button("Keryx review").getAttribute("aria-pressed")).toBe("true");
  expect(calls).toEqual(["status"]);
});

test("applied filters survive cold board mounts within the verified project, repository and account", async () => {
  let viewer = "ann", repositoryId = "repo1";
  const scopes: string[] = [];
  const load: typeof fetchReviewBoard = async (_cwd, state) => {
    scopes.push(state);
    return { ...snapshot([pr, { ...pr, state: "merged", number: 303 }, { ...pr, number: 304, state: "merged", author: "bob" }]), viewer, repositoryId };
  };
  await render(load);
  await click(button("Filters"));
  await click(option("Author", "lee"));
  await click(option("PR state", "Open"));
  await click(option("PR state", "Draft"));
  await click(option("PR state", "Merged"));
  await click(button("Apply filters"));
  expect(scopes).toEqual(["open", "merged"]);

  scopes.length = 0;
  viewer = "ANN";
  await render(load);
  expect(scopes).toEqual(["open", "merged"]);
  expect([...document.body.querySelectorAll(".review-card .flow-id")].map(el => el.textContent)).toEqual(["#303"]);
  await click(button("Filters (2)"));
  await click(option("Author", "bob"));
  await click(button("Cancel"));

  viewer = "colleague";
  await render(load);
  expect(document.body.querySelector(".review-active-filters")).toBeNull();
  expect(document.body.querySelector(".review-card .flow-id")?.textContent).toBe("#101");
  viewer = "ann";
  repositoryId = "repo2";
  await render(load);
  expect(document.body.querySelector(".review-active-filters")).toBeNull();
  repositoryId = "repo1";
  await render(load, "/second-project");
  expect(document.body.querySelector(".review-active-filters")).toBeNull();

  await render(load);
  expect(document.body.querySelector(".review-active-filters")?.textContent).toContain("Author · lee");
  expect(document.body.querySelectorAll(".review-card")).toHaveLength(1);
  await click(button("Clear filters"));
  await render(load);
  expect(document.body.querySelector(".review-active-filters")).toBeNull();
  expect(document.body.querySelector(".review-card .flow-id")?.textContent).toBe("#101");
});

test("saved filters reject malformed data and unsupported versions and tolerate unavailable browser storage", () => {
  const key = reviewFilterKey("/project", "R", "ann");
  for (const value of ["broken", "null", '{"version":1,"filters":[]}', '{"version":2,"filters":{"author":["lee"]}}',
    '{"version":1,"filters":{"state":["future"]}}', '{"version":1,"filters":{"assignee":"lee"}}']) {
    localStorage.setItem(key, value);
    expect(readReviewFilters(key)).toEqual(EMPTY_FILTERS);
  }
  localStorage.setItem(key, JSON.stringify({ version: 1, filters: { author: ["lee", "lee"], ci: ["failed"] } }));
  expect(readReviewFilters(key)).toEqual({ ...EMPTY_FILTERS, author: ["lee"], ci: ["failed"] });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Storage unavailable"); } });
    expect(readReviewFilters(key)).toEqual(EMPTY_FILTERS);
    expect(() => saveReviewFilters(key, { ...EMPTY_FILTERS, author: ["lee"] })).not.toThrow();
  } finally { Object.defineProperty(globalThis, "localStorage", descriptor); }
});

test("filter editing waits for the first verified snapshot before restoring saved settings", async () => {
  const key = reviewFilterKey("/waiting", "repo1", "ann");
  saveReviewFilters(key, { ...EMPTY_FILTERS, author: ["lee"] });
  let resolve!: (value: ReviewBoardSnapshot) => void;
  await render(() => new Promise(r => { resolve = r; }), "/waiting");
  const filters = button("Filters");
  expect(filters.disabled).toBe(true);
  await click(filters);
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).not.toContain("Author · lee");

  await act(async () => resolve(snapshot([pr])));
  expect(document.body.textContent).toContain("Author · lee");
  const restored = button("Filters (1)");
  expect(restored.disabled).toBe(false);
  await click(restored);
  expect(option("Author", "lee").checked).toBe(true);
  await click(button("Cancel"));
});

test("a merged PR awaiting a Keryx answer stays actionable when the merged state is selected, from either view", async () => {
  const pending = { ...pr, state: "merged" as const,
    localReview: { active: true, ready: false, runState: "running" as const, awaitingAnswer: true as const } };
  const actions: string[] = [];
  const command: typeof reviewRun = async (_cwd, _key, action) => {
    actions.push(action.kind);
    return { version: 1, runs: [{
      id: "test-run", headSha: pr.headSha, baseSha: pr.baseSha, source: "manual", state: "running", phase: "Review",
      createdAt: pr.updatedAt, startedAt: pr.updatedAt, finishedAt: null, reason: "", result: null,
      pendingQuestion: { id: "scope", question: "Which scope?", options: [], allowFreeform: true },
    }] };
  };
  const detail: typeof fetchReviewDetail = async () => ({
    version: 1, viewer: "ann", repositoryId: "repo1", number: pr.number, headSha: pr.headSha,
    fetchedAt: pr.updatedAt, comments: [], reviews: [], threads: [], checks: [], warnings: [],
  });
  saveReviewFilters(reviewFilterKey("/project", "repo1", "ann"), { ...EMPTY_FILTERS, state: ["merged"] });
  for (const mode of ["Board", "List"]) {
    await render(async () => snapshot([pending]), "/project", ++renderKey, undefined, detail, command);
    await click(button(mode));
    if (mode === "Board") expect(document.body.querySelector('[aria-label="Needs attention"]')?.textContent).toContain("Awaiting your answer");
    else expect(document.body.querySelector("tbody")?.textContent).toContain("Awaiting your answer");
    await click(button("Answer question for #" + pr.number));
    expect(document.querySelector(".review-question")?.textContent).toContain("Which scope?");
  }
  expect(actions).not.toContain("start");
});

test("Review tab signal follows unfiltered open requests to the viewer and background watcher refreshes without extra reads", async () => {
  const key = ++renderKey;
  const seen: import("./ReviewBoard").ReviewTabIndicator[] = [];
  const notify = (value: import("./ReviewBoard").ReviewTabIndicator) => seen.push(value);
  const neutral: ReviewCard = { ...pr, reviewers: [], decision: "REVIEW_REQUIRED" };
  const mine: ReviewCard = { ...pr, reviewers: ["Ann"] };
  let cards = [neutral];
  let reads = 0;
  let failure = "";
  const load: typeof fetchReviewBoard = async () => {
    reads++;
    if (failure) throw Error(failure);
    return snapshot(cards);
  };
  let status: ReviewWatcherSnapshot = { ...watcherOff, state: "enabled", installed: true };
  const watch = async () => status;
  const show = (active: boolean, cwd = "/project", expectedViewer = "ann") => act(async () => root.render(createElement(ReviewBoard, {
    key, active, cwd, expectedViewer, flows: [], onOpenFlow() {}, load, watcherCommand: watch, onIndicatorChange: notify,
    listRepositories: async () => [],
  })));
  await show(false);
  expect(seen.at(-1)).toBe("watching");
  expect(reads).toBe(1);
  cards = [mine, { ...neutral, number: 999, author: "bob", title: "Unrequested PR" }];
  status = { ...status, lastSuccessAt: "2026-11-20T12:03:00Z" };
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(seen.at(-1)).toBe("attention");
  expect(reads).toBe(2);
  await show(true);
  await click(button("Filters"));
  await click(option("Author", "bob"));
  await click(button("Apply filters"));
  expect(document.body.querySelector(".review-card .flow-id")?.textContent).toBe("#999");
  expect(seen.at(-1)).toBe("attention");
  cards = [{ ...neutral, author: "ann", decision: "CHANGES_REQUESTED" }];
  await click(button("Refresh pull requests"));
  expect(seen.at(-1)).toBe("attention");
  cards = [{ ...mine, state: "merged" }, { ...neutral, state: "closed", author: "ann", decision: "CHANGES_REQUESTED" }];
  await click(button("Refresh pull requests"));
  expect(seen.at(-1)).toBe("watching");
  status = { ...status, state: "paused" };
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(seen.at(-1)).toBeNull();
  cards = [mine];
  await click(button("Refresh pull requests"));
  expect(seen.at(-1)).toBe("attention");
  failure = "access: Account is unavailable";
  await click(button("Refresh pull requests"));
  expect(seen.at(-1)).toBeNull();
  await show(false, "/other-project", "colleague");
  expect(seen.at(-1)).toBeNull();
});

test("the tab signal is attention only for requests, owned changes, unread replies or Keryx decisions concerning the viewer", async () => {
  const base: ReviewCard = { ...pr, reviewers: [], decision: null };
  async function signal(cards: ReviewCard[]) {
    const seen: import("./ReviewBoard").ReviewTabIndicator[] = [];
    await act(async () => root.render(createElement(ReviewBoard, {
      key: ++renderKey, cwd: "/signal", flows: [], onOpenFlow() {}, load: async () => snapshot(cards),
      watcherCommand: watcherDisabled, onIndicatorChange: value => seen.push(value),
    })));
    return seen.at(-1);
  }
  expect(await signal([{ ...base, reviewers: ["bob"] }])).toBeNull();
  expect(await signal([{ ...base, reviewers: ["org/team"] }])).toBeNull();
  expect(await signal([{ ...base, decision: "CHANGES_REQUESTED" }])).toBeNull();
  expect(await signal([{ ...base, localReview: { active: true, ready: false } }])).toBeNull();
  expect(await signal([{ ...base, reviewers: ["bob", "ANN"] }])).toBe("attention");
  expect(await signal([{ ...base, author: "Ann", decision: "CHANGES_REQUESTED" }])).toBe("attention");
  expect(await signal([{ ...base, author: "ann", decision: "REVIEW_REQUIRED" }])).toBeNull();
  expect(await signal([{ ...base, localReview: { active: true, ready: false, awaitingAnswer: true } }])).toBe("attention");
  expect(await signal([{ ...base, localReview: { active: false, ready: true, publicationPending: true } }])).toBe("attention");
  expect(await signal([{ ...base, state: "merged", reviewers: ["ann"] }])).toBeNull();
  expect(await signal([{ ...base, addressedReplyIds: ["unread-1"] }])).toBe("attention");
  markRepliesRead("ann", "repo1", base.number, ["unread-1"]);
  expect(await signal([{ ...base, addressedReplyIds: ["unread-1"] }])).toBeNull();
});

test("a card-only refresh does not drop the tab signal of a PR whose only reason is a carried unread reply", async () => {
  const base: ReviewCard = { ...pr, reviewers: [], decision: null };
  let cards: ReviewCard[] = [{ ...base, addressedReplyIds: ["carried-1"] }];
  const seen: import("./ReviewBoard").ReviewTabIndicator[] = [];
  await act(async () => root.render(createElement(ReviewBoard, {
    key: ++renderKey, cwd: "/carry", flows: [], onOpenFlow() {}, load: async () => snapshot(cards),
    watcherCommand: watcherDisabled, onIndicatorChange: value => seen.push(value),
  })));
  expect(seen.at(-1)).toBe("attention");
  const before = seen.length;
  cards = [base];
  await click(button("Refresh pull requests"));
  expect(seen.slice(before).filter(value => value !== "attention")).toEqual([]);
  expect(seen.at(-1)).toBe("attention");
});

test("a request handled after the load stays out of the tab signal when the scope switches to a historical view", async () => {
  const card: ReviewCard = { ...pr, number: 481, reviewers: [], decision: null, addressedReplyIds: ["handled-1"] };
  const other: ReviewCard = { ...pr, number: 482, reviewers: ["ann"], decision: null };
  let mergedCards: ReviewCard[] = [];
  const indicators: import("./ReviewBoard").ReviewTabIndicator[] = [];
  const load: typeof fetchReviewBoard = async (_cwd, scope) => snapshot(scope === "merged" ? mergedCards : [card, other]);
  await act(async () => root.render(createElement(ReviewBoard, {
    key: ++renderKey, cwd: "/handled-test", flows: [], onOpenFlow() {}, load, watcherCommand: watcherDisabled,
    onIndicatorChange: indicator => indicators.push(indicator),
  })));
  expect(indicators.at(-1)).toBe("attention");
  await act(async () => { markRepliesRead("ann", "repo1", card.number, ["handled-1"]); await new Promise(resolve => setTimeout(resolve, 5)); });
  expect(indicators.at(-1)).toBe("attention");
  await click(button("Filters"));
  await click(option("PR state", "Open")); await click(option("PR state", "Draft")); await click(option("PR state", "Merged"));
  await click(button("Apply filters"));
  expect(indicators.at(-1)).toBe("attention");
  // Only the still-pending request is left in the set: observing it as merged clears the tab signal.
  mergedCards = [{ ...other, state: "merged" }];
  await click(button("Refresh pull requests"));
  expect(indicators.at(-1)).toBeNull();
});

test("saved historical filters on the first load still seed the tab signal from the open pull requests", async () => {
  saveReviewFilters(reviewFilterKey("/seed-test", "repo1", "ann"), { ...EMPTY_FILTERS, state: ["merged"] });
  const mine: ReviewCard = { ...pr, reviewers: ["ann"], decision: null };
  const indicators: import("./ReviewBoard").ReviewTabIndicator[] = [];
  const load: typeof fetchReviewBoard = async (_cwd, scope) => snapshot(scope === "merged" ? [] : [mine]);
  await act(async () => root.render(createElement(ReviewBoard, {
    key: ++renderKey, cwd: "/seed-test", flows: [], onOpenFlow() {}, load, watcherCommand: watcherDisabled,
    onIndicatorChange: indicator => indicators.push(indicator),
  })));
  expect(indicators.at(-1)).toBe("attention");
});

test("recovery from access loss on a historical view seeds the tab signal from the open pull requests", async () => {
  saveReviewFilters(reviewFilterKey("/lost-test", "repo1", "ann"), { ...EMPTY_FILTERS, state: ["merged"] });
  const mine: ReviewCard = { ...pr, reviewers: ["ann"], decision: null };
  let failure = "";
  const scopes: string[] = [];
  const indicators: import("./ReviewBoard").ReviewTabIndicator[] = [];
  const load: typeof fetchReviewBoard = async (_cwd, scope) => {
    scopes.push(scope);
    if (failure) throw new Error(failure);
    return snapshot(scope === "merged" ? [] : [mine]);
  };
  await act(async () => root.render(createElement(ReviewBoard, {
    key: ++renderKey, cwd: "/lost-test", flows: [], onOpenFlow() {}, load, watcherCommand: watcherDisabled,
    onIndicatorChange: indicator => indicators.push(indicator),
  })));
  expect(indicators.at(-1)).toBe("attention");
  failure = "access: Grant revoked";
  await click(button("Refresh pull requests"));
  expect(indicators.at(-1)).toBeNull();
  failure = "";
  scopes.length = 0;
  await click(button("Refresh pull requests"));
  expect(indicators.at(-1)).toBe("attention");
  expect(scopes).toEqual(["merged", "open"]);
  // Once seeded, a later historical load issues no extra open request.
  scopes.length = 0;
  await click(button("Refresh pull requests"));
  expect(scopes).toEqual(["merged"]);
  expect(indicators.at(-1)).toBe("attention");
});

const HIDDEN_HINT = "Show 1 waiting on you — clears filters and search";
const hint = () => document.body.querySelector(".review-hidden-attention") as HTMLButtonElement | null;
const mineLee: ReviewCard = { ...pr, number: 601, author: "lee", reviewers: ["ann"], decision: null };
const otherBob: ReviewCard = { ...pr, number: 602, author: "bob", reviewers: [], decision: null };

test("a pull request waiting on the viewer that the filters hide is announced in the toolbar and a click reveals it", async () => {
  saveReviewFilters(reviewFilterKey("/hidden-test", "repo1", "ann"), { ...EMPTY_FILTERS, author: ["bob"] });
  const indicators: import("./ReviewBoard").ReviewTabIndicator[] = [];
  await act(async () => root.render(createElement(ReviewBoard, {
    key: ++renderKey, cwd: "/hidden-test", flows: [], onOpenFlow() {}, load: async () => snapshot([mineLee, otherBob]), watcherCommand: watcherDisabled,
    onIndicatorChange: indicator => indicators.push(indicator),
  })));
  expect(indicators.at(-1)).toBe("attention");
  expect(Array.from(document.body.querySelectorAll(".review-card .flow-id"), id => id.textContent)).toEqual(["#602"]);
  expect(hint()?.textContent?.trim()).toContain("1");
  expect(hint()?.getAttribute("aria-label")).toBe(HIDDEN_HINT);
  expect(hint()?.getAttribute("title")).toBe(HIDDEN_HINT);
  await click(button(HIDDEN_HINT));
  expect(Array.from(document.body.querySelectorAll(".review-card .flow-id"), id => id.textContent).sort()).toEqual(["#601", "#602"]);
  expect(hint()).toBeNull();
  expect(indicators.at(-1)).toBe("attention");
});

test("no hidden-attention hint while every pull request waiting on the viewer is in the list", async () => {
  await render(async () => snapshot([mineLee, otherBob]));
  expect(hint()).toBeNull();
  saveReviewFilters(reviewFilterKey("/visible-test", "repo1", "ann"), { ...EMPTY_FILTERS, author: ["lee"] });
  await render(async () => snapshot([mineLee, otherBob]), "/visible-test");
  expect(Array.from(document.body.querySelectorAll(".review-card .flow-id"), id => id.textContent)).toEqual(["#601"]);
  expect(hint()).toBeNull();
});

test("the count carries its unit as text, not as a name on a role-less span", async () => {
  await render(async () => snapshot([mineLee, otherBob]));
  const count = document.body.querySelector(".count-label") as HTMLElement;
  expect(count.hasAttribute("title")).toBe(false);
  expect(count.hasAttribute("aria-label")).toBe(false);
  expect(count.textContent?.replace(/\s+/g, " ").trim()).toBe("2 pull requests");
});

const typeSearch = (value: string) => act(async () => {
  const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Search pull requests"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const shownNumbers = () => Array.from(document.body.querySelectorAll(".review-card .flow-id"), id => id.textContent).sort();

test("a request hidden only by the search is counted; the hint clears the search, saves the default filters and keeps focus", async () => {
  const key = reviewFilterKey("/hint-search-test", "repo1", "ann");
  saveReviewFilters(key, { ...EMPTY_FILTERS, ci: ["passed"] });
  await act(async () => root.render(createElement(ReviewBoard, {
    key: ++renderKey, cwd: "/hint-search-test", flows: [], onOpenFlow() {}, load: async () => snapshot([mineLee, otherBob]), watcherCommand: watcherDisabled,
  })));
  expect(hint()).toBeNull();
  await typeSearch("602");
  expect(shownNumbers()).toEqual(["#602"]);
  expect(hint()?.getAttribute("aria-label")).toBe(HIDDEN_HINT);
  expect(hint()?.getAttribute("aria-label")).toContain("clears filters and search");
  expect(hint()?.querySelector(".toolbar-label")?.textContent).toBe("Show 1 waiting on you");
  expect(hint()?.querySelector(".hint-short")?.textContent).toBe("1 hidden");
  await click(hint()!);
  expect(shownNumbers()).toEqual(["#601", "#602"]);
  expect(document.body.querySelector<HTMLInputElement>('input[aria-label="Search pull requests"]')!.value).toBe("");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Search pull requests");
  expect(readReviewFilters(key)).toEqual(EMPTY_FILTERS);
  expect(hint()).toBeNull();
});

test("a carried request outside a fresh historical view is counted and the hint's reset loads it; not on a failed refresh", async () => {
  saveReviewFilters(reviewFilterKey("/hint-history-test", "repo1", "ann"), { ...EMPTY_FILTERS, state: ["merged"] });
  let offline = false;
  await act(async () => root.render(createElement(ReviewBoard, {
    key: ++renderKey, cwd: "/hint-history-test", flows: [], onOpenFlow() {}, watcherCommand: watcherDisabled,
    load: async (_cwd, scope) => {
      if (offline) throw new Error("unavailable: offline");
      return snapshot(scope === "merged" ? [] : [mineLee]);
    },
  })));
  expect(shownNumbers()).toEqual([]);
  expect(hint()?.getAttribute("aria-label")).toBe(HIDDEN_HINT);
  // While offline the reset would most likely load nothing: only cards of the shown snapshot are counted.
  offline = true;
  await click(button("Refresh pull requests"));
  expect(document.body.textContent).toContain("Last available snapshot");
  expect(hint()).toBeNull();
  offline = false;
  await click(button("Try again"));
  expect(hint()?.getAttribute("aria-label")).toBe(HIDDEN_HINT);
  await click(hint()!);
  expect(shownNumbers()).toEqual(["#601"]);
  expect(hint()).toBeNull();
});

test("no hint on a stale Open fallback for a carried request that no filter hides", async () => {
  saveReviewFilters(reviewFilterKey("/hint-stale-test", "repo1", "ann"), { ...EMPTY_FILTERS, updatedWithin: 7 });
  let offline = false;
  const indicators: import("./ReviewBoard").ReviewTabIndicator[] = [];
  const load: typeof fetchReviewBoard = async (_cwd, _scope, _repo, _signal, _viewer, updatedSince) => {
    if (offline) throw new Error("unavailable: offline");
    return snapshot(updatedSince ? [mineLee] : []);
  };
  await act(async () => root.render(createElement(ReviewBoard, {
    key: ++renderKey, cwd: "/hint-stale-test", flows: [], onOpenFlow() {}, load, watcherCommand: watcherDisabled,
    onIndicatorChange: indicator => indicators.push(indicator),
  })));
  // The period view carries #601; the cached Open snapshot from the first load predates it.
  expect(shownNumbers()).toEqual(["#601"]);
  offline = true;
  await click(button("Clear filters"));
  expect(document.body.textContent).toContain("Last available snapshot");
  expect(shownNumbers()).toEqual([]);
  expect(indicators.at(-1)).toBe("attention");
  expect(hint()).toBeNull();
});

const ann601: ReviewCard = { ...pr, number: 601, reviewers: ["ann"], decision: null };
const bob701: ReviewCard = { ...pr, number: 701, reviewers: ["bob"], decision: null };
const as = (viewer: string, cards: ReviewCard[]): ReviewBoardSnapshot => ({ ...snapshot(cards), viewer });
interface HeldLoad { scope: string; signal: AbortSignal; resolve: (value: ReviewBoardSnapshot) => void; reject: (cause: Error) => void }
type Answer = "answer" | "hold" | "fail";
/**
 * The account gh answers for and how each scope answers: at once, held for the test to settle inside act, or failing.
 * Every request's scope is recorded ("/period" marks a period view).
 */
async function scriptedBoard(cwd: string, saved: Record<string, Filters>) {
  for (const [login, filters] of Object.entries(saved)) saveReviewFilters(reviewFilterKey(cwd, "repo1", login), filters);
  const account = { viewer: "ann", merged: "answer" as Answer, open: "answer" as Answer };
  const calls: HeldLoad[] = [];
  const load: typeof fetchReviewBoard = (_cwd, scope, _repo, signal, _viewer, updatedSince) => new Promise((resolve, reject) => {
    calls.push({ scope: updatedSince ? scope + "/period" : scope, signal: signal!, resolve, reject });
    const mode = scope === "merged" ? account.merged : account.open;
    if (mode === "fail") reject(new Error("unavailable: offline"));
    else if (mode === "answer") resolve(as(account.viewer, scope === "merged" ? [] : account.viewer === "ann" ? [ann601] : [bob701]));
  });
  const indicators: import("./ReviewBoard").ReviewTabIndicator[] = [];
  await act(async () => root.render(createElement(ReviewBoard, {
    key: ++renderKey, cwd, flows: [], onOpenFlow() {}, load, watcherCommand: watcherDisabled,
    onIndicatorChange: indicator => indicators.push(indicator),
  })));
  let seen = 0;
  /** Scopes requested since the previous call. */
  const requested = () => calls.slice(seen, seen = calls.length).map(call => call.scope);
  const held = (scope: string) => calls.filter(call => call.scope === scope).at(-1)!;
  return { account, indicators, requested, held };
}
const MERGED: Filters = { ...EMPTY_FILTERS, state: ["merged"] };

test("an account switch on a historical view costs two requests whether the new account's saved view is historical or open", async () => {
  const seeding = await scriptedBoard("/cost-seed-test", { ann: MERGED, bob: MERGED });
  expect(seeding.requested()).toEqual(["open", "merged"]);
  seeding.account.viewer = "bob";
  await click(button("Refresh pull requests"));
  expect(seeding.requested()).toEqual(["merged", "open"]);
  expect(seeding.indicators.at(-1)).toBe("attention");

  // Bob has no saved filters: the reset to the Open view loads every open PR, so no separate seed is asked for.
  const opening = await scriptedBoard("/cost-open-test", { ann: MERGED });
  expect(opening.requested()).toEqual(["open", "merged"]);
  opening.account.viewer = "bob";
  await click(button("Refresh pull requests"));
  expect(opening.requested()).toEqual(["merged", "open"]);
  expect(document.body.textContent).toContain("Signed in as bob");
  expect(opening.indicators.at(-1)).toBe("attention");
});

test("a refresh of a historical view while the seed is in flight keeps that seed", async () => {
  const board = await scriptedBoard("/stable-seed-test", { ann: MERGED, bob: MERGED });
  board.requested();
  board.account.viewer = "bob";
  board.account.open = "hold";
  await click(button("Refresh pull requests"));
  expect(board.requested()).toEqual(["merged", "open"]);
  const seed = board.held("open");
  await click(button("Refresh pull requests"));
  expect(board.requested()).toEqual(["merged"]);
  expect(seed.signal.aborted).toBe(false);
  await act(async () => seed.resolve(as("bob", [bob701])));
  expect(board.indicators.at(-1)).toBe("attention");
});

test("a seed in flight when the viewer opens the Open view is aborted, and its late answer changes nothing", async () => {
  const board = await scriptedBoard("/race-open-test", { ann: MERGED, bob: MERGED });
  board.requested();
  board.account.viewer = "bob";
  board.account.open = "hold";
  await click(button("Refresh pull requests"));
  const seed = board.held("open");
  await click(button("Clear filters"));
  expect(board.requested()).toEqual(["merged", "open", "open"]);
  const main = board.held("open");
  await act(async () => main.resolve(as("bob", [])));
  expect(seed.signal.aborted).toBe(true);
  expect(board.indicators.at(-1)).toBeNull();
  // #701 was merged between the two requests: the seed's older answer must not bring it back.
  await act(async () => seed.resolve(as("bob", [bob701])));
  expect(board.indicators.at(-1)).toBeNull();
  expect(board.requested()).toEqual([]);
});

test("a seed answered in the same tick as the open load that replaced the set is dropped", async () => {
  const board = await scriptedBoard("/race-replace-test", { ann: MERGED, bob: MERGED });
  board.account.viewer = "bob";
  board.account.open = "hold";
  await click(button("Refresh pull requests"));
  const seed = board.held("open");
  await click(button("Clear filters"));
  const main = board.held("open");
  await act(async () => { main.resolve(as("bob", [])); seed.resolve(as("bob", [bob701])); });
  expect(board.indicators.at(-1)).toBeNull();
});

test("a seed in flight across an account change brings nothing of the earlier account", async () => {
  const board = await scriptedBoard("/race-account-test", { ann: MERGED, bob: MERGED });
  board.account.viewer = "bob";
  board.account.open = "hold";
  await click(button("Refresh pull requests"));
  const bobSeed = board.held("open");
  // Back to ann: her historical load and bob's seed land in the same tick.
  board.account.viewer = "ann";
  board.account.merged = "hold";
  board.requested();
  await click(button("Refresh pull requests"));
  const merged = board.held("merged");
  await act(async () => { merged.resolve(as("ann", [])); bobSeed.resolve(as("bob", [bob701])); });
  expect(bobSeed.signal.aborted).toBe(true);
  expect(document.body.textContent).toContain("Signed in as ann");
  expect(board.requested()).toEqual(["merged", "open"]);
  await act(async () => board.held("open").reject(new Error("unavailable: offline")));
  expect(board.indicators.at(-1)).toBeNull();
});

test("returning to an account seeded before a switch seeds it again when the other account's seed failed", async () => {
  const board = await scriptedBoard("/return-test", { ann: MERGED, bob: MERGED });
  board.requested();
  board.account.viewer = "bob";
  board.account.open = "fail";
  await click(button("Refresh pull requests"));
  expect(board.requested()).toEqual(["merged", "open"]);
  expect(board.indicators.at(-1)).toBeNull();
  board.account.viewer = "ann";
  board.account.open = "answer";
  await click(button("Refresh pull requests"));
  expect(board.requested()).toEqual(["merged", "open"]);
  expect(document.body.textContent).toContain("Signed in as ann");
  expect(board.indicators.at(-1)).toBe("attention");
});

test("a failed seed is asked for exactly once more by the next historical load", async () => {
  const board = await scriptedBoard("/seed-retry-test", { ann: MERGED, bob: MERGED });
  board.requested();
  board.account.viewer = "bob";
  board.account.open = "fail";
  await click(button("Refresh pull requests"));
  expect(board.requested()).toEqual(["merged", "open"]);
  await click(button("Refresh pull requests"));
  expect(board.requested()).toEqual(["merged", "open"]);
  board.account.open = "answer";
  await click(button("Refresh pull requests"));
  expect(board.requested()).toEqual(["merged", "open"]);
  expect(board.indicators.at(-1)).toBe("attention");
  await click(button("Refresh pull requests"));
  expect(board.requested()).toEqual(["merged"]);
});

test("a seed answered for another account is dropped and the next historical load asks again", async () => {
  const board = await scriptedBoard("/seed-other-test", { ann: MERGED, bob: MERGED });
  board.account.viewer = "bob";
  board.account.open = "hold";
  await click(button("Refresh pull requests"));
  const seed = board.held("open");
  await act(async () => seed.resolve(as("ann", [ann601])));
  expect(board.indicators.at(-1)).toBeNull();
  board.account.open = "answer";
  board.requested();
  await click(button("Refresh pull requests"));
  expect(board.requested()).toEqual(["merged", "open"]);
  expect(board.indicators.at(-1)).toBe("attention");
});

test("a reply read after a failed refresh stays out of the tab signal on a historical view", async () => {
  const card: ReviewCard = { ...pr, number: 801, reviewers: [], decision: null, addressedReplyIds: ["read-later"] };
  let offline = false;
  const indicators: import("./ReviewBoard").ReviewTabIndicator[] = [];
  const load: typeof fetchReviewBoard = async (_cwd, scope) => {
    if (offline && scope === "open") throw new Error("unavailable: offline");
    return snapshot(scope === "merged" ? [] : [card]);
  };
  await act(async () => root.render(createElement(ReviewBoard, {
    key: ++renderKey, cwd: "/read-offline-test", flows: [], onOpenFlow() {}, load, watcherCommand: watcherDisabled,
    onIndicatorChange: indicator => indicators.push(indicator),
  })));
  expect(indicators.at(-1)).toBe("attention");
  offline = true;
  await click(button("Refresh pull requests"));
  expect(document.body.textContent).toContain("Last available snapshot");
  // The kept snapshot is this scope's own, not a cached fallback: what is seen in it still writes back.
  await act(async () => { markRepliesRead("ann", "repo1", card.number, ["read-later"]); await new Promise(resolve => setTimeout(resolve, 5)); });
  expect(indicators.at(-1)).toBeNull();
  await click(button("Filters"));
  await click(option("PR state", "Open")); await click(option("PR state", "Draft")); await click(option("PR state", "Merged"));
  await click(button("Apply filters"));
  expect(indicators.at(-1)).toBeNull();
});

test("an open seed answered for another account does not enter the tab signal", async () => {
  saveReviewFilters(reviewFilterKey("/seed-identity-test", "repo1", "ann"), { ...EMPTY_FILTERS, state: ["merged"] });
  let openViewer = "ann";
  let failure = "";
  const bobRequest: ReviewCard = { ...pr, number: 202, reviewers: ["bob"], decision: null };
  const indicators: import("./ReviewBoard").ReviewTabIndicator[] = [];
  const load: typeof fetchReviewBoard = async (_cwd, scope) => {
    if (failure) throw new Error(failure);
    if (scope === "merged") return snapshot([]);
    return { ...snapshot(openViewer === "bob" ? [bobRequest] : []), viewer: openViewer };
  };
  await act(async () => root.render(createElement(ReviewBoard, {
    key: ++renderKey, cwd: "/seed-identity-test", flows: [], onOpenFlow() {}, load, watcherCommand: watcherDisabled,
    onIndicatorChange: indicator => indicators.push(indicator),
  })));
  expect(indicators.at(-1)).toBeNull();
  failure = "access: Grant revoked";
  await click(button("Refresh pull requests"));
  failure = "";
  // The historical load answers for ann, the open seed that follows answers for bob.
  openViewer = "bob";
  await click(button("Refresh pull requests"));
  expect(document.body.textContent).toContain("Signed in as ann");
  expect(indicators.at(-1)).toBeNull();
});

test("an account change seen on a historical view seeds the tab signal from the new account's open pull requests only", async () => {
  let viewer = "ann";
  for (const login of ["ann", "bob"]) saveReviewFilters(reviewFilterKey("/switch-test", "repo1", login), { ...EMPTY_FILTERS, state: ["merged"] });
  const annRequest: ReviewCard = { ...pr, number: 101, reviewers: ["ann", "bob"], decision: null };
  const bobRequest: ReviewCard = { ...pr, number: 202, reviewers: ["bob"], decision: null };
  let merged: ReviewCard[] = [];
  const indicators: import("./ReviewBoard").ReviewTabIndicator[] = [];
  let openOffline = false;
  const load: typeof fetchReviewBoard = async (_cwd, scope) => {
    if (scope === "open" && openOffline) throw new Error("unavailable: offline");
    return { ...snapshot(scope === "merged" ? merged : viewer === "ann" ? [annRequest] : [bobRequest]), viewer };
  };
  await act(async () => root.render(createElement(ReviewBoard, {
    key: ++renderKey, cwd: "/switch-test", flows: [], onOpenFlow() {}, load, watcherCommand: watcherDisabled,
    onIndicatorChange: indicator => indicators.push(indicator),
  })));
  expect(indicators.at(-1)).toBe("attention");
  viewer = "bob";
  openOffline = true;
  await click(button("Refresh pull requests"));
  expect(document.body.textContent).toContain("Signed in as bob");
  // The open seed failed: ann's set must not stand in for bob's.
  expect(indicators.at(-1)).toBeNull();
  openOffline = false;
  await click(button("Refresh pull requests"));
  expect(indicators.at(-1)).toBe("attention");
  // Observing bob's request as merged leaves nothing: ann's #101, which also requests bob, was not carried over.
  merged = [{ ...bobRequest, state: "merged" }];
  await click(button("Refresh pull requests"));
  expect(indicators.at(-1)).toBeNull();
});

test("a cached snapshot shown after an unavailable error does not bring back a request seen as merged", async () => {
  const mine: ReviewCard = { ...pr, reviewers: ["ann"], decision: null };
  let offline = false;
  const indicators: import("./ReviewBoard").ReviewTabIndicator[] = [];
  const filtersButton = () => Array.from(document.body.querySelectorAll("button")).find(b => b.getAttribute("aria-label")?.startsWith("Filters"))!;
  const load: typeof fetchReviewBoard = async (_cwd, scope) => {
    if (scope === "open" && offline) throw new Error("unavailable: offline");
    return snapshot(scope === "merged" ? [{ ...mine, state: "merged" }] : scope === "closed" ? [] : [mine]);
  };
  await act(async () => root.render(createElement(ReviewBoard, {
    key: ++renderKey, cwd: "/stale-test", flows: [], onOpenFlow() {}, load, watcherCommand: watcherDisabled,
    onIndicatorChange: indicator => indicators.push(indicator),
  })));
  expect(indicators.at(-1)).toBe("attention");
  await click(filtersButton());
  await click(option("PR state", "Open")); await click(option("PR state", "Draft")); await click(option("PR state", "Merged"));
  await click(button("Apply filters"));
  expect(indicators.at(-1)).toBeNull();
  offline = true;
  await click(filtersButton());
  await click(option("PR state", "Merged")); await click(option("PR state", "Open"));
  await click(button("Apply filters"));
  expect(document.body.textContent).toContain("Last available snapshot");
  await click(filtersButton());
  await click(option("PR state", "Open")); await click(option("PR state", "Closed"));
  await click(button("Apply filters"));
  expect(indicators.at(-1)).toBeNull();
});

test("visible cards keep snapshot order when a later card has an active review", async () => {
  const cards = [pr, { ...pr, number: 102, localReview: { active: true, ready: false } }, { ...pr, number: 103 }];
  await render(async () => snapshot(cards));
  await click(button("List"));
  expect(Array.from(document.body.querySelectorAll("tbody .flow-id"), id => id.textContent)).toEqual(["#101", "#102", "#103"]);
});

test("the Done lane is drawn only when the state filter can yield closed or merged pull requests", async () => {
  const lanes = () => Array.from(document.body.querySelectorAll(".review-lanes section.lane"), lane => lane.getAttribute("aria-label"));
  const cards = [pr, { ...pr, number: 301, state: "merged" as const }, { ...pr, number: 302, state: "closed" as const }];
  const key = reviewFilterKey("/project", "repo1", "ann");
  await render(async () => snapshot(cards));
  expect(lanes()).toEqual(["Needs attention", "In review", "Open"]);
  saveReviewFilters(key, { ...EMPTY_FILTERS, state: ["closed"] });
  await render(async () => snapshot(cards));
  expect(lanes()).toEqual(["Needs attention", "In review", "Open", "Done"]);
  saveReviewFilters(key, { ...EMPTY_FILTERS, state: [] });
  await render(async () => snapshot(cards));
  expect(lanes()).toEqual(["Needs attention", "In review", "Open", "Done"]);
  saveReviewFilters(key, { ...EMPTY_FILTERS, state: ["merged", "draft"] });
  await render(async () => snapshot(cards));
  expect(lanes()).toContain("Done");
});

test("a historical filter retains known open requests and removes them when their PR is observed as merged", async () => {
  let merged = 102;
  const mine: ReviewCard = { ...pr, reviewers: ["ann"] };
  const indicators: import("./ReviewBoard").ReviewTabIndicator[] = [];
  const load: typeof fetchReviewBoard = async (_cwd, scope) => snapshot(scope === "merged"
    ? [{ ...mine, number: merged, state: "merged" }]
    : [mine]);
  await act(async () => root.render(createElement(ReviewBoard, {
    key: ++renderKey, cwd: "/history-test", flows: [], onOpenFlow() {}, load, watcherCommand: watcherDisabled,
    onIndicatorChange: indicator => indicators.push(indicator),
  })));
  expect(indicators.at(-1)).toBe("attention");
  await click(button("Filters"));
  await click(option("PR state", "Open")); await click(option("PR state", "Draft")); await click(option("PR state", "Merged"));
  await click(button("Apply filters"));
  expect(indicators.at(-1)).toBe("attention");
  merged = mine.number;
  await click(button("Refresh pull requests"));
  expect(indicators.at(-1)).toBeNull();
});

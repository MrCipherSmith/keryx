import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ComponentProps } from "react";
import type { Root } from "react-dom/client";
import { DESK_RUN_SCOPE, type DeskRun, type DeskRunSnapshot } from "../../../../src/review/desk-run-types";
import type { ReviewRunAction, reviewRun } from "../platform/reviewRuns";
import { registerDom, unregisterDom } from "../test/dom";
import type { ReviewDetail } from "./ReviewDetail";
import type { PublicationRequest, PublicationSettings, PublicationState } from "../../../../src/review/desk-publication-types";
import type { ReviewCard } from "./types";

let root: Root;
let renderComponent: (props: ComponentProps<typeof ReviewDetail>) => Promise<void>;
let act: (task: () => void | Promise<void>) => Promise<void>;
beforeAll(async () => {
  registerDom();
  const React = await import("react");
  act = React.act as unknown as typeof act;
  const detail = (await import("./ReviewDetail")).ReviewDetail;
  const host = document.createElement("div");
  document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
  renderComponent = props => act(async () => { root.render(React.createElement(detail, props)); });
});
afterAll(async () => { await act(() => root.unmount()); await unregisterDom(); });

const time = "2026-11-19T12:00:00Z";
const pr: ReviewCard = {
  number: 42, title: "Fix owner lookup", url: "https://github.com/owner/repo/pull/42",
  state: "open", draft: false, author: "tester", reviewers: [], assignees: [], decision: "APPROVED", ci: "passed",
  headSha: "head", baseSha: "base", updatedAt: time,
};
const running: DeskRun = {
  id: "attempt-1", scope: DESK_RUN_SCOPE, baseSha: "base", headSha: "head", source: "manual", state: "running", phase: "Reviewing diff",
  reason: "", createdAt: time, startedAt: time, finishedAt: null, result: null,
};
const complete: DeskRun = { ...running, state: "completed", phase: "Consolidated", finishedAt: time,
  result: { reviewed: { baseSha: "base", headSha: "head" }, verdict: "REQUEST_CHANGES", coverage: "complete",
    findings: { blocker: 1, major: 0, minor: 0, info: 0 }, report: "Incorrect owner on rename <script>alert(1)</script>" } };

async function show(command: typeof reviewRun, card: ReviewCard, extra?: Partial<ComponentProps<typeof ReviewDetail>>) {
  await renderComponent({
    card, cwd: "/project", repo: "owner/repo", viewer: "tester", repositoryId: "node", runCommand: command,
    load: async () => ({ version: 1, number: card.number, fetchedAt: time, viewer: "tester", repositoryId: "node",
      headSha: card.headSha, threads: [], comments: [], reviews: [], checks: [], warnings: [] }),
    onClose() {}, ...extra,
  });
}
function btn(text: string) {
  const b = [...document.querySelectorAll("button")].find(b => b.textContent === text);
  if (!b) throw new Error("Missing button " + text);
  return b;
}
const click = (name: string) => act(async () => btn(name).click());

test("starts the pinned range, ignores an older read and polls through to a distinct local verdict", async () => {
  let old!: (r: DeskRunSnapshot) => void;
  let launched = false;
  const actions: ReviewRunAction[] = [];
  const command: typeof reviewRun = async (_cwd, key, action) => {
    expect(key).toEqual({ repo: "owner/repo", repositoryId: "node", viewer: "tester", number: 42 });
    actions.push(action);
    if (action.kind === "start") { launched = true; return { version: 1, runs: [running] }; }
    if (launched) return { version: 1, runs: [complete] };
    return new Promise(resolve => { old = resolve; });
  };
  const clock: Window = window;
  const schedule = clock.setInterval, cancel = clock.clearInterval;
  const activeTimers = new Map<number, () => void>();
  let nextTimer = -1;
  clock.setInterval = (fn, delay, ...args) => {
    if (delay !== 3000 || typeof fn !== "function") return schedule.call(window, fn, delay, ...args);
    const id = nextTimer--;
    activeTimers.set(id, () => fn(...args));
    return id;
  };
  clock.clearInterval = id => {
    if (id === undefined || !activeTimers.delete(id)) cancel.call(window, id);
  };
  try {
    await show(command, pr);
    expect(btn("Checking review…").disabled).toBe(true);
    await act(async () => old({ version: 1, runs: [] }));
    await click("Keryx review");
    await click("Refresh runs");
    await click("Start review");
    expect(actions.at(-1)).toEqual({ kind: "start", baseSha: "base", headSha: "head" });
    expect(document.body.textContent).toContain("Reviewing diff");
    await act(async () => old({ version: 1, runs: [] }));
    expect(document.body.textContent).toContain("In progress");
    expect(activeTimers.size).toBe(1);
    const [tick] = activeTimers.values();
    const beforeTick = actions.length;
    await act(async () => { tick!(); });
    expect(actions.slice(beforeTick)).toEqual([{ kind: "status" }]);
    expect(document.body.textContent).toContain("REQUEST_CHANGES");
    expect(document.body.textContent).toContain("GitHub review decision · Approved");
    expect(document.body.textContent).toContain("1 blocker");
    expect(document.querySelector(".desk-run-report summary")?.textContent).toBe("Open review report");
    const disclosure = document.querySelector<HTMLDetailsElement>(".desk-run-report")!;
    await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event("toggle")); });
    expect(disclosure.textContent).toContain("Incorrect owner on rename");
    expect(disclosure.querySelector("script")).toBeNull();
    await click("View review result");
    expect(actions.filter(a => a.kind === "start")).toHaveLength(1);
  } finally {
    clock.setInterval = schedule;
    clock.clearInterval = cancel;
  }
});

test("historic result survives a push, and retry and stop target the correct attempt", async () => {
  const newer = { ...pr, number: 43, headSha: "next" };
  const next: DeskRun = { ...running, id: "attempt-2", headSha: "next" };
  const actions: ReviewRunAction[] = [];
  const command: typeof reviewRun = async (_cwd, _key, action) => {
    actions.push(action);
    if (action.kind === "status") return { version: 1, runs: [complete] };
    if (action.kind === "start") return { version: 1, runs: [next, complete] };
    return { version: 1, runs: [{ ...next, state: "cancelled", reason: "Stopped by user" }, complete] };
  };
  await show(command, newer);
  await click("Review changes");
  expect(document.body.textContent).toContain("Earlier revision");
  await click("Stop review");
  expect(actions.at(-1)).toEqual({ kind: "cancel", id: "attempt-2" });
  expect(document.body.textContent).toContain("Stopped by user");
  await click("Retry review");
  expect(actions.at(-1)).toEqual({ kind: "start", baseSha: "base", headSha: "next" });
});

test("a late status from another PR cannot reveal its report and a closed PR cannot launch", async () => {
  let finish!: (r: DeskRunSnapshot) => void;
  const waiting: typeof reviewRun = () => new Promise(resolve => { finish = resolve; });
  await show(waiting, { ...pr, number: 44 });
  await show(async () => ({ version: 1, runs: [] }), { ...pr, number: 45, state: "merged" });
  await click("Keryx review");
  await act(async () => finish({ version: 1, runs: [complete] }));
  expect(document.body.textContent).toContain("No Keryx reviews");
  expect(document.body.textContent).not.toContain("Start review");
  expect(document.body.textContent).not.toContain("Incorrect owner");
});

test("a stale range keeps the board refresh action through status polling; denied history removes stored reports", async () => {
  let deny = false, refreshed = 0, denied = "";
  const command: typeof reviewRun = async (_cwd, _key, action) => {
    if (action.kind === "start") throw new Error("stale: Range changed");
    if (deny) throw new Error("access: Permission revoked");
    return { version: 1, runs: [complete] };
  };
  await show(command, { ...pr, number: 46, baseSha: "new-base" }, {
    onRefreshBoard: () => { refreshed++; },
    onAccessLost: message => { denied = message; },
  });
  await click("Review changes");
  expect(btn("Review changes").disabled).toBe(true);
  await click("Refresh runs");
  await click("Refresh board");
  expect(refreshed).toBe(1);
  const attempt = document.querySelector(`article[aria-label="Review attempt ${complete.id}"]`)!;
  expect(attempt.textContent).toContain("REQUEST_CHANGES");
  const disclosure = attempt.querySelector<HTMLDetailsElement>(".desk-run-report")!;
  await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event("toggle")); });
  expect(disclosure.textContent).toContain("Incorrect owner on rename");
  deny = true;
  await click("Refresh runs");
  expect(document.body.contains(attempt)).toBe(false);
  expect(document.querySelector("article.desk-run")).toBeNull();
  expect(denied).toBe("access: Permission revoked");
  expect(document.body.textContent).not.toContain("Incorrect owner");
});

test("opening one deferred report loads its own attempt and leaves concurrent history polling enabled", async () => {
  const item: DeskRun = { ...complete, result: { ...complete.result!, report: "", reportDeferred: true } };
  const actions: ReviewRunAction[] = [];
  let finish!: (s: DeskRunSnapshot) => void;
  const command: typeof reviewRun = async (_cwd, _key, action) => {
    actions.push(action);
    if (action.kind === "status" && action.id) return new Promise(resolve => { finish = resolve; });
    return { version: 1, runs: [item] };
  };
  await show(command, { ...pr, number: 48 });
  await click("View review result");
  expect(actions).toEqual([{ kind: "status" }]);
  const disclosure = document.querySelector<HTMLDetailsElement>(".desk-run-report")!;
  await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event("toggle")); });
  expect(actions.at(-1)).toEqual({ kind: "status", id: complete.id });
  await click("Refresh runs");
  expect(actions).toEqual([{ kind: "status" }, { kind: "status", id: complete.id }, { kind: "status" }]);
  expect(disclosure.textContent).not.toContain("Incorrect owner on rename");
  await act(async () => finish({ version: 1, runs: [complete] }));
  expect(disclosure.textContent).toContain("Incorrect owner on rename");
  expect(actions.filter(action => action.kind === "status" && action.id)).toHaveLength(1);
});

test("a closed result from an earlier review scope stays readable and allows a new run", async () => {
  const archived = { ...complete, id: "archived-attempt", scope: "earlier-profile" };
  const requests: ReviewRunAction[] = [];
  await show(async (_cwd, _key, action) => {
    requests.push(action);
    return { version: 1, runs: action.kind === "start" ? [running, archived] : [archived] };
  }, pr);
  await click("Keryx review");
  expect(document.body.textContent).toContain("Open review report");
  await click("Retry review");
  expect(requests.at(-1)).toEqual({ kind: "start", baseSha: pr.baseSha, headSha: pr.headSha });
});

test("Tab wraps after the publish action and Shift+Tab returns to it", async () => {
  await show(async () => ({ version: 1, runs: [complete] }), { ...pr, number: 105 });
  await click("View review result");
  const publish = btn("Publish to GitHub");
  const close = document.querySelector<HTMLButtonElement>('[aria-label="Close details"]')!;
  const tab = (shiftKey: boolean) => document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }),
  );
  close.focus();
  expect(tab(true)).toBe(false);
  expect(document.activeElement).toBe(publish);
  expect(tab(false)).toBe(false);
  expect(document.activeElement).toBe(close);
});

test("a scheduled review shares the card action and identifies its rule and budget in history", async () => {
  const scheduled: DeskRun = { ...running, source: "scheduled", schedule: {
    project: "/project", ruleId: "r", ruleName: "Core team on green", event: "review_requested", recipient: "org/core",
    author: "", assignee: "", requireGreen: true, budgetMinutes: 7, budgetTokens: 15000, attemptKey: "work",
  } };
  const actions: ReviewRunAction[] = [];
  await show(async (_cwd, _key, action) => { actions.push(action); return { version: 1, runs: [scheduled] }; }, { ...pr, number: 78 });
  await click("View active review");
  expect(document.body.textContent).toContain("Scheduled");
  expect(document.body.textContent).toContain("Core team on green");
  expect(document.body.textContent).toContain("7 min");
  expect(actions.some(action => action.kind === "start")).toBe(false);
});

test("review history shows measured tokens for each reviewer, the orchestrator and the run", async () => {
  const usage = {
    coordinator: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    reviewers: [
      { reviewer: "review-logic", provider: "codex", model: "test-model", inputTokens: 1200, outputTokens: 34, totalTokens: 1234, cacheReadTokens: 600, cost: { amount: 0.005, currency: "USD" } },
      { reviewer: "review-style", inputTokens: 15, estimatedCost: { amount: 0.001, currency: "USD" } },
    ],
    total: { inputTokens: 1215, outputTokens: 34, totalTokens: 1249, reportedCosts: [{ amount: 0.005, currency: "USD" }] },
    partial: true,
  };
  await show(async () => ({ version: 1, runs: [{ ...complete, usage }] }), { ...pr, number: 81 });
  await click("View review result");
  const table = document.querySelector<HTMLTableElement>('table[aria-label="Token usage"]')!;
  const details = table.closest("details")!;
  const summary = details.querySelector("summary")!;
  expect(details.open).toBe(false);
  expect(summary.textContent).toContain(`${(1249).toLocaleString()} tokens`);
  expect(summary.textContent).toContain("Partial");
  summary.click();
  expect(details.open).toBe(true);
  expect(table.closest('[role="region"]')?.getAttribute("tabindex")).toBe("0");
  const cells = (name: string) => Array.from(table.rows).find(row => row.cells[0]?.textContent?.startsWith(name))!;
  expect(table.textContent).toContain("Cache read");
  expect(cells("Orchestrator").cells[1]!.textContent).toBe("0");
  expect(cells("review-logic").cells[0]!.textContent).toContain("codex");
  expect(cells("review-logic").cells[0]!.textContent).toContain("test-model");
  expect(cells("review-logic").cells[1]!.textContent).toBe((1200).toLocaleString());
  expect(cells("review-logic").textContent).toContain("600");
  expect(cells("review-logic").textContent).toContain(`${(0.005).toLocaleString()} USD`);
  expect(table.textContent).toContain("Estimated cost");
  expect(cells("review-style").textContent).toContain(`${(0.001).toLocaleString()} USD`);
  expect(cells("review-style").cells[2]!.getAttribute("aria-label")).toBe("Unreported");
  expect(cells("Total").textContent).toContain(`Reported subtotal · ${(0.005).toLocaleString()} USD`);
  expect(cells("Total").cells[1]!.textContent).toBe((1215).toLocaleString());
  expect(document.body.textContent).toContain("Partial usage");
  summary.click();
  expect(details.open).toBe(false);
});

test("an old result without usage and a scheduled run with an unlimited budget stay readable", async () => {
  const scheduled: DeskRun = { ...complete, source: "scheduled", schedule: {
    project: "/project", ruleId: "r", ruleName: "Team", event: "push", recipient: null,
    author: "", assignee: "", requireGreen: false, budgetMinutes: 12, budgetTokens: null, attemptKey: "work",
  } };
  await show(async () => ({ version: 1, runs: [scheduled] }), { ...pr, number: 82 });
  await click("View review result");
  expect(document.body.textContent).toContain("12 min");
  expect(document.body.textContent).toContain("No token limit");
  expect(document.body.textContent).toContain("Token usage was not recorded");
  expect(document.querySelector('table[aria-label="Token usage"]')).toBeNull();
});

test("a metered subscription review can have measured tokens with no reported price", async () => {
  const measured = { inputTokens: 1000, outputTokens: 10, totalTokens: 1010 };
  const usage = {
    total: measured, coordinator: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    reviewers: [{ reviewer: "review-logic", provider: "codex", ...measured }], partial: false,
  };
  await show(async () => ({ version: 1, runs: [{ ...complete, usage }] }), { ...pr, number: 83 });
  await click("View review result");
  const table = document.querySelector('table[aria-label="Token usage"]')!;
  expect(table.querySelector("tfoot")?.textContent).toContain((1010).toLocaleString());
  expect(table.textContent).not.toMatch(/cost/i);
  expect(document.body.textContent).toContain("Cost unavailable for this run.");
  expect(document.body.textContent).not.toContain("Partial usage");
});

test("a reviewer session follows its own wave through completion and Escape returns focus to its row", async () => {
  const early = { id: "logic-1", reviewer: "review-logic", wave: 1, state: "completed" as const };
  const current = { id: "logic-2", reviewer: "review-logic", wave: 2, state: "running" as const,
    provider: "codex", model: "review-model", startedAt: time };
  let finished = false, closeSheet = 0;
  const actions: ReviewRunAction[] = [];
  const command: typeof reviewRun = async (_cwd, _target, action) => {
    actions.push(action);
    const recent = finished ? { ...current, state: "completed" as const, finishedAt: "2026-11-19T12:00:35Z",
      usage: { inputTokens: 0, outputTokens: 21, totalTokens: 21 } } : current;
    const detailed = action.kind === "status" && action.activityId === running.id;
    const session = detailed ? { ...recent, activity: [{ at: time, label: finished ? "Review saved" : "Reading file" }] } : recent;
    return { version: 1, runs: [{ ...(finished ? complete : running),
      reviewerProgress: { planned: 2, finished: finished ? 2 : 1, wave: 2, sessions: [early, session] } }] };
  };
  await show(command, { ...pr, number: 91 }, { onClose: () => { closeSheet++; } });
  await click("View active review");
  expect(document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("1");
  const list = document.querySelector<HTMLDetailsElement>(".review-sessions")!;
  await act(async () => list.querySelector("summary")!.click());
  const row = list.querySelector<HTMLButtonElement>('[aria-label="Open review-logic session, wave 2, In progress"]')!;
  row.focus();
  await act(async () => row.click());
  const dialog = document.querySelector<HTMLElement>(".dialog")!;
  expect(dialog.textContent).toContain("review-model");
  expect(dialog.textContent).toContain("Reading file");
  expect(dialog.textContent).toContain("Wave 2");
  expect(dialog.textContent).toContain("Tokens unreported");
  finished = true;
  actions.length = 0;
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(actions).toEqual([{ kind: "status", activityId: running.id }]);
  expect(dialog.textContent).toContain("Review saved");
  expect(dialog.textContent).toContain("0 in");
  expect(dialog.textContent).toContain("35s");
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })); });
  expect(document.querySelector(".dialog")).toBeNull();
  expect(closeSheet).toBe(0);
  expect(document.activeElement).toBe(row);
});

test("a running attempt with unknown reviewer count shows indeterminate progress", async () => {
  await show(async () => ({ version: 1, runs: [running] }), { ...pr, number: 92 });
  await click("View active review");
  const progress = document.querySelector('[role="progressbar"]');
  expect(progress).not.toBeNull();
  expect(progress!.hasAttribute("aria-valuenow")).toBe(false);
});

test("expanding a historical session recovers its recorded failure without assigning a duration or token estimate", async () => {
  const command: typeof reviewRun = async (_cwd, _target, action) => {
    const item = action.kind === "status" && (action.id === complete.id || action.activityId === complete.id) ? { ...complete,
      reviewerProgress: { planned: null, wave: 3, finished: 1, sessions: [{ id: "partial-runner", reviewer: "review-style", wave: 3,
        state: "failed" as const, activity: [{ label: "Runner exited" }] },
        { id: "queued-runner", reviewer: "review-logic", wave: 4, state: "planned" as const }] } } : complete;
    return { version: 1, runs: [item] };
  };
  await show(command, { ...pr, number: 93 });
  await click("View review result");
  const details = document.querySelector<HTMLDetailsElement>(".review-sessions")!;
  await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
  const row = details.querySelector<HTMLButtonElement>('[aria-label="Open review-style session, wave 3, Failed"]')!;
  expect(details.querySelector<HTMLButtonElement>('[aria-label="review-logic session, wave 4, Planned"]')?.disabled).toBe(true);
  await act(async () => row.click());
  const dialog = document.querySelector(".dialog")!;
  expect(dialog.textContent).toContain("Failed");
  expect(dialog.textContent).toContain("Runner exited");
  expect(dialog.textContent).toContain("Time unreported");
  expect(dialog.textContent).toContain("Tokens unreported");
  await click("Close");
});

test("interrupted reviewer dialog marks its recorded tokens partial", async () => {
  await show(async () => ({ version: 1, runs: [{ ...complete,
    reviewerProgress: { planned: 1, wave: 1, finished: 1, sessions: [{
      id: "interrupted", reviewer: "review-logic", wave: 1, state: "cancelled",
      usage: { inputTokens: 9, outputTokens: 2, totalTokens: 11 }, usagePartial: true,
    }] } }] }), { ...pr, number: 94 });
  await click("View review result");
  const details = document.querySelector<HTMLDetailsElement>(".review-sessions")!;
  await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
  const row = details.querySelector<HTMLButtonElement>('[aria-label="Open review-logic session, wave 1, Cancelled"]')!;
  await act(async () => row.click());
  expect(document.querySelector(".dialog")!.textContent).toContain("Partial tokens · 9 in / 2 out / 11 total");
  await click("Close");
});

test("previews a GitHub draft, collects finding answers and only publishes the confirmed settings on submit", async () => {
  const actions: PublicationRequest[] = [];
  let refuseSubmission = true;
  let saved: PublicationSettings | undefined;
  const firstOption = `option:${"a".repeat(64)}` as const;
  const secondOption = `option:${"b".repeat(64)}` as const;
  const defaults: PublicationSettings = { inline: true, general: true, keryxTemplate: true, overlay: false, verdict: "changes", verdictOverride: null, answers: {} };
  const questions: PublicationState["questions"] = [
    { id: "first", text: "Keep the owner finding?", options: [
      { id: firstOption, label: "Include the ownership finding" },
      { id: secondOption, label: "Omit it as out of scope" },
    ] },
    { id: "second", text: "Keep the unrelated case?", recommendation: "dismiss" },
  ];
  await show(async () => ({ version: 1, runs: [complete] }), pr, {
    publishCommand: async (cwd, subject, request) => {
      expect(cwd).toBe("/project");
      expect(subject).toEqual({ repo: "owner/repo", viewer: "tester", repositoryId: "node", number: 42 });
      expect(request.id).toBe(complete.id);
      actions.push(request);
      if (request.kind === "submit" && refuseSubmission) {
        refuseSubmission = false;
        throw new Error("permission: GitHub refused the review. Check the project's account and its permission to submit reviews.");
      }
      const settings = request.settings ?? saved ?? defaults;
      if (request.kind === "save") saved = settings;
      return {
        version: 1, settings, questions, overlayAvailable: true,
        body: "Draft lead-in\n\n## Formatted draft\n\n<script>alert(1)</script>\n\n[Ignore link](https://example.invalid)\n\n![Remote image](https://example.invalid/image.png)\n\n<img src='https://example.invalid/raw.png'>",
        inlineCount: settings.inline ? 1 : 0, canSubmit: true, digest: actions.length.toString(16).padStart(64, "0"),
        inlineComments: settings.inline ? [{ path: "src/owner.ts", line: 73,
          body: "**Inline body**\n\n[Inert link](https://example.invalid)\n\n![Inert image](https://example.invalid/inline.png)" }] : [],
        ...(saved ? { savedAt: time } : {}),
        ...(request.kind === "submit" ? { publishedUrl: pr.url + "#pullrequestreview-17" } : {}),
      };
    },
  });
  await click("View review result");
  await click("Publish to GitHub");
  let dialog = document.querySelector<HTMLElement>(".dialog")!;
  expect(dialog.querySelector(".review-publish-markdown h2")?.textContent).toBe("Formatted draft");
  expect(Array.from(dialog.querySelectorAll(".review-publish-markdown :is(script, img, a[href])"), node => node.outerHTML)).toEqual([]);
  expect(dialog.querySelector(".review-publish-markdown a")?.textContent).toBe("Ignore link");
  expect(btn("Submit review").disabled).toBe(true);
  expect(dialog.textContent).toContain("Question 1 of 2");
  const label = (name: string) => [...dialog.querySelectorAll<HTMLLabelElement>("label")].find(label => label.textContent?.trim().startsWith(name));
  const field = (name: string) => label(name)!.querySelector<HTMLInputElement>("input")!;
  expect(dialog.textContent).toContain("The report has no recommendation.");
  expect(label("Include the ownership finding")?.textContent).not.toContain("Recommended");
  expect(label("Keep finding")).toBeUndefined();
  expect(field("Use recommendation").checked).toBe(true);
  expect(label("Use recommendation")?.textContent).toContain("Request changes");
  const inline = dialog.querySelector<HTMLDetailsElement>(".review-publish-inline")!;
  expect(inline.open).toBe(false);
  await act(async () => { inline.open = true; inline.dispatchEvent(new Event("toggle")); });
  expect(inline.textContent).toContain("src/owner.ts:73");
  expect(inline.querySelector("strong")?.textContent).toBe("Inline body");
  expect(inline.querySelector("img, a[href]")).toBeNull();
  await act(async () => field("Inline comments").click());
  expect(dialog.querySelector(".review-publish-inline")).toBeNull();
  await act(async () => field("Inline comments").click());
  const restoredInline = dialog.querySelector<HTMLDetailsElement>(".review-publish-inline")!;
  expect(restoredInline.open).toBe(true);
  expect(restoredInline.textContent).toContain("src/owner.ts:73");
  await act(async () => field("General comment").click());
  expect(field("General comment").checked).toBe(false);
  expect(restoredInline.textContent).toContain("src/owner.ts:73");
  await act(async () => field("Project overlay").click());
  await act(async () => field("Approve with suggestions").click());
  await act(async () => field("Omit it as out of scope").click());
  await click("Next question");
  expect(dialog.textContent).toContain("Question 2 of 2");
  expect(label("Dismiss finding")?.textContent).toContain("Recommended");
  await act(async () => field("Dismiss finding").click());
  expect(actions.every(action => action.kind === "preview")).toBe(true);
  await click("Save locally");
  const answers = { first: secondOption, second: "dismiss" };
  expect(actions.at(-1)).toMatchObject({ kind: "save", settings: { verdict: "suggestions", verdictOverride: "suggestions", overlay: true, answers } });
  expect(dialog.textContent).toContain("Last saved locally");
  await click("Close");
  await click("Publish to GitHub");
  dialog = document.querySelector<HTMLElement>(".dialog")!;
  expect(field("Omit it as out of scope").checked).toBe(true);
  await click("Next question");
  expect(field("Dismiss finding").checked).toBe(true);
  const digest = actions.length.toString(16).padStart(64, "0");
  await click("Submit review");
  expect(actions.at(-1)).toMatchObject({ kind: "submit", digest, settings: { answers } });
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("permission to submit reviews");
  expect(field("Approve with suggestions").checked).toBe(true);
  expect(field("Dismiss finding").checked).toBe(true);
  await click("Submit review");
  expect(actions.at(-1)).toMatchObject({ kind: "submit", digest, settings: { answers } });
  expect(dialog.textContent).toContain("Review published on GitHub.");
  await click("Close");
});

test("updates automatic verdicts and only enables submission after the latest coalesced preview", async () => {
  const requests: PublicationRequest[] = [];
  const waiters: (() => void)[] = [];
  let holdPreviews = true;
  let refuseRefresh = false;
  const openReview: typeof reviewRun = async () => ({ version: 1, runs: [complete] });
  const defaults: PublicationSettings = { inline: true, general: true, keryxTemplate: true, overlay: false,
    verdict: "comment", verdictOverride: null, answers: {} };
  await show(openReview, { ...pr, number: 45 }, {
    publishCommand: async (_cwd, _subject, request) => {
      const index = requests.push(request);
      const settings = request.settings ?? defaults;
      if (request.kind === "preview" && request.refresh && refuseRefresh) {
        refuseRefresh = false;
        throw new Error("Could not refresh the review.");
      }
      if (request.kind === "preview" && request.settings && holdPreviews) {
        await new Promise<void>(resolve => { waiters.push(resolve); });
      }
      return {
        version: 1, settings: { ...settings, verdict: settings.verdictOverride ??
          (settings.answers.held === "uphold" ? "changes" : "comment") },
        body: `Preview ${index}`, inlineCount: 0, overlayAvailable: false,
        canSubmit: settings.general || settings.inline, digest: index.toString(16).padStart(64, "0"),
        questions: [{ id: "held", text: "Include the finding?", recommendation: "uphold" }],
      };
    },
  });
  await click("View review result");
  await click("Publish to GitHub");
  expect(requests[0]).toMatchObject({ kind: "preview", refresh: true });
  const dialog = document.querySelector<HTMLElement>(".dialog")!;
  const input = (name: string) => [...dialog.querySelectorAll("label")]
    .find(node => node.textContent?.trim().startsWith(name))!.querySelector("input")!;
  expect(dialog.textContent).toContain("Comment only recommended");
  await act(async () => input("Keep finding").click());
  await act(async () => input("Keryx template").click());
  await act(async () => input("Inline comments").click());
  expect(requests).toHaveLength(2);
  expect(input("Keryx template").checked).toBe(false);
  expect(input("Inline comments").checked).toBe(false);
  expect(btn("Save locally").disabled).toBe(true);
  expect(btn("Submit review").disabled).toBe(true);
  await act(async () => waiters.shift()!());
  expect(requests).toHaveLength(3);
  expect(requests[2]).toMatchObject({ kind: "preview", settings: { keryxTemplate: false, inline: false,
    verdictOverride: null, answers: { held: "uphold" } } });
  expect(dialog.textContent).not.toContain("Preview 2");
  expect(btn("Submit review").disabled).toBe(true);
  await act(async () => waiters.shift()!());
  expect(dialog.textContent).toContain("Request changes recommended");
  expect(btn("Submit review").disabled).toBe(false);
  holdPreviews = false;

  await act(async () => input("Comment only").click());
  expect(requests.at(-1)).toMatchObject({ settings: { verdictOverride: "comment" } });
  expect(input("Comment only").checked).toBe(true);
  await act(async () => input("Use recommendation").click());
  expect(requests.at(-1)).toMatchObject({ settings: { verdictOverride: null } });
  expect(dialog.textContent).toContain("Request changes recommended");
  refuseRefresh = true;
  await click("Refresh preview");
  expect(dialog.querySelector("[role=alert]")?.textContent).toContain("Could not refresh the review.");
  expect(btn("Submit review").disabled).toBe(true);
  await click("Refresh preview");
  expect(requests.at(-1)).toMatchObject({ kind: "preview", refresh: true, settings: { verdictOverride: null, verdict: "changes" } });
  await click("Submit review");
  expect(requests.at(-1)).toMatchObject({ kind: "submit", digest: "7".padStart(64, "0"),
    settings: { verdictOverride: null, verdict: "changes", answers: { held: "uphold" } } });
  await click("Close");
});

test("suggests a supported executable when the selected CLI lacks review publishing", async () => {
  await show(async () => ({ version: 1, runs: [complete] }), { ...pr, number: 46 }, {
    publishCommand: async () => { throw new Error("Unknown review command: desk-publish"); },
  });
  await click("View review result");
  await click("Publish to GitHub");
  expect(document.querySelector(".dialog [role=alert]")?.textContent).toContain("Settings → Desktop");
  expect(document.querySelector(".dialog [role=alert]")?.textContent).toContain("Bundled");
  expect(btn("Submit review").disabled).toBe(true);
  await click("Close");
});

test("switching pull requests drops a late publication preview and sends no writes", async () => {
  let finish!: (state: PublicationState) => void;
  const actions: PublicationRequest[] = [];
  const review: typeof reviewRun = async () => ({ version: 1, runs: [complete] });
  await show(review, pr, {
    publishCommand: async (_cwd, _target, request) => {
      actions.push(request);
      return new Promise(resolve => { finish = resolve; });
    },
  });
  await click("View review result");
  await click("Publish to GitHub");
  expect(btn("Submit review").disabled).toBe(true);
  await show(review, { ...pr, number: 43, url: "https://github.com/owner/repo/pull/43" });
  await act(async () => finish({
    version: 1, settings: { inline: false, general: true, keryxTemplate: true, overlay: false, verdict: "comment", answers: {} },
    body: "Prior preview", inlineCount: 0, questions: [], overlayAvailable: false, canSubmit: true, digest: "draft",
  }));
  expect(document.querySelector(".review-publish")).toBeNull();
  expect(document.body.textContent).not.toContain("Prior preview");
  expect(actions.map(action => action.kind)).toEqual(["preview"]);
});

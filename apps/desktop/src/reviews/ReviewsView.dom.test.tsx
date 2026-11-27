import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { ComponentProps } from "react";
import type { Root } from "react-dom/client";
import { DESK_RUN_SCOPE, type DeskRun } from "../../../../src/review/desk-run-types";
import type { ReviewAttemptSummary, ReviewSummary, ReviewsSnapshot } from "../../../../src/review/review-entity";
import type { ReviewRule, ReviewRuleAction, ReviewRuleSnapshot } from "../../../../src/review/review-rule-types";
import type { fetchReviews } from "../platform/review";
import type { reviewRules } from "../platform/reviewRules";
import type { reviewRun } from "../platform/reviewRuns";
import type { ReviewCard } from "../review/types";
import type { ReviewsTabIndicator } from "./ReviewsView";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let ReviewsView: typeof import("./ReviewsView").ReviewsView;
let ReviewDetail: typeof import("../review/ReviewDetail").ReviewDetail;
let RUNNING_RELOAD_MS: number;
let renderKey = 0;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  ({ ReviewsView, RUNNING_RELOAD_MS } = await import("./ReviewsView"));
  ReviewDetail = (await import("../review/ReviewDetail")).ReviewDetail;
  const host = document.createElement("div");
  document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
});
beforeEach(async () => { await act(async () => root.render(null)); });
afterAll(async () => {
  await act(async () => root.unmount());
  await unregisterDom();
});

const time = "2026-11-20T10:00:00Z";
function card(number: number, title = "Change " + number): ReviewCard {
  return { number, title, url: "https://github.com/org/repo/pull/" + number, state: "open", draft: false, author: "lee",
    assignees: [], reviewers: [], decision: null, ci: "passed", baseSha: "base" + number, headSha: "head" + number, updatedAt: time };
}
function attempt(id: string, round: number, extra: Partial<ReviewAttemptSummary> = {}): ReviewAttemptSummary {
  return { id, round, previousRunId: null, state: "completed", source: "manual", baseSha: "b".repeat(40), headSha: "c".repeat(40),
    reviewed: { baseSha: "b".repeat(40), headSha: "c".repeat(40) }, coverage: "complete", findings: { blocker: 1, major: 0, minor: 2, info: 0 },
    verdict: "REQUEST_CHANGES", publication: "pending", decision: null, flowId: null, tokens: 1200, awaitingAnswer: false, archived: false,
    createdAt: time, finishedAt: time, ...extra };
}
function review(number: number, extra: Partial<ReviewSummary> = {}): ReviewSummary {
  return { id: "review-" + number, number, card: card(number), state: "ready", freshness: { kind: "current" }, onHeadMove: "ask",
    closedAt: null, rounds: [{ number: 1, baseSha: "b".repeat(40), headSha: "c".repeat(40), previousRunId: null, attempts: [attempt("run-" + number, 1)] }],
    latestRound: 1, reviewed: { baseSha: "b".repeat(40), headSha: "c".repeat(40) }, archived: false,
    findings: { blocker: 1, major: 0, minor: 2, info: 0 }, publication: "pending", source: "manual", flowId: null, tokens: 1200, ...extra };
}
function snapshot(reviews: ReviewSummary[], viewer = "ann"): ReviewsSnapshot {
  return { version: 1, repo: "org/repo", repositories: ["org/repo"], repositoryId: "repo1", viewer, fetchedAt: time, reviews, warnings: [] };
}
/** The card button of a Review on the board, found by its PR number. */
function tile(number: number) {
  const card = [...document.body.querySelectorAll(".review-summary-card")].find(item => item.querySelector(".flow-id")?.textContent === "#" + number);
  if (!card) throw new Error("Missing card #" + number);
  return card.querySelector<HTMLButtonElement>("button.review-card")!;
}

const noRuns: typeof reviewRun = async () => ({ version: 1, runs: [] });
const noRules: typeof reviewRules = async () => ({ version: 1, rules: [], choice: { mode: "project" }, activity: [] }) as ReviewRuleSnapshot;
type ViewProps = ComponentProps<typeof import("./ReviewsView").ReviewsView>;
function render(load: typeof fetchReviews, extra: Partial<ViewProps> = {}, key = ++renderKey) {
  return act(async () => { root.render(createElement(ReviewsView, { key, cwd: "/project", active: true, load, runCommand: noRuns, rulesCommand: noRules, ...extra })); });
}
const click = (el: HTMLElement) => act(async () => { el.click(); });
function button(label: string) {
  const el = [...document.body.querySelectorAll("button")].find(b => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
  if (!el) throw new Error("Missing button " + label);
  return el;
}
const has = (label: string) => [...document.body.querySelectorAll("button")].some(b => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
const lane = (name: string) => document.body.querySelector(`section.lane[aria-label="${name}"]`);
const numbersIn = (el: Element | null) => [...(el?.querySelectorAll(".flow-id") ?? [])].map(id => id.textContent);
async function choose(label: string, value: string) {
  const select = document.body.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function type(label: string, value: string) {
  const input = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const behind = { kind: "behind" as const, commits: 3, rewritten: false };
const all = [
  review(1, { state: "running", freshness: behind, publication: null, findings: null }),
  review(2, { state: "queued", publication: null, findings: null }),
  review(3, { state: "needs_answer", freshness: behind }),
  review(4, { state: "ready" }),
  review(5, { state: "stopped" }),
  review(6, { state: "ready", freshness: behind }),
  review(7, { state: "published", publication: "published", freshness: { kind: "behind", commits: null, rewritten: false } }),
  review(8, { state: "published", publication: "published" }),
  review(9, { state: "closed" }),
  review(10, { state: "stopped", freshness: { kind: "diverged-in-future" } as unknown as ReviewSummary["freshness"] }),
];

test("AC6 columns read Running · Waiting on you · Behind · Published, with Closed only when shown", async () => {
  await render(async () => snapshot(all));
  expect([...document.body.querySelectorAll("section.lane h2")].map(h => h.textContent)).toEqual(["Running", "Waiting on you", "Behind", "Published"]);
  expect(numbersIn(lane("Running"))).toEqual(["#1", "#2"]);
  // needs_answer wins over behind; ready that is behind goes to Behind; an unknown freshness kind is not behind.
  expect(numbersIn(lane("Waiting on you"))).toEqual(["#3", "#4", "#5", "#10"]);
  expect(numbersIn(lane("Behind"))).toEqual(["#6", "#7"]);
  expect(numbersIn(lane("Published"))).toEqual(["#8"]);
  expect(document.body.textContent).not.toContain("Change 9");
  await click(button("Show closed"));
  expect(button("Show closed").getAttribute("aria-pressed")).toBe("true");
  expect([...document.body.querySelectorAll("section.lane h2")].map(h => h.textContent)).toEqual(["Running", "Waiting on you", "Behind", "Published", "Closed"]);
  expect(numbersIn(lane("Closed"))).toEqual(["#9"]);
});

test("AC6 a card shows the PR, round, reviewed commit with freshness, findings, publication, source, Flow and tokens; list shows the same", async () => {
  const item = review(6, { state: "ready", freshness: behind, latestRound: 2, flowId: "488", source: "scheduled", tokens: 15000,
    reviewed: { baseSha: "b".repeat(40), headSha: "abcdef0123456" },
    rounds: [{ number: 2, baseSha: "b".repeat(40), headSha: "d".repeat(40), previousRunId: "run-a", attempts: [attempt("run-b", 2, { reviewed: { baseSha: "b".repeat(40), headSha: "abcdef0123456" } })] }] });
  await render(async () => snapshot([item, review(8, { state: "published", publication: "published", freshness: { kind: "behind", commits: null, rewritten: false } })]));
  const card6 = lane("Behind")!.querySelector(".review-summary-card")!;
  for (const text of ["#6", "Change 6", "lee", "Round 2", "abcdef0", "behind 3", "1 blocker · 2 minor", "Not published", "Scheduled", "Flow #488", (15000).toLocaleString() + " tokens"]) {
    expect(card6.textContent).toContain(text);
  }
  // The card's facts are its accessible name: no aria-label replaces them.
  expect(tile(6).hasAttribute("aria-label")).toBe(false);
  expect(lane("Behind")!.textContent).toContain("Published on GitHub");
  expect(lane("Behind")!.textContent).toMatch(/· behind(?! \d)/);
  await click(button("List"));
  const row = [...document.body.querySelectorAll("tbody tr")].find(r => r.textContent?.includes("Change 6"))!;
  for (const text of ["lee", "Ready", "abcdef0", "behind 3", "1 blocker · 2 minor", "Not published", "Scheduled", "#488", (15000).toLocaleString()]) {
    expect(row.textContent).toContain(text);
  }
  const columns = [...document.body.querySelectorAll("thead th")].map(th => th.textContent);
  expect(row.children[columns.indexOf("Round")]!.textContent).toBe("2");
});

test("AC6 search by title or number and the state, freshness and source filters narrow board and list", async () => {
  await render(async () => snapshot([...all, review(11, { card: card(11, "Fix owner lookup"), source: "scheduled" })]));
  await type("Search reviews", "owner");
  expect(numbersIn(document.body.querySelector(".board"))).toEqual(["#11"]);
  await type("Search reviews", "#1");
  expect(numbersIn(document.body.querySelector(".board"))).toEqual(["#1", "#10", "#11"]);
  await type("Search reviews", "");
  await choose("Review state", "stopped");
  expect(numbersIn(document.body.querySelector(".board"))).toEqual(["#5", "#10"]);
  await choose("Review state", "");
  await choose("Freshness", "behind");
  expect(numbersIn(document.body.querySelector(".board"))).toEqual(["#1", "#3", "#6", "#7"]);
  await choose("Freshness", "");
  await choose("Source", "scheduled");
  await click(button("List"));
  expect([...document.body.querySelectorAll("tbody .flow-id")].map(id => id.textContent)).toEqual(["#11"]);
  await choose("Source", "");
  await type("Search reviews", "nothing like this");
  expect(document.body.textContent).toContain("No matching reviews");
  await click(button("Reset search and filters"));
  expect(document.body.querySelectorAll("tbody tr").length).toBeGreaterThan(1);
});

test("an unknown PR head reads head unknown on card and list, goes by state, and has its own freshness filter", async () => {
  const unknown = { kind: "unknown" as const };
  await render(async () => snapshot([
    review(1, { state: "ready", freshness: unknown, card: null }),
    review(2, { state: "published", publication: "published", freshness: unknown }),
    review(3, { state: "ready", freshness: behind }),
    review(4, { state: "ready" }),
  ]));
  expect(numbersIn(lane("Behind"))).toEqual(["#3"]);
  expect(numbersIn(lane("Waiting on you"))).toEqual(["#1", "#4"]);
  expect(numbersIn(lane("Published"))).toEqual(["#2"]);
  const tile = lane("Waiting on you")!.querySelector(".review-summary-card")!;
  expect(tile.textContent).toContain("Pull request #1");
  expect(tile.textContent).toContain("· head unknown");
  expect(tile.querySelector(".review-behind")).toBeNull();
  await choose("Freshness", "unknown");
  expect(numbersIn(document.body.querySelector(".board"))).toEqual(["#1", "#2"]);
  await choose("Freshness", "current");
  expect(numbersIn(document.body.querySelector(".board"))).toEqual(["#4"]);
  await choose("Freshness", "unknown");
  await click(button("List"));
  const rows = [...document.body.querySelectorAll("tbody tr")];
  expect(rows.map(r => r.querySelector(".flow-id")?.textContent)).toEqual(["#1", "#2"]);
  for (const row of rows) expect(row.textContent).toContain("head unknown");
});

test("an empty list says so, and the Review rules moved to this toolbar", async () => {
  await render(async () => snapshot([]));
  expect(document.body.textContent).toContain("No Keryx reviews yet");
  expect(has("Review rules")).toBe(true);
});

test("AC8 the indicator lights for needs_answer, ready with a publication to choose and stopped, and stays off otherwise", async () => {
  const cases: Array<[Partial<ReviewSummary>, ReviewsTabIndicator]> = [
    [{ state: "needs_answer" }, "attention"],
    [{ state: "ready", publication: "pending" }, "attention"],
    // Partial, budget or an imported package: no publication decision applies.
    [{ state: "ready", publication: null }, null],
    [{ state: "stopped", publication: null }, "attention"],
    // An archived Review never waits on the viewer; without its PR card only a question does.
    [{ state: "stopped", publication: null, archived: true }, null],
    [{ state: "stopped", publication: null, card: null }, null],
    [{ state: "needs_answer", card: null }, "attention"],
    [{ state: "ready", publication: "skipped" }, null],
    [{ state: "running", publication: null }, null],
    [{ state: "queued", publication: null }, null],
    [{ state: "published", publication: "published" }, null],
    [{ state: "closed" }, null],
  ];
  for (const [extra, expected] of cases) {
    let indicator: ReviewsTabIndicator | undefined;
    // Hidden: the view stays mounted on other tabs and still reports.
    await render(async () => snapshot([review(4, extra)]), { active: false, onIndicatorChange: value => { indicator = value; } });
    expect([extra.state, extra.publication, indicator]).toEqual([extra.state, extra.publication, expected]);
  }
  let indicator: ReviewsTabIndicator | undefined;
  await render(async () => snapshot([]), { onIndicatorChange: value => { indicator = value; } });
  expect(indicator).toBeNull();
});

test("state matrix: a failed first load offers Try again, a failed refresh keeps the last list and indicator, lost access clears everything", async () => {
  let failure = "unavailable: GitHub timed out";
  let indicator: ReviewsTabIndicator | undefined;
  const reviews = [review(3, { state: "needs_answer" }), review(4)];
  await render(async () => { if (failure) throw new Error(failure); return snapshot(reviews); }, { onIndicatorChange: value => { indicator = value; } });
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("GitHub timed out");
  expect(document.body.textContent).not.toContain("No Keryx reviews yet");
  expect(indicator).toBeNull();
  failure = "";
  await click(button("Try again"));
  expect(document.body.querySelector('[role="alert"]')).toBeNull();
  expect(indicator).toBe("attention");
  await click(tile(4));
  expect(document.body.querySelector('aside[aria-label="Review of pull request #4"]')).not.toBeNull();
  failure = "unavailable: offline";
  await click(button("Refresh reviews"));
  expect(document.body.textContent).toContain("Last available list");
  expect(document.body.textContent).toContain("Change 3");
  expect(document.body.querySelector('aside[aria-label="Review of pull request #4"]')).not.toBeNull();
  expect(indicator).toBe("attention");
  failure = "access: Permission revoked";
  await click(button("Try again"));
  expect(document.body.textContent).toContain("Permission revoked");
  expect(document.body.textContent).not.toContain("Change 3");
  expect(document.body.textContent).not.toContain("Signed in as ann");
  expect(document.body.querySelector("aside.review-panel")).toBeNull();
  expect(indicator).toBeNull();
});

test("state matrix: refresh keeps the selection while the Review exists; an account change closes it and resets the filters", async () => {
  let reviews = [review(4), review(5, { state: "stopped" })];
  let viewer = "ann";
  await render(async () => snapshot(reviews, viewer));
  await click(tile(4));
  await click(button("Refresh reviews"));
  expect(document.body.querySelector('aside[aria-label="Review of pull request #4"]')).not.toBeNull();
  reviews = [review(5, { state: "stopped" })];
  await click(button("Refresh reviews"));
  expect(document.body.querySelector("aside.review-panel")).toBeNull();
  await click(tile(5));
  await choose("Review state", "stopped");
  viewer = "bob";
  await click(button("Refresh reviews"));
  expect(document.body.querySelector("aside.review-panel")).toBeNull();
  expect(document.body.querySelector<HTMLSelectElement>('select[aria-label="Review state"]')!.value).toBe("");
  expect(document.body.textContent).toContain("Signed in as bob");
});

test("state matrix: a late response for the previous project is dropped", async () => {
  let finish!: (value: ReviewsSnapshot) => void;
  const old = new Promise<ReviewsSnapshot>(resolve => { finish = resolve; });
  const load: typeof fetchReviews = cwd => cwd === "/old" ? old : Promise.resolve(snapshot([review(4, { card: card(4, "Current project review") })]));
  const key = ++renderKey;
  await render(load, { cwd: "/old" }, key);
  expect(document.body.textContent).toContain("Loading reviews");
  await render(load, { cwd: "/new" }, key);
  await act(async () => finish(snapshot([review(5, { card: card(5, "Old project review") })])));
  expect(document.body.textContent).toContain("Current project review");
  expect(document.body.textContent).not.toContain("Old project review");
});

test("the list reloads on tab activation and every minute while a Review is running, also while the tab is hidden, but not in a hidden window", async () => {
  let reads = 0;
  let reviews = [review(4)];
  const load: typeof fetchReviews = async () => { reads++; return snapshot(reviews); };
  const clock: Window = window;
  const schedule = clock.setInterval, cancel = clock.clearInterval;
  const timers = new Map<number, () => void>();
  let next = -1;
  clock.setInterval = (fn, delay, ...args) => {
    if (delay !== RUNNING_RELOAD_MS || typeof fn !== "function") return schedule.call(window, fn, delay, ...args);
    const id = next--;
    timers.set(id, () => fn(...args));
    return id;
  };
  clock.clearInterval = id => { if (id === undefined || !timers.delete(id)) cancel.call(window, id); };
  try {
    const key = ++renderKey;
    await render(load, { active: false }, key);
    expect(reads).toBe(1);
    await render(load, { active: true }, key);
    expect(reads).toBe(2);
    expect(timers.size).toBe(0);
    reviews = [review(4, { state: "running", publication: null })];
    await click(button("Refresh reviews"));
    expect(reads).toBe(3);
    expect(timers.size).toBe(1);
    await act(async () => { [...timers.values()][0]!(); });
    expect(reads).toBe(4);
    // Hidden tab: the indicator still follows the running Review.
    await render(load, { active: false }, key);
    expect(timers.size).toBe(1);
    await act(async () => { [...timers.values()][0]!(); });
    expect(reads).toBe(5);
    // A hidden window reads for nobody.
    const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      await act(async () => { [...timers.values()][0]!(); });
      expect(reads).toBe(5);
    } finally {
      if (visibility) Object.defineProperty(document, "visibilityState", visibility);
      else delete (document as { visibilityState?: unknown }).visibilityState;
    }
    reviews = [review(4)];
    await act(async () => { [...timers.values()][0]!(); });
    expect(reads).toBe(6);
    expect(timers.size).toBe(0);
  } finally {
    clock.setInterval = schedule;
    clock.clearInterval = cancel;
  }
});

test("a hidden Reviews tab re-reads its list on a session review snapshot and on the PR watcher's poll", async () => {
  const { publishSessionReview } = await import("../platform/reviewRuns");
  let reads = 0;
  let reviews = [review(4, { state: "running", publication: null })];
  let indicator: ReviewsTabIndicator | undefined;
  const load: typeof fetchReviews = async () => { reads++; return snapshot(reviews); };
  const key = ++renderKey;
  const show = (reloadSignal: number) => render(load, { active: false, reloadSignal, onIndicatorChange: value => { indicator = value; } }, key);
  await show(0);
  expect([reads, indicator]).toEqual([1, null]);
  reviews = [review(4, { state: "ready", publication: "pending" })];
  await act(async () => publishSessionReview("/project", { repo: "org/repo", repositoryId: "repo1", viewer: "ann", number: 4 }, { version: 1, runs: [] }));
  expect([reads, indicator]).toEqual([2, "attention"]);
  // Another project's session review is not this list's.
  await act(async () => publishSessionReview("/other", { repo: "org/repo", repositoryId: "repo1", viewer: "ann", number: 4 }, { version: 1, runs: [] }));
  expect(reads).toBe(2);
  reviews = [review(4, { state: "published", publication: "published" })];
  await show(1);
  expect([reads, indicator]).toEqual([3, null]);
  await show(1);
  expect(reads).toBe(3);
});

test("AC7 the Review panel shows the rounds timeline and the review interface, with a link to the previous attempt", async () => {
  const first = attempt("11111111-first", 1, { state: "partial", coverage: "partial", createdAt: "2026-11-18T10:00:00Z" });
  const retry = attempt("22222222-retry", 1, { previousRunId: first.id, state: "failed", coverage: null, reviewed: null, createdAt: "2026-11-18T11:00:00Z" });
  const latest = attempt("33333333-latest", 2, { previousRunId: retry.id, baseSha: "e".repeat(40), headSha: "f".repeat(40) });
  const item = review(4, { latestRound: 2, rounds: [
    { number: 2, baseSha: "e".repeat(40), headSha: "f".repeat(40), previousRunId: retry.id, attempts: [latest] },
    { number: 1, baseSha: "b".repeat(40), headSha: "c".repeat(40), previousRunId: null, attempts: [retry, first] },
  ] });
  const complete: DeskRun = { id: latest.id, scope: DESK_RUN_SCOPE, baseSha: "base4", headSha: "head4", source: "manual", state: "completed",
    phase: "Consolidated", reason: "", createdAt: time, startedAt: time, finishedAt: time,
    result: { reviewed: { baseSha: "base4", headSha: "head4" }, verdict: "COMMENT", coverage: "complete", findings: { blocker: 0, major: 0, minor: 0, info: 0 }, report: "Fine" } };
  await render(async () => snapshot([item]), { runCommand: async () => ({ version: 1, runs: [complete] }) });
  await click(tile(4));
  const panel = document.body.querySelector('aside[aria-label="Review of pull request #4"]')!;
  const rounds = panel.querySelector('section[aria-label="Rounds"]')!;
  expect([...rounds.querySelectorAll(".review-round-head strong")].map(s => s.textContent)).toEqual(["Round 2", "Round 1"]);
  expect(rounds.textContent).toContain("eeeeeee → fffffff");
  expect(rounds.textContent).toContain("bbbbbbb → ccccccc");
  expect(rounds.textContent).toContain("2 attempts");
  expect(rounds.textContent).toContain("Coverage partial");
  expect(rounds.textContent).toContain("Failed");
  const link = [...rounds.querySelectorAll<HTMLButtonElement>("button.link-btn")].find(b => b.textContent === "after 11111111")!;
  // The accessible name starts with the visible text (WCAG 2.5.3).
  expect(link.getAttribute("aria-label")?.startsWith("after 11111111")).toBe(true);
  await click(link);
  expect(document.activeElement?.textContent).toContain("Run 11111111");
  // The review interface: primary action, history, latest attempt with report and publication.
  expect(panel.querySelector('section[aria-label="Latest Keryx review"]')).not.toBeNull();
  expect(panel.querySelector(".review-run-history button")?.textContent).toContain("History");
  expect(has("View review result")).toBe(true);
  expect(panel.querySelector(".desk-run-report summary")?.textContent).toBe("Open review report");
  await click(button("Close review"));
  expect(document.body.querySelector("aside.review-panel")).toBeNull();
});

test("a focus request from Pull requests opens that Review, re-reading once when it is not listed yet", async () => {
  let reads = 0;
  let reviews = [review(4), review(5, { state: "closed" })];
  const load: typeof fetchReviews = async () => { reads++; return snapshot(reviews); };
  const key = ++renderKey;
  await render(load, { focus: { repo: "org/repo", number: 4, nonce: 1 } }, key);
  expect(document.body.querySelector('aside[aria-label="Review of pull request #4"]')).not.toBeNull();
  await choose("Review state", "ready");
  await render(load, { focus: { repo: "org/repo", number: 5, nonce: 2 } }, key);
  // A closed Review is revealed: the closed column is shown and the filter that hid it is cleared.
  expect(document.body.querySelector('aside[aria-label="Review of pull request #5"]')).not.toBeNull();
  expect(button("Show closed").getAttribute("aria-pressed")).toBe("true");
  expect(document.body.querySelector<HTMLSelectElement>('select[aria-label="Review state"]')!.value).toBe("");
  const before = reads;
  reviews = [...reviews, review(6)];
  await render(load, { focus: { repo: "org/repo", number: 6, nonce: 3 } }, key);
  expect(reads).toBe(before + 1);
  expect(document.body.querySelector('aside[aria-label="Review of pull request #6"]')).not.toBeNull();
  await render(load, { focus: { repo: "org/repo", number: 99, nonce: 4 } }, key);
  expect(reads).toBe(before + 2);
  expect(document.body.textContent).toContain("Pull request #99 has no Keryx review in this list.");
});

test("an answer intent carried from Pull requests opens the waiting question in the Review panel", async () => {
  const item = review(4, { state: "needs_answer" });
  const run: DeskRun = { id: "run-4", baseSha: "base4", headSha: "head4", source: "manual", state: "running", phase: "Review", reason: "",
    createdAt: time, startedAt: time, finishedAt: null, result: null, pendingQuestion: { id: "scope", question: "Which scope?", options: [], allowFreeform: true } };
  await render(async () => snapshot([item]), { runCommand: async () => ({ version: 1, runs: [run] }),
    focus: { repo: "org/repo", number: 4, nonce: 1, intent: { kind: "answer", baseSha: "base4", headSha: "head4" } } });
  expect(document.querySelector(".review-question")?.textContent).toContain("Which scope?");
});

test("an answer intent is consumed once: returning to the tab does not open the question again", async () => {
  const run: DeskRun = { id: "run-4", baseSha: "base4", headSha: "head4", source: "manual", state: "running", phase: "Review", reason: "",
    createdAt: time, startedAt: time, finishedAt: null, result: null, pendingQuestion: { id: "scope", question: "Which scope?", options: [], allowFreeform: true } };
  const key = ++renderKey;
  const focus = { repo: "org/repo", number: 4, nonce: 1, intent: { kind: "answer" as const, baseSha: "base4", headSha: "head4" } };
  const props = { runCommand: async () => ({ version: 1 as const, runs: [run] }), focus };
  await render(async () => snapshot([review(4, { state: "needs_answer" })]), props, key);
  const dialog = document.querySelector<HTMLElement>(".review-question")!.closest<HTMLElement>('[role="dialog"]')!;
  await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(document.querySelector(".review-question")).toBeNull();
  await render(async () => snapshot([review(4, { state: "needs_answer" })]), { ...props, active: false }, key);
  await render(async () => snapshot([review(4, { state: "needs_answer" })]), { ...props, active: true }, key);
  expect(document.body.querySelector('aside[aria-label="Review of pull request #4"]')).not.toBeNull();
  expect(document.querySelector(".review-question")).toBeNull();
});

test("a focus request names its repository: the Reviews tab switches to it and matches repository and number", async () => {
  const repos: Array<string | undefined> = [];
  const load: typeof fetchReviews = async (_cwd, repo) => {
    repos.push(repo);
    const name = repo ?? "a/x";
    return { ...snapshot([review(7, { card: card(7, "In " + name) })]), repo: name, repositories: ["a/x", "b/y"], repositoryId: name === "a/x" ? "RA" : "RB" };
  };
  const handled: number[] = [];
  await render(load, { focus: { repo: "b/y", repositoryId: "RB", number: 7, nonce: 1 }, onFocusHandled: nonce => { handled.push(nonce); } });
  expect(repos).toEqual([undefined, "b/y"]);
  expect(document.body.querySelector('aside[aria-label="Review of pull request #7"]')?.textContent).toContain("In b/y");
  expect(handled).toEqual([1]);
});

test("a handled focus request never replays: not after a base repository switch, nor after a failed access is retried", async () => {
  let failure = "";
  const load: typeof fetchReviews = async (_cwd, repo) => {
    if (failure) throw new Error(failure);
    const name = repo ?? "a/x";
    return { ...snapshot([review(7, { card: card(7, "In " + name) })]), repo: name, repositories: ["a/x", "b/y"], repositoryId: name === "a/x" ? "RA" : "RB" };
  };
  const key = ++renderKey;
  const focus = { repo: "a/x", number: 7, nonce: 1 };
  await render(load, { focus }, key);
  await click(button("Close review"));
  await choose("Base repository", "b/y");
  expect(document.body.textContent).toContain("In b/y");
  expect(document.body.querySelector("aside.review-panel")).toBeNull();
  expect(document.body.textContent).not.toContain("has no Keryx review");
  // Lost access while a request waits: the request is dropped with the list, so Try again does not select #8.
  failure = "access: Permission revoked";
  await render(load, { focus: { repo: "b/y", number: 8, nonce: 2 } }, key);
  failure = "";
  await click(button("Try again"));
  expect(document.body.querySelector("aside.review-panel")).toBeNull();
  expect(document.body.textContent).not.toContain("has no Keryx review");
});

test("AC7 the Pull requests panel has no review interface and offers Open in Reviews once the PR has a Review", async () => {
  const opened: number[] = [];
  const detail = async () => ({ version: 1 as const, viewer: "ann", repositoryId: "repo1", number: 4, headSha: "head4", fetchedAt: time,
    comments: [], reviews: [], threads: [], checks: [], warnings: [] });
  const run: DeskRun = { id: "run-4", baseSha: "base4", headSha: "head4", source: "manual", state: "completed", phase: "Done", reason: "",
    createdAt: time, startedAt: time, finishedAt: time, result: null };
  const show = (runs: DeskRun[]) => act(async () => root.render(createElement(ReviewDetail, {
    key: ++renderKey, cwd: "/project", repo: "org/repo", repositoryId: "repo1", viewer: "ann", card: card(4), load: detail,
    runCommand: async () => ({ version: 1 as const, runs }), onOpenInReviews: () => { opened.push(4); }, onClose: () => {},
  })));
  await show([]);
  expect([...document.body.querySelectorAll(".tabs button")].map(b => b.textContent)).toEqual(["Discussion", "Checks", "Automation"]);
  expect(has("Start review")).toBe(true);
  expect(has("Open in Reviews")).toBe(false);
  expect(document.body.querySelector('section[aria-label="Latest Keryx review"]')).toBeNull();
  // An archived run still has a Review in the Reviews tab (under Show closed), where History offers Restore and Delete.
  await show([{ ...run, decision: { action: "archive", reason: "old", at: time } }]);
  expect(has("Open in Reviews")).toBe(true);
  await show([run]);
  expect(document.body.querySelector(".review-run-history")).toBeNull();
  await click(button("Open in Reviews"));
  expect(opened).toEqual([4]);
});

test("the Pull requests panel takes only a start intent: a view or answer intent starts nothing there", async () => {
  const detail = async () => ({ version: 1 as const, viewer: "ann", repositoryId: "repo1", number: 4, headSha: "head4", fetchedAt: time,
    comments: [], reviews: [], threads: [], checks: [], warnings: [] });
  for (const kind of ["view", "answer", "start"] as const) {
    const actions: string[] = [];
    await act(async () => root.render(createElement(ReviewDetail, {
      key: ++renderKey, cwd: "/project", repo: "org/repo", repositoryId: "repo1", viewer: "ann", card: card(4), load: detail,
      reviewIntent: { kind, baseSha: "base4", headSha: "head4" },
      runCommand: async (_cwd, _key, action) => { actions.push(action.kind); return { version: 1 as const, runs: [] }; }, onClose: () => {},
    })));
    expect([kind, actions.includes("start")]).toEqual([kind, kind === "start"]);
  }
});

test("the Pull requests panel shows a failed run-status read next to its primary action", async () => {
  const detail = async () => ({ version: 1 as const, viewer: "ann", repositoryId: "repo1", number: 4, headSha: "head4", fetchedAt: time,
    comments: [], reviews: [], threads: [], checks: [], warnings: [] });
  await act(async () => root.render(createElement(ReviewDetail, {
    key: ++renderKey, cwd: "/project", repo: "org/repo", repositoryId: "repo1", viewer: "ann", card: card(4), load: detail,
    runCommand: async () => { throw new Error("unavailable: Review status could not be read."); }, onClose: () => {},
  })));
  const alert = [...document.body.querySelectorAll('[role="alert"]')].find(node => node.textContent?.includes("Review status could not be read"));
  expect(alert?.closest(".sheet-head")).not.toBeNull();
});

// Moved with the Review rules button from the Pull requests toolbar.
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

test("the Review rules dialog renders under document.body so the board's containment cannot trap its scrim", async () => {
  await render(async () => snapshot([review(4)]), { rulesCommand: rulesBackend([]).command });
  await click(button("Review rules"));
  const dialog = document.body.querySelector('[role="dialog"]');
  expect(dialog?.closest(".review-board")).toBeNull();
  expect(dialog?.closest(".overlay")?.parentElement).toBe(document.body);
  await click(button("Close"));
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
});

test("project rule previews its scope and budgets, can be disabled, edited and deleted", async () => {
  const backend = rulesBackend([]);
  await render(async () => snapshot([review(4)]), { rulesCommand: backend.command });
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

test("a rules dialog pending for a previous account cannot expose that account's rules", async () => {
  let resolveRules!: (s: ReviewRuleSnapshot) => void;
  const old = () => new Promise<ReviewRuleSnapshot>(resolve => { resolveRules = resolve; });
  let viewer = "ann";
  await render(async () => snapshot([review(4)], viewer), { rulesCommand: old });
  await click(button("Review rules"));
  expect(document.body.querySelector('[aria-label="Loading rules"]')).not.toBeNull();
  viewer = "other";
  await act(async () => { document.body.querySelector<HTMLElement>('[role="dialog"] button')!.focus(); });
  await click(button("Refresh reviews"));
  await act(async () => resolveRules({ version: 1, rules: [{ ...automationRule, name: "Previous account secret rule" }], choice: { mode: "project" }, activity: [] }));
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).not.toContain("Previous account secret rule");
  // The dialog that held focus is gone with the previous account: focus lands on search, not on the page body.
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Search reviews");
});

test("Review rules stay reachable when the list cannot be read, from the Pull requests board's identity", async () => {
  const fallback = { repo: "org/repo", repositoryId: "repo1", viewer: "ann" };
  await render(async () => { throw new Error("unavailable: Unknown command: reviews"); }, { rulesTarget: fallback, expectedViewer: "ann" });
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("Unknown command");
  expect(has("Review rules")).toBe(true);
  // Another account's identity is not used.
  await render(async () => { throw new Error("unavailable: Unknown command: reviews"); }, { rulesTarget: { ...fallback, viewer: "bob" }, expectedViewer: "ann" });
  expect(has("Review rules")).toBe(false);
});

test("an archived Review is listed under Show closed as Archived, and its panel History reaches Restore", async () => {
  const archivedRun: DeskRun = { id: "run-5", baseSha: "base5", headSha: "head5", source: "manual", state: "completed", phase: "Done", reason: "",
    createdAt: time, startedAt: time, finishedAt: time, result: null, decision: { action: "archive", reason: "old", at: time } };
  await render(async () => snapshot([review(4), review(5, { state: "stopped", archived: true })]),
    { runCommand: async () => ({ version: 1, runs: [archivedRun] }) });
  expect(numbersIn(document.body.querySelector(".board"))).toEqual(["#4"]);
  expect(button("Show closed").getAttribute("title")).toBe("Show closed (1)");
  await click(button("Show closed"));
  expect(numbersIn(lane("Closed"))).toEqual(["#5"]);
  expect(lane("Closed")!.querySelector(".badge")?.textContent).toBe("Archived");
  await click(tile(5));
  await click(document.body.querySelector<HTMLButtonElement>(".review-run-history button")!);
  await click(document.body.querySelector<HTMLElement>('[role="menuitem"]')!);
  expect(has("Restore review")).toBe(true);
});

test("closed Reviews' PR cards are read only while Show closed is on", async () => {
  const calls: boolean[] = [];
  await render(async (_cwd, _repo, _viewer, includeClosed) => {
    calls.push(!!includeClosed);
    return snapshot([review(4), review(9, { state: "closed", card: null })]);
  });
  expect(calls).toEqual([false]);
  await click(button("Show closed"));
  expect(calls).toEqual([false, true]);
  // A closed Review read without its card shows the PR number only.
  expect(tile(9).textContent).toContain("Pull request #9");
});

test("a Review without its PR card offers Refresh next to the reason", async () => {
  let reads = 0;
  await render(async () => { reads++; return snapshot([review(4, { card: null })]); });
  await click(tile(4));
  const panel = document.body.querySelector('aside[aria-label="Review of pull request #4"]')!;
  const banner = panel.querySelector(".inline-banner")!;
  expect(banner.textContent).toContain("GitHub did not return this pull request");
  await click([...banner.querySelectorAll("button")].find(b => b.textContent === "Refresh")!);
  expect(reads).toBe(2);
});

test("a filter select shows its selected value in full through its title", async () => {
  await render(async () => snapshot([review(4)]));
  const state = () => document.body.querySelector<HTMLSelectElement>('select[aria-label="Review state"]')!;
  expect(state().title).toBe("All states");
  await choose("Review state", "needs_answer");
  expect(state().title).toBe("Needs your answer");
  await choose("Source", "existing");
  expect(document.body.querySelector<HTMLSelectElement>('select[aria-label="Source"]')!.title).toBe("Existing review");
});

test("a mutation in the Review panel re-reads the list once; opening the panel does not", async () => {
  let reads = 0;
  let runs: DeskRun[] = [];
  const started: DeskRun = { id: "run-new", baseSha: "base4", headSha: "head4", source: "manual", state: "queued", phase: "Queued", reason: "",
    createdAt: time, startedAt: null, finishedAt: null, result: null };
  const command: typeof reviewRun = async (_cwd, _key, action) => {
    if (action.kind === "start") runs = [started];
    return { version: 1, runs, ...(action.kind === "start" && { startedRunId: started.id }) };
  };
  await render(async () => { reads++; return snapshot([review(4, { state: "stopped" })]); }, { runCommand: command });
  await click(tile(4));
  expect(reads).toBe(1);
  await click(button("Start review"));
  expect(reads).toBe(2);
});

test("the Reviews card and list open the originating chat and retain a separate details action", async () => {
  const opened: string[] = [];
  const linked = review(14, { sessionId: "original-chat", state: "running" });
  await render(async () => snapshot([linked]), {
    onOpenOriginSession: async sessionId => { opened.push(sessionId); },
  });
  await click(tile(14));
  expect(opened).toEqual(["original-chat"]);
  expect(document.querySelector('aside[aria-label="Review of pull request #14"]')).toBeNull();
  await click(button("Review details for #14"));
  expect(document.querySelector('aside[aria-label="Review of pull request #14"]')).not.toBeNull();
  await click(button("Close review"));
  await click(button("List"));
  await click(document.querySelector<HTMLButtonElement>(".review-list-link")!);
  expect(opened).toEqual(["original-chat", "original-chat"]);
  expect(has("Review details for #14")).toBe(true);
});

test("the Review panel resizes with its left-edge handle and keeps its width while another Review opens", async () => {
  await render(async () => snapshot([review(4, { state: "ready" }), review(8, { state: "published", publication: "published" })]));
  await click(tile(4));
  const panel = () => document.body.querySelector<HTMLElement>("aside.review-panel")!;
  expect(panel().style.width).toBe("560px");
  const handle = document.body.querySelector<HTMLElement>('[aria-label="Resize review details"]')!;
  expect(handle.getAttribute("role")).toBe("separator");
  await act(async () => { handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  expect(panel().style.width).toBe("528px");
  await click(tile(8));
  expect(panel().getAttribute("aria-label")).toBe("Review of pull request #8");
  expect(panel().style.width).toBe("528px");
});

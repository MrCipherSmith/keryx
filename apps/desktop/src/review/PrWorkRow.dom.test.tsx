import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Root } from "react-dom/client";
import type { SessionInfo, SessionSubject } from "../acp/types";
import type { FlowCard } from "../platform/commands";
import type { fetchReviewBoard } from "../platform/review";
import type { reviewRules } from "../platform/reviewRules";
import type { ReviewWatcherSnapshot } from "../platform/reviewWatcher";
import { registerDom, unregisterDom } from "../test/dom";
import { EMPTY_FILTERS } from "./model";
import { reviewFilterKey, saveReviewFilters } from "./reviewFilterStorage";
import type { PrFlowOffer, SubjectSessionTarget } from "./prWork";
import type { ReviewBoardSnapshot, ReviewCard } from "./types";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let useState: typeof import("react").useState;
let ReviewBoard: typeof import("./ReviewBoard").ReviewBoard;
let PrWorkRow: typeof import("./PrWorkRow").PrWorkRow;
let prWorkIndex: typeof import("./prWork").prWorkIndex;
let publishSessionReview: typeof import("../platform/reviewRuns").publishSessionReview;
let renderKey = 0;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  useState = React.useState;
  ({ ReviewBoard } = await import("./ReviewBoard"));
  ({ PrWorkRow } = await import("./PrWorkRow"));
  ({ prWorkIndex } = await import("./prWork"));
  ({ publishSessionReview } = await import("../platform/reviewRuns"));
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
  author: "lee", assignees: [], reviewers: [], ci: "passed", decision: "REVIEW_REQUIRED",
  updatedAt: "2026-11-10T01:00:00Z", headSha: "b", baseSha: "a",
};
const subject: SessionSubject = { kind: "pr", repo: "org/repo", number: 101, url: pr.url };
const board = (cards: ReviewCard[]): ReviewBoardSnapshot =>
  ({ version: 1, repo: "org/repo", repositories: ["org/repo"], repositoryId: "repo1", viewer: "ann", fetchedAt: pr.updatedAt, cards, warnings: [] });
const flow = (id: string, extra: Partial<FlowCard> = {}): FlowCard => ({
  id, dir: id + "-work", idValid: true, commandRef: null, title: "Work " + id, status: "in-progress", previousStatus: null,
  blocked: false, owner: null, prUrl: null, baseBranch: null, tasksDone: 0, tasksTotal: 0, acTotal: 0, acConfirmed: 0,
  updatedAt: null, completionExceptions: false, error: null, ...extra,
});
const session = (id: string, title: string, flags: Record<string, unknown>, updatedAt: string): SessionInfo =>
  ({ sessionId: id, cwd: "/project", title, updatedAt, _meta: { keryx: flags } });
const watcherOff: ReviewWatcherSnapshot = { version: 1, state: "disabled", installed: false, intervalMinutes: 5,
  lastAttemptAt: null, lastSuccessAt: null, lastError: null, events: [] };
const rules: typeof reviewRules = async () => ({ version: 1, rules: [], subscriptions: [] }) as unknown as Awaited<ReturnType<typeof reviewRules>>;

interface Calls { flows: string[]; created: number[]; sessions: Array<[number, SubjectSessionTarget, SessionSubject]>; linked?: PrFlowOffer[]; dismissed?: PrFlowOffer[] }
function render(cards: ReviewCard[], extra: { flows?: FlowCard[]; sessions?: SessionInfo[]; calls?: Calls; offers?: PrFlowOffer[] } = {}) {
  const calls = extra.calls ?? { flows: [], created: [], sessions: [] };
  const load: typeof fetchReviewBoard = async () => board(cards);
  return act(async () => {
    root.render(createElement(ReviewBoard, {
      key: ++renderKey, cwd: "/project", flows: extra.flows ?? [], sessions: extra.sessions ?? [], load,
      listRepositories: async () => [], watcherCommand: async () => watcherOff, rulesCommand: rules,
      onOpenFlow: dir => calls.flows.push(dir),
      onCreateFlow: card => calls.created.push(card.number),
      onOpenSubjectSession: (card, target, value) => calls.sessions.push([card.number, target, value]),
      flowOffers: extra.offers ?? [],
      onLinkFlowOffer: offer => calls.linked?.push(offer),
      onDismissFlowOffer: offer => calls.dismissed?.push(offer),
    }));
  });
}
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });
const rows = () => [...document.body.querySelectorAll<HTMLElement>(".pr-work-row")];
const button = (label: string) => {
  const el = [...document.body.querySelectorAll("button")].find(b => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
  if (!el) throw new Error("Missing button " + label);
  return el;
};
/** The row's element tree without text or state classes: what must not change between empty and filled slots. */
function shape(el: Element): string {
  const slot = el.getAttribute("data-slot");
  return `${el.tagName}${slot ? `[${slot}]` : ""}(${[...el.children].map(shape).join(",")})`;
}
const linked = {
  flows: [flow("517", { prUrl: pr.url })],
  sessions: [session("s1", "First", { subject }, "2026-11-20T00:00:00Z"), session("s2", "Second", { subject }, "2026-11-21T00:00:00Z")],
};
const reviewed: ReviewCard = { ...pr, localReview: { active: false, ready: true, runState: "completed" } };

test("the work row has three slots in order, the same elements with no link and with three, in board and list", async () => {
  await render([pr, { ...reviewed, number: 102, url: pr.url.replace("101", "102") }], {
    flows: [flow("517", { prUrl: pr.url.replace("101", "102") })],
    sessions: [session("s1", "First", { subject: { ...subject, number: 102, url: pr.url.replace("101", "102") } }, "2026-11-20T00:00:00Z")],
  });
  for (const mode of ["Board", "List"]) {
    await click(button(mode));
    const byNumber = new Map(rows().map(row => [row.getAttribute("aria-label"), row]));
    const empty = byNumber.get("Keryx work for #101")!;
    const full = byNumber.get("Keryx work for #102")!;
    expect([...empty.children].map(slot => slot.getAttribute("data-slot"))).toEqual(["review", "flow", "session"]);
    expect(shape(empty)).toBe(shape(full));
    expect([...empty.querySelectorAll(".pr-work-link")].map(b => b.textContent)).toEqual(["Run review", "Create Flow", "Open in session"]);
    expect([...full.querySelectorAll(".pr-work-link")].map(b => b.textContent)).toEqual(["Review · ready", "Flow #517 · In progress", "Session"]);
    for (const row of [empty, full]) expect(row.textContent).not.toMatch(/round|behind|отста/i);
  }
});

test("the work row has a fixed height in review.css, not a minimum, and its text truncates", () => {
  const css = readFileSync(new URL("../styles/review.css", import.meta.url), "utf8");
  const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
  const row = rule(".pr-work-row");
  expect(row).toMatch(/(^|;)\s*height:\s*\d+px/);
  expect(row).not.toContain("min-height");
  expect(row).toContain("overflow: hidden");
  expect(rule(".pr-work-slot")).toMatch(/(^|;)\s*height:\s*\d+px/);
  expect(rule(".pr-work-link")).toContain("text-overflow: ellipsis");
});

test("the slots open the review panel, the Flow, the newest bound session and the session menu", async () => {
  const calls: Calls = { flows: [], created: [], sessions: [] };
  await render([reviewed], { ...linked, calls });
  await click(button("Review · ready for #101"));
  // The review interface lives in the Reviews tab (stage 2); without it wired, the slot opens the PR panel.
  expect(document.body.querySelector(".review-detail-panel")).not.toBeNull();
  await click(button("Close details"));
  await click(button("Flow #517 · In progress for #101"));
  expect(calls.flows).toEqual(["517-work"]);
  await click(button("2 sessions for #101"));
  expect(calls.sessions).toEqual([[101, "latest", { ...subject, repositoryId: "repo1" }]]);
  const more = button("More sessions for #101");
  expect(more.getAttribute("aria-haspopup")).toBe("menu");
  await click(more);
  const items = [...document.body.querySelectorAll('[role="menu"] [role="menuitem"]')];
  expect(items.map(item => item.textContent)).toEqual(["Second", "First", "New session"]);
  await click(items[1]!);
  await click(more);
  await click([...document.body.querySelectorAll('[role="menu"] [role="menuitem"]')].at(-1)!);
  expect(calls.sessions.slice(1).map(([, target]) => target)).toEqual(["s1", "new"]);
});

test("an outdated review's slot title names the round it follows and offers a new review round", async () => {
  const outdated = (round?: number): ReviewCard => ({ ...pr, localReview: { active: false, ready: false,
    outdated: { headSha: "abcdef0123456", state: "completed", ...(round !== undefined && { round }) } } });
  await render([outdated(2)]);
  expect(button("Review · outdated for #101").title).toBe("Round 2 · Outdated review · abcdef0 — New review round");
  await render([outdated()]);
  expect(button("Review · outdated for #101").title).toBe("Outdated review · abcdef0 — New review round");
});

test("empty slots offer Run review, Create Flow and Open in session", async () => {
  const calls: Calls = { flows: [], created: [], sessions: [] };
  await render([pr], { calls });
  await click(button("Create Flow for #101"));
  expect(calls.created).toEqual([101]);
  await click(button("Open in session for #101"));
  expect(calls.sessions.map(([n, target]) => [n, target])).toEqual([[101, "latest"]]);
  await click(button("Run review for #101"));
  // The review interface lives in the Reviews tab (stage 2); without it wired, the slot opens the PR panel.
  expect(document.body.querySelector(".review-detail-panel")).not.toBeNull();
});

test("a Flow linked to a session bound to the PR is the card's Flow", async () => {
  await render([pr], { flows: [flow("520")], sessions: [session("s1", "Work", { subject, flow: "520-work" }, "2026-11-20T00:00:00Z")] });
  expect(rows()[0]!.querySelector('[data-slot="flow"] .pr-work-link')?.textContent).toBe("Flow #520 · In progress");
  // An archived session no longer links its Flow or counts as the PR's session.
  await render([pr], { flows: [flow("520")], sessions: [session("s1", "Work", { subject, flow: "520-work", archivedAt: "2026-11-21T00:00:00Z" }, "2026-11-20T00:00:00Z")] });
  expect([...rows()[0]!.querySelectorAll(".pr-work-link")].map(b => b.textContent)).toEqual(["Run review", "Create Flow", "Open in session"]);
});

test("every action on a PR card and list row has visible text, and Fix review comments is not offered", async () => {
  await render([pr, { ...reviewed, number: 102 }, { ...pr, number: 103, draft: true }], linked);
  for (const mode of ["Board", "List"]) {
    await click(button(mode));
    const containers = [...document.body.querySelectorAll(mode === "Board" ? ".review-lanes .flow-card" : ".review-table tbody tr")];
    expect(containers.length).toBe(3);
    for (const container of containers) {
      const controls = [...container.querySelectorAll("button, a")];
      expect(controls.length).toBeGreaterThan(5);
      for (const control of controls) expect(control.textContent?.trim()).not.toBe("");
      expect(container.textContent).toContain("Open on GitHub");
      expect(container.textContent).toContain("Subscribe");
    }
    expect(document.body.textContent).not.toContain("Fix review comments");
  }
});

test("a review started from a session shows on the card's review slot without a refresh", async () => {
  let loads = 0;
  await act(async () => {
    root.render(createElement(ReviewBoard, {
      key: ++renderKey, cwd: "/project", flows: [], sessions: [], onOpenFlow: () => {},
      load: async () => { loads++; return board([pr]); }, listRepositories: async () => [],
      watcherCommand: async () => watcherOff, rulesCommand: rules,
    }));
  });
  expect(rows()[0]!.querySelector('[data-slot="review"] .pr-work-link')?.textContent).toBe("Run review");
  await act(async () => {
    publishSessionReview("/project", { repo: "org/repo", repositoryId: "repo1", viewer: "ann", number: 101 }, {
      version: 1, startedRunId: "run-1", runs: [{
        id: "run-1", headSha: pr.headSha, baseSha: pr.baseSha, source: "manual", state: "running", phase: "Review",
        createdAt: pr.updatedAt, startedAt: pr.updatedAt, finishedAt: null, reason: "", result: null,
      }],
    });
  });
  expect(rows()[0]!.querySelector('[data-slot="review"] .pr-work-link')?.textContent).toBe("Review · running");
  expect(loads).toBe(1);
});

test("AC4 Keryx review state shows only in the work row: the card body and the list Reason cell hold none of it", async () => {
  const running: ReviewCard = { ...pr, localReview: { active: true, ready: false, runState: "running", lastActivityAt: pr.updatedAt,
    progress: { wave: 2, planned: 4, finished: 1, completed: 1 } } };
  const done: ReviewCard = { ...reviewed, number: 102, url: pr.url.replace("101", "102") };
  const earlier: ReviewCard = { ...pr, number: 103, url: pr.url.replace("101", "103"), localReview: { active: true, ready: false, runState: "other-revision" } };
  const failed: ReviewCard = { ...pr, number: 104, url: pr.url.replace("101", "104"), localReview: { active: false, ready: false, runState: "failed" } };
  await render([running, done, earlier, failed]);
  const keryx = /Wave|\d+%|assignments|Review completed|earlier revision|Transcript|Progress unavailable|Failed/;
  const bodies = [...document.body.querySelectorAll(".review-card")];
  expect(bodies).toHaveLength(4);
  for (const body of bodies) {
    expect(body.textContent).not.toMatch(keryx);
    expect(body.querySelector('[role="progressbar"], .review-progress-caption')).toBeNull();
  }
  // The progress moved into the review slot, which keeps the row's fixed height: it is the slot's title only.
  const slot = (n: number) => document.body.querySelector(`[aria-label="Keryx work for #${n}"] [data-slot="review"] .pr-work-link`)!;
  expect(slot(101).getAttribute("title")).toContain("Wave 2");
  expect(slot(101).getAttribute("title")).toContain("1 of 4 assignments completed");
  expect(slot(103).getAttribute("title")).toContain("Reviewing an earlier revision");
  expect(slot(101).textContent).toBe("Review · running");
  await click(button("List"));
  const reasons = [...document.body.querySelectorAll(".review-table tbody tr")].map(row => row.children[3]!);
  expect(reasons).toHaveLength(4);
  for (const reason of reasons) {
    expect(reason.textContent).not.toMatch(keryx);
    expect(reason.querySelector('[role="progressbar"], .review-progress-caption')).toBeNull();
  }
});

test("a review that waits on the viewer gets the warn tone in its slot; other states do not", async () => {
  const answer: ReviewCard = { ...pr, localReview: { active: true, ready: false, runState: "running", awaitingAnswer: true } };
  const publish: ReviewCard = { ...reviewed, number: 102, url: pr.url.replace("101", "102"), localReview: { active: false, ready: true, runState: "completed", publicationPending: true } };
  const ready: ReviewCard = { ...reviewed, number: 103, url: pr.url.replace("101", "103") };
  const running: ReviewCard = { ...pr, number: 104, url: pr.url.replace("101", "104"), localReview: { active: true, ready: false, runState: "running" } };
  await render([answer, publish, ready, running]);
  const slot = (n: number) => document.body.querySelector(`[aria-label="Keryx work for #${n}"] [data-slot="review"] .pr-work-link`)!;
  expect(slot(101).textContent).toBe("Review · needs your answer");
  expect(slot(102).textContent).toBe("Review · publication pending");
  expect(slot(101).classList.contains("is-attention")).toBe(true);
  expect(slot(102).classList.contains("is-attention")).toBe(true);
  expect(slot(103).classList.contains("is-attention")).toBe(false);
  expect(slot(104).classList.contains("is-attention")).toBe(false);
  for (const n of [101, 102, 103, 104]) expect(rows().find(row => row.getAttribute("aria-label") === `Keryx work for #${n}`)!.children).toHaveLength(3);
});

test("review.css: the work row's focus ring is drawn inside its buttons, the warn tone exists, and the unused review note rule is gone", () => {
  const css = readFileSync(new URL("../styles/review.css", import.meta.url), "utf8");
  const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*:()]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
  expect(rule(".pr-work-link:focus-visible, .pr-work-more:focus-visible")).toMatch(/outline-offset:\s*-2px/);
  expect(rule(".pr-work-row")).toContain("overflow: hidden");
  expect(rule(".pr-work-link.is-attention")).toContain("var(--warn)");
  expect(css).not.toMatch(/\.review-note\b/);
});

test("the PR panel names the same Flow as the work row, a Flow linked to a bound session included", async () => {
  await render([pr], { flows: [flow("520")], sessions: [session("s1", "Work", { subject, flow: "520-work" }, "2026-11-20T00:00:00Z")] });
  expect(rows()[0]!.querySelector('[data-slot="flow"] .pr-work-link')?.textContent).toBe("Flow #520 · In progress");
  await click(document.body.querySelector<HTMLElement>(".review-card")!);
  expect(document.body.querySelector(".review-detail-panel .review-associated-flow")?.textContent).toContain("Flow #520");
});

type Focus = { repo: string; number: number; nonce: number } | null;
/** A board whose focus the test drives; `handles` false leaves the request armed (no onFocusHandled). */
function focusHost(load: typeof fetchReviewBoard, handled: number[], handles = true) {
  let setFocus!: (focus: Focus) => void;
  function Host({ boardKey, initial }: { boardKey: number; initial: Focus }) {
    const [focus, set] = useState<Focus>(initial);
    setFocus = set;
    return createElement(ReviewBoard, {
      key: boardKey, cwd: "/project", flows: [], sessions: [], load, listRepositories: async () => [],
      watcherCommand: async () => watcherOff, rulesCommand: rules, onOpenFlow: () => {}, focus,
      ...(handles && { onFocusHandled: (nonce: number) => { handled.push(nonce); set(old => old?.nonce === nonce ? null : old); } }),
    });
  }
  return { Host, setFocus: (focus: Focus) => act(async () => setFocus(focus)) };
}
const panel = () => document.body.querySelector(".review-detail-panel");

test("the session header's PR focus opens the panel on the board of its repository, and a remount does not replay it", async () => {
  const handled: number[] = [];
  const host = focusHost(async () => board([pr]), handled);
  await act(async () => { root.render(createElement(host.Host, { key: ++renderKey, boardKey: 1, initial: null })); });
  await host.setFocus({ repo: "Org/Repo", number: 101, nonce: 2 });
  expect(panel()).not.toBeNull();
  expect(handled).toEqual([2]);
  await click(button("Close details"));
  handled.length = 0;
  // The board remounts (a repository or account switch): the handled request is gone and nothing reopens.
  await act(async () => { root.render(createElement(host.Host, { key: renderKey, boardKey: 2, initial: null })); });
  expect(panel()).toBeNull();
  expect(handled).toEqual([]);
});

test("LG-009: a focus for another repository of the board switches to it and opens the panel; one the board cannot show says so", async () => {
  const handled: number[] = [];
  const requested: Array<string | undefined> = [];
  const other: ReviewCard = { ...pr, number: 7, url: "https://github.com/org/other/pull/7", title: "Other repository PR" };
  const load: typeof fetchReviewBoard = async (_cwd, _state, repo) => {
    requested.push(repo);
    const snapshot = repo === "org/other" ? { ...board([other]), repo: "org/other", repositoryId: "repo2" } : board([pr]);
    return { ...snapshot, repositories: ["org/repo", "org/other"] };
  };
  const host = focusHost(load, handled);
  await act(async () => { root.render(createElement(host.Host, { key: ++renderKey, boardKey: 1, initial: null })); });
  await host.setFocus({ repo: "Org/Other", number: 7, nonce: 1 });
  expect(requested.at(-1)).toBe("org/other");
  expect(panel()?.textContent).toContain("Other repository PR");
  expect(handled).toEqual([1]);
  expect(document.body.querySelector(".review-focus-notice")).toBeNull();
  await click(button("Close details"));
  // A repository the board does not list: no panel, a visible notice, and the request is handled (not left armed).
  await host.setFocus({ repo: "elsewhere/project", number: 3, nonce: 2 });
  expect(panel()).toBeNull();
  expect(handled).toEqual([1, 2]);
  expect(document.body.querySelector(".review-focus-notice")?.textContent).toContain("elsewhere/project#3");
  await click(button("Dismiss notice"));
  expect(document.body.querySelector(".review-focus-notice")).toBeNull();
});

test("a focus that nobody clears opens the panel once per nonce, not again after a refresh", async () => {
  let loads = 0;
  const host = focusHost(async () => { loads++; return board([pr]); }, [], false);
  await act(async () => { root.render(createElement(host.Host, { key: ++renderKey, boardKey: 1, initial: { repo: "org/repo", number: 101, nonce: 5 } })); });
  expect(panel()).not.toBeNull();
  await click(button("Close details"));
  await click(button("Refresh pull requests"));
  expect(loads).toBe(2);
  expect(panel()).toBeNull();
  // A new nonce opens it again.
  await host.setFocus({ repo: "org/repo", number: 101, nonce: 6 });
  expect(panel()).not.toBeNull();
});

const notice = () => document.body.querySelector(".review-focus-notice");
const merged: ReviewCard = { ...pr, number: 55, title: "Merged PR", state: "merged", url: pr.url.replace("101", "55") };

test("FE-R3-001: a focus for a PR missing from the loaded list is refused with a notice, and a later load that holds it opens nothing", async () => {
  const handled: number[] = [];
  let loads = 0;
  const host = focusHost(async () => ++loads === 1 ? board([pr]) : board([pr, merged]), handled);
  await act(async () => { root.render(createElement(host.Host, { key: ++renderKey, boardKey: 1, initial: null })); });
  await host.setFocus({ repo: "org/repo", number: 55, nonce: 1 });
  expect(panel()).toBeNull();
  expect(handled).toEqual([1]);
  expect(notice()?.textContent).toContain("#55 is not in the current list of org/repo");
  // The next load holds the PR (its state now shown): the refused request does not open it.
  await click(button("Refresh pull requests"));
  expect(loads).toBe(2);
  expect(panel()).toBeNull();
});

test("FE-R3-001: a focus that arrives while a load runs waits for that load before it decides", async () => {
  let release!: () => void;
  let loads = 0;
  const load: typeof fetchReviewBoard = async () => {
    if (++loads === 1) return board([pr]);
    await new Promise<void>(resolve => { release = resolve; });
    return board([pr, merged]);
  };
  const host = focusHost(load, []);
  await act(async () => { root.render(createElement(host.Host, { key: ++renderKey, boardKey: 1, initial: null })); });
  await click(button("Refresh pull requests"));
  await host.setFocus({ repo: "org/repo", number: 55, nonce: 1 });
  expect(notice()).toBeNull();
  await act(async () => release());
  expect(panel()?.textContent).toContain("Merged PR");
});

test("TP-R4-002: a focus that arrives while a cached fallback snapshot shows waits for a good load before it decides", async () => {
  // A saved period filter: the first loads are that period view and the Open seed, whose snapshot is cached.
  saveReviewFilters(reviewFilterKey("/project", "repo1", "ann"), { ...EMPTY_FILTERS, updatedWithin: 7 });
  const fresh: ReviewCard = { ...pr, number: 77, title: "Fresh PR", url: pr.url.replace("101", "77") };
  let offline = false;
  let holdsFresh = false;
  const handled: number[] = [];
  const host = focusHost(async (_cwd, _state, _repo, _signal, _viewer, updatedSince) => {
    if (updatedSince) return board([pr]);
    if (offline) throw new Error("unavailable: offline");
    return board(holdsFresh ? [pr, fresh] : [pr]);
  }, handled);
  await act(async () => { root.render(createElement(host.Host, { key: ++renderKey, boardKey: 1, initial: null })); });
  offline = true;
  // The Open view cannot load: the board shows the cached Open snapshot, which predates #77.
  await click(button("Clear filters"));
  expect(document.body.textContent).toContain("Last available snapshot");
  await host.setFocus({ repo: "org/repo", number: 77, nonce: 1 });
  expect(notice()).toBeNull();
  expect(handled).toEqual([]);
  offline = false;
  holdsFresh = true;
  await click(button("Try again"));
  expect(panel()?.textContent).toContain("Fresh PR");
  expect(handled).toEqual([1]);
});

test("TP-R3-004: a refused request is marked handled, so a refresh does not raise its dismissed notice again", async () => {
  // Nobody clears the request: only the board's own record of the nonce keeps it from being refused again.
  const host = focusHost(async () => board([pr]), [], false);
  await act(async () => { root.render(createElement(host.Host, { key: ++renderKey, boardKey: 1, initial: null })); });
  for (const [nonce, focus] of [[1, { repo: "elsewhere/project", number: 3 }], [2, { repo: "org/repo", number: 55 }]] as const) {
    await host.setFocus({ ...focus, nonce });
    expect(notice()).not.toBeNull();
    await click(button("Dismiss notice"));
    await click(button("Refresh pull requests"));
    expect(notice()).toBeNull();
  }
});

test("TP-R3-004: a later focus that opens its panel clears the notice of a refused one", async () => {
  const host = focusHost(async () => board([pr]), []);
  await act(async () => { root.render(createElement(host.Host, { key: ++renderKey, boardKey: 1, initial: null })); });
  await host.setFocus({ repo: "elsewhere/project", number: 3, nonce: 1 });
  expect(notice()).not.toBeNull();
  await host.setFocus({ repo: "org/repo", number: 101, nonce: 2 });
  expect(panel()).not.toBeNull();
  expect(notice()).toBeNull();
});

test("FE-R3-002: Dismiss notice moves focus to the search field, not the page body", async () => {
  const host = focusHost(async () => board([pr]), []);
  await act(async () => { root.render(createElement(host.Host, { key: ++renderKey, boardKey: 1, initial: null })); });
  await host.setFocus({ repo: "elsewhere/project", number: 3, nonce: 1 });
  const dismiss = button("Dismiss notice");
  (dismiss as HTMLElement).focus();
  await click(dismiss);
  expect(notice()).toBeNull();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Search pull requests");
});

/**
 * A board whose offer the test drives the way App does (usePendingFlowLinks): Link first shows the offer
 * `linking` and Dismiss drops it; `set` then settles it (removed on success, kept with an error on failure).
 */
async function offerHost(offer: PrFlowOffer, flows: FlowCard[] = []) {
  const bound = [session("s1", "Work", { subject }, "2026-11-20T00:00:00Z")];
  let set!: (offers: PrFlowOffer[]) => void;
  function Host() {
    const [offers, setOffers] = useState<PrFlowOffer[]>([offer]);
    set = setOffers;
    return createElement(ReviewBoard, {
      cwd: "/project", flows, sessions: bound, load: async () => board([pr]), listRepositories: async () => [],
      watcherCommand: async () => watcherOff, rulesCommand: rules, onOpenFlow: () => {}, onCreateFlow: () => {}, onOpenSubjectSession: () => {},
      flowOffers: offers, onLinkFlowOffer: (linked: PrFlowOffer) => setOffers([{ ...linked, linking: true }]), onDismissFlowOffer: () => setOffers([]),
    });
  }
  await act(async () => { root.render(createElement(Host, { key: ++renderKey })); });
  return { set: (offers: PrFlowOffer[]) => act(async () => set(offers)) };
}
const flowSlot = (n = 101) => document.body.querySelector<HTMLElement>(`[aria-label="Keryx work for #${n}"] [data-slot="flow"]`)!;
const offerLink = () => flowSlot().querySelector<HTMLButtonElement>(".pr-work-offer")!;

test("FE-R3-002/TP-R4-001: Link waits through its linking render, then focus moves to the control that replaces the offer", async () => {
  const offer: PrFlowOffer = { sessionId: "s1", flow: flow("530") };
  const host = await offerHost(offer);
  const link = button("Link Flow #530 · Work 530 for #101");
  (link as HTMLElement).focus();
  await click(link);
  // The offer is still there, linking: focus stays on Link (the `offer ||` guard keeps the refocus armed).
  expect(offerLink().textContent).toBe("Linking… Flow #530 · Work 530 for #101");
  expect(document.activeElement).toBe(offerLink());
  await host.set([]);
  expect(link.isConnected).toBe(false);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Create Flow for #101");
});

test("FE-R3-002: Dismiss moves focus to the Flow slot's control that replaces the offer", async () => {
  await offerHost({ sessionId: "s1", flow: flow("530") });
  const control = button("Dismiss Flow #530 · Work 530 for #101");
  (control as HTMLElement).focus();
  await click(control);
  expect(control.isConnected).toBe(false);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Create Flow for #101");
});

test("TP-R4-001: focus moved elsewhere while Link runs stays there when the offer goes", async () => {
  const host = await offerHost({ sessionId: "s1", flow: flow("530") });
  const link = button("Link Flow #530 · Work 530 for #101");
  (link as HTMLElement).focus();
  await click(link);
  const search = document.body.querySelector<HTMLInputElement>('input[aria-label="Search pull requests"]')!;
  search.focus();
  await host.set([]);
  expect(document.activeElement).toBe(search);
});

test("FE-R4-001: a failed Link disarms the refocus, so the offer leaving later by another path moves no focus", async () => {
  const offer: PrFlowOffer = { sessionId: "s1", flow: flow("530") };
  const host = await offerHost(offer);
  const link = button("Link Flow #530 · Work 530 for #101");
  (link as HTMLElement).focus();
  await click(link);
  await host.set([{ ...offer, error: "keryx is not connected." }]);
  // A click on a non-focusable area drops focus to the page body; then the session gets a Flow elsewhere.
  (document.activeElement as HTMLElement | null)?.blur();
  await host.set([]);
  expect(document.activeElement).toBe(document.body);
});

test("TP-R3-002: a PR that already has a Flow shows that Flow, not an offer", async () => {
  await render([pr], { flows: [flow("531", { prUrl: pr.url })], sessions: [session("s1", "Work", { subject }, "2026-11-20T00:00:00Z")],
    offers: [{ sessionId: "s1", flow: flow("530") }] });
  const slot = document.body.querySelector('[aria-label="Keryx work for #101"] [data-slot="flow"]')!;
  expect(slot.textContent).toBe("Flow #531 · In progress");
  expect(slot.querySelector(".pr-work-offer")).toBeNull();
});

test("UX-010/UX-R4-001: Link carries the state: Linking… waits, and Retry link in the warn tone says why", async () => {
  const calls: Calls = { flows: [], created: [], sessions: [], linked: [], dismissed: [] };
  const bound = [session("s1", "Work", { subject }, "2026-11-20T00:00:00Z")];
  const linking: PrFlowOffer = { sessionId: "s1", flow: flow("530"), linking: true };
  await render([pr], { sessions: bound, offers: [linking], calls });
  const link = () => offerLink();
  expect(link().firstChild?.textContent).toBe("Linking…");
  expect(link().textContent).toBe("Linking… Flow #530 · Work 530 for #101");
  expect(link().getAttribute("aria-disabled")).toBe("true");
  expect(button("Dismiss Flow #530 · Work 530 for #101").getAttribute("aria-disabled")).toBe("true");
  await click(link());
  await click(button("Dismiss Flow #530 · Work 530 for #101"));
  expect([calls.linked, calls.dismissed]).toEqual([[], []]);
  // UX-R4-003: keryx's reason ends without a period; the next sentence is kept apart.
  const failed: PrFlowOffer = { sessionId: "s1", flow: flow("530"), error: "the flags of session s1 are locked by another keryx process; retry" };
  await render([pr], { sessions: bound, offers: [failed], calls });
  expect(link().firstChild?.textContent).toBe("Retry link");
  expect(link().classList.contains("is-attention")).toBe(true);
  expect(link().hasAttribute("aria-disabled")).toBe(false);
  expect(link().getAttribute("title")).toBe("Flow #530 · Work 530 was not linked: the flags of session s1 are locked by another keryx process; retry. Press Retry link to try again.");
  const description = document.getElementById(link().getAttribute("aria-describedby")!)!;
  expect(description.textContent).toBe("Flow #530 · Work 530 was not linked: the flags of session s1 are locked by another keryx process; retry.");
  await click(link());
  expect(calls.linked).toEqual([failed]);
});

test("UX-R4-004: one polite live region, there from the offer's first render, announces Linking and the failure", async () => {
  const offer: PrFlowOffer = { sessionId: "s1", flow: flow("530") };
  const host = await offerHost(offer);
  const region = flowSlot().querySelector('[aria-live="polite"]')!;
  expect(region.textContent).toBe("");
  expect(flowSlot().querySelector('[role="alert"]')).toBeNull();
  await click(button("Link Flow #530 · Work 530 for #101"));
  expect(flowSlot().querySelector('[aria-live="polite"]')).toBe(region);
  expect(region.textContent).toBe("Linking Flow #530 · Work 530…");
  await host.set([{ ...offer, error: "keryx is not connected." }]);
  expect(flowSlot().querySelector('[aria-live="polite"]')).toBe(region);
  expect(region.textContent).toBe("Flow #530 · Work 530 was not linked: keryx is not connected.");
});

test("review.css declarations for the offer: Link truncates, Dismiss keeps its icon size, aria-disabled looks disabled (geometry is not measured here)", () => {
  const css = readFileSync(new URL("../styles/review.css", import.meta.url), "utf8");
  const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*:()[\]"=]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
  // Declarations only: a happy-dom document lays nothing out, so the 60px slot itself is not checked.
  expect(rule(".pr-work-slot")).toContain("overflow: hidden");
  const box = rule(".pr-work-link, .pr-work-more");
  expect(box).toContain("white-space: nowrap");
  const link = rule(".pr-work-link");
  for (const declaration of ["flex: 1 1 auto", "min-width: 0", "overflow: hidden", "text-overflow: ellipsis"]) expect(link).toContain(declaration);
  expect(rule(".pr-work-more")).toContain("flex: none");
  expect(rule(".pr-work-more.pr-work-icon")).toContain("width: 24px");
  expect(rule('.pr-work-link:disabled, .pr-work-more:disabled, .pr-work-link[aria-disabled="true"], .pr-work-more[aria-disabled="true"]')).toContain("cursor: default");
  expect(css).toContain('.pr-work-link:hover:not(:disabled):not([aria-disabled="true"])');
  // No later rule for the offer's classes puts the text back to a non-truncating box.
  expect(css).not.toMatch(/\n\.pr-work-offer[^{]*\{/);
});

test("a new package offered for the PR's bound session: Link carries its name, Dismiss is an icon; only those act on it", async () => {
  const calls: Calls = { flows: [], created: [], sessions: [], linked: [], dismissed: [] };
  const offer: PrFlowOffer = { sessionId: "s1", flow: flow("530") };
  const bound = [session("s1", "Work", { subject }, "2026-11-20T00:00:00Z")];
  await render([pr, { ...pr, number: 102, url: pr.url.replace("101", "102") }], { sessions: bound, offers: [offer], calls });
  // TP-R4-010: Link is the slot's truncating .pr-work-link and carries the visible text; the PR number is for assistive technology.
  const link = offerLink();
  expect(link.tagName).toBe("BUTTON");
  expect(link.classList.contains("pr-work-link")).toBe(true);
  expect(link.firstChild?.textContent).toBe("Link Flow #530 · Work 530");
  expect(link.querySelector(".sr-only")?.textContent).toBe(" for #101");
  expect(link.getAttribute("title")).toBe("Flow #530 · Work 530 appeared after Create Flow. Link it to this pull request's session?");
  const dismiss = button("Dismiss Flow #530 · Work 530 for #101");
  expect(dismiss.classList.contains("pr-work-icon")).toBe(true);
  expect(dismiss.textContent).toBe("");
  expect(dismiss.querySelector("svg")).not.toBeNull();
  expect([...flowSlot().children].map(child => child.tagName)).toEqual(["BUTTON", "BUTTON", "SPAN"]);
  // Only the PR whose bound session asked gets the offer.
  expect(flowSlot(102).textContent).toBe("Create Flow");
  expect(rows().every(row => row.children.length === 3)).toBe(true);
  await click(button("Link Flow #530 · Work 530 for #101"));
  expect(calls.linked).toEqual([offer]);
  await click(dismiss);
  expect(calls.dismissed).toEqual([offer]);
  expect(calls.created).toEqual([]);
  expect(calls.flows).toEqual([]);
});

/** The work row alone, outside a board: the card's own state decides. */
function renderRow(card: ReviewCard) {
  const work = { repo: "org/repo", index: prWorkIndex([], []), onOpenFlow: () => {} };
  return act(async () => { root.render(createElement(PrWorkRow, { key: ++renderKey, card, work, onReview: () => {} })); });
}
const reviewLink = () => document.body.querySelector('[data-slot="review"] .pr-work-link')!;

test("the warn tone marks a review waiting on the viewer only on an open PR, as the tab indicator does", async () => {
  const publication = { active: false, ready: true, runState: "completed" as const, publicationPending: true as const };
  const answer = { active: true, ready: false, runState: "running" as const, awaitingAnswer: true as const };
  for (const [state, localReview, warn] of [["open", publication, true], ["merged", publication, false], ["closed", publication, false],
    ["open", answer, true], ["merged", answer, false]] as const) {
    await renderRow({ ...pr, state, localReview });
    expect({ state, warn: reviewLink().classList.contains("is-attention") }).toEqual({ state, warn });
  }
});

test("the review slot title carries the progress without the running label, and nothing for an answer without progress", async () => {
  await renderRow({ ...pr, localReview: { active: true, ready: false, runState: "running", progress: { wave: 2, planned: 4, finished: 1, completed: 1 } } });
  expect(reviewLink().getAttribute("title")).toBe("Review · running — Wave 2 · 25% · 1 of 4 assignments completed");
  await renderRow({ ...pr, localReview: { active: true, ready: false, runState: "running", awaitingAnswer: true } });
  expect(reviewLink().getAttribute("title")).toBe("Review · needs your answer");
  await renderRow({ ...pr, localReview: { active: false, ready: false, runState: "partial" } });
  expect(reviewLink().getAttribute("title")).toBe("Review · partial — Partial · Progress unavailable");
});

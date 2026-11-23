import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Root } from "react-dom/client";
import type { SessionInfo, SessionSubject } from "../acp/types";
import type { FlowCard } from "../platform/commands";
import type { fetchReviewBoard } from "../platform/review";
import type { reviewRules } from "../platform/reviewRules";
import type { ReviewWatcherSnapshot } from "../platform/reviewWatcher";
import { registerDom, unregisterDom } from "../test/dom";
import type { SubjectSessionTarget } from "./prWork";
import type { ReviewBoardSnapshot, ReviewCard } from "./types";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let useState: typeof import("react").useState;
let ReviewBoard: typeof import("./ReviewBoard").ReviewBoard;
let publishSessionReview: typeof import("../platform/reviewRuns").publishSessionReview;
let renderKey = 0;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  useState = React.useState;
  ({ ReviewBoard } = await import("./ReviewBoard"));
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

interface Calls { flows: string[]; created: number[]; sessions: Array<[number, SubjectSessionTarget, SessionSubject]> }
function render(cards: ReviewCard[], extra: { flows?: FlowCard[]; sessions?: SessionInfo[]; calls?: Calls } = {}) {
  const calls = extra.calls ?? { flows: [], created: [], sessions: [] };
  const load: typeof fetchReviewBoard = async () => board(cards);
  return act(async () => {
    root.render(createElement(ReviewBoard, {
      key: ++renderKey, cwd: "/project", flows: extra.flows ?? [], sessions: extra.sessions ?? [], load,
      listRepositories: async () => [], watcherCommand: async () => watcherOff, rulesCommand: rules,
      onOpenFlow: dir => calls.flows.push(dir),
      onCreateFlow: card => calls.created.push(card.number),
      onOpenSubjectSession: (card, target, value) => calls.sessions.push([card.number, target, value]),
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
  expect(button("Keryx review").getAttribute("aria-pressed")).toBe("true");
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

test("empty slots offer Run review, Create Flow and Open in session", async () => {
  const calls: Calls = { flows: [], created: [], sessions: [] };
  await render([pr], { calls });
  await click(button("Create Flow for #101"));
  expect(calls.created).toEqual([101]);
  await click(button("Open in session for #101"));
  expect(calls.sessions.map(([n, target]) => [n, target])).toEqual([[101, "latest"]]);
  await click(button("Run review for #101"));
  expect(button("Keryx review").getAttribute("aria-pressed")).toBe("true");
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

test("the session header's PR focus opens the panel only on the board of its repository, and a remount does not replay it", async () => {
  let handled: number[] = [];
  const load: typeof fetchReviewBoard = async () => board([pr]);
  type Focus = { repo: string; number: number; nonce: number } | null;
  let setFocus!: (focus: Focus) => void;
  function Host({ boardKey, initial }: { boardKey: number; initial: Focus }) {
    const [focus, set] = useState<Focus>(initial);
    setFocus = set;
    return createElement(ReviewBoard, {
      key: boardKey, cwd: "/project", flows: [], sessions: [], load, listRepositories: async () => [],
      watcherCommand: async () => watcherOff, rulesCommand: rules, onOpenFlow: () => {}, focus,
      onFocusHandled: (nonce: number) => { handled.push(nonce); set(old => old?.nonce === nonce ? null : old); },
    });
  }
  const panel = () => document.body.querySelector(".review-detail-panel");
  await act(async () => { root.render(createElement(Host, { key: ++renderKey, boardKey: 1, initial: { repo: "other/repo", number: 101, nonce: 1 } })); });
  expect(panel()).toBeNull();
  expect(handled).toEqual([]);
  await act(async () => setFocus({ repo: "Org/Repo", number: 101, nonce: 2 }));
  expect(panel()).not.toBeNull();
  expect(handled).toEqual([2]);
  await click(button("Close details"));
  handled = [];
  // The board remounts (a repository or account switch): the handled request is gone and nothing reopens.
  await act(async () => { root.render(createElement(Host, { key: renderKey, boardKey: 2, initial: null })); });
  expect(panel()).toBeNull();
  expect(handled).toEqual([]);
});
